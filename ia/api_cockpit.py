#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
api_cockpit.py — API REST do Cockpit Financeiro Grupo REF (v1).
Implementa EXATAMENTE o contrato de cockpit-app/API_CONTRACT.md:
  - registro de empresas (slug ↔ codigo dim_empresa ↔ cor);
  - auth + RBAC por usuário (Iteração 3): cookie httpOnly `ck_session` v2
    (`v2.<username>.<exp>.<hmac>`, 12h) assinado com secret derivado de
    COCKPIT_PASSWORD — sem senha definida a API fica FECHADA (503);
    master = usuario `admin` + COCKPIT_PASSWORD (todas as empresas);
    demais usuários na tabela cockpit_user (scrypt, escopo CSV de slugs|'todas');
    enforcement SERVER-SIDE: slug fora do escopo → 403; `grupo` só p/ 'todas';
    COCKPIT_DEV_OPEN=1 desativa a auth (somente dev local) e
    COCKPIT_DEV_USER=<username> simula o escopo desse usuário;
  - endpoints /api/* (kpis, dre, historico, fees, receita-var, folha, alertas);
  - regras de alerta A01–A10 (briefing §4) com snooze em cockpit_alert_snooze.
Todos os valores vêm do PostgreSQL cockpit_ref (NUNCA hardcoded — spec §6).
Dinheiro: 2 casas. Percentuais: fração*100 com 1–2 casas.
LGPD: folha NUNCA expõe salário exato — apenas faixa (banda) salarial.
"""
import os, re, hmac, time, hashlib, pathlib, datetime
from contextlib import contextmanager

import psycopg2
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

# --- .env da raiz do repo (mesmo padrão de ia/context_builder.py) -------------
ROOT = pathlib.Path(__file__).resolve().parent.parent
_envp = ROOT / ".env"
if _envp.exists():
    for line in _envp.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

DB = dict(host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", "5432")),
          dbname=os.environ.get("DB_NAME", "cockpit_ref"), user=os.environ.get("DB_USER", "cockpit_user"),
          password=os.environ.get("DB_PASSWORD"))   # nunca hardcoded — vem do .env (§8)

# --- Registro de empresas (API_CONTRACT.md — tabela slug ↔ code ↔ label ↔ cor)
EMPRESAS = [
    {"slug": "ref-plus",   "code": "REF", "label": "REF+",           "color": "#D9DA00"},
    {"slug": "black-door", "code": "BD",  "label": "Black Door",     "color": "#22C55E"},
    {"slug": "4in",        "code": "4PR", "label": "4In",            "color": "#F97316"},
    {"slug": "viv",        "code": "VIV", "label": "Viv Experience", "color": "#A855F7"},
    {"slug": "zuptech",    "code": "ZUP", "label": "Zuptech",        "color": "#3B82F6"},
]
BY_SLUG = {e["slug"]: e for e in EMPRESAS}
BY_CODE = {e["code"]: e for e in EMPRESAS}
GRUPO = {"slug": "grupo", "code": None, "label": "Grupo REF", "color": "#D9DA00"}

# Linhas-chave da DRE (dim_conta.descricao) — contrato §"Contas DRE usadas"
RB, RL, RA, EBIT, RLIQ = ("RECEITA BRUTA", "RECEITA OPERACIONAL LIQUIDA",
                          "RESULTADO OPERACIONAL DA AGENCIA",
                          "RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)", "RESULTADO LIQUIDO")
# Linhas de custo/despesa da DRE detalhada (Iteração 2) — valores gravados POSITIVOS
CUSTOS, PESSOAL, INFRA, OUTRAS, ADM, TRIB = (
    "CUSTOS DOS SERVICOS", "GASTOS COM PESSOAL", "INFRAESTRUTURA",
    "OUTRAS DESPESAS", "DESPESAS ADMINISTRATIVAS", "TRIBUTOS FEDERAIS")
CAIXA = "GERACAO DE CAIXA"                               # já vem ACUMULADA na planilha
# RESOLVIDO (verificado na DRE-Base do cliente): "DESPESAS ADM." é um ITEM DE DETALHE
# do bloco de despesas (junto de Consultorias/TI/ERP/Viagens/Bancárias), já contido
# nos totais — a cadeia RA − pessoal − infra − outras = EBIT fecha EXATA sem ele.
# Por isso ADM fica FORA do ranking/composição (evita dupla contagem).
CONTAS_DESPESA = [PESSOAL, INFRA, OUTRAS]               # ranking de /api/despesas
CONTAS_MENSAIS = [RB, RL, RA, EBIT, RLIQ, CUSTOS] + CONTAS_DESPESA + [ADM, TRIB, CAIXA]

META_EBIT_PCT = float(os.environ.get("COCKPIT_META_EBIT", "8"))   # A09 — meta default 8%

router = APIRouter(prefix="/api")


# =============================================================================
# Infra de banco
# =============================================================================
@contextmanager
def _conn():
    con = psycopg2.connect(connect_timeout=6, **DB)
    try:
        yield con
        con.commit()
    finally:
        con.close()


_TABLES_ENSURED = False

# Novas tabelas do contrato §"Novas tabelas" — CREATE IF NOT EXISTS lazy: a API
# funciona (estruturas vazias) mesmo se o módulo de ingestão ainda não rodou.
_DDL = """
CREATE TABLE IF NOT EXISTS fato_folha_mensal (
    id           SERIAL PRIMARY KEY,
    empresa_id   INT NOT NULL REFERENCES dim_empresa(id),
    periodo_id   INT NOT NULL REFERENCES dim_periodo(id),
    nome         VARCHAR(160),
    departamento VARCHAR(120),
    cargo        VARCHAR(120),
    tipo         VARCHAR(40),
    salario      NUMERIC(14,2),
    extra        NUMERIC(14,2),
    total        NUMERIC(14,2),
    UNIQUE (empresa_id, periodo_id, nome, departamento, cargo)
);
CREATE TABLE IF NOT EXISTS fato_fee_cliente (
    id         SERIAL PRIMARY KEY,
    empresa_id INT NOT NULL REFERENCES dim_empresa(id),
    cliente    VARCHAR(160) NOT NULL,
    fee_mensal NUMERIC(14,2),
    ano        INT NOT NULL,
    UNIQUE (empresa_id, cliente, ano)
);
CREATE TABLE IF NOT EXISTS cockpit_alert_snooze (
    alert_id VARCHAR(40) PRIMARY KEY,
    ate      DATE NOT NULL
);
CREATE TABLE IF NOT EXISTS cockpit_user (
    id         SERIAL PRIMARY KEY,
    username   VARCHAR(80)  NOT NULL UNIQUE,
    senha_hash VARCHAR(200) NOT NULL,          -- scrypt: hex(salt)$hex(hash)
    empresas   VARCHAR(200) NOT NULL,          -- CSV de slugs OU 'todas'
    ativo      BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Iteração 4: super-admin (flag independente do escopo). Migração idempotente
-- p/ DBs já existentes — ADD COLUMN IF NOT EXISTS não falha se já houver a coluna.
ALTER TABLE cockpit_user ADD COLUMN IF NOT EXISTS admin BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS fato_dre_tri_hist (
    id         SERIAL PRIMARY KEY,
    empresa_id INT NOT NULL REFERENCES dim_empresa(id),
    ano        INT NOT NULL,
    tri        INT NOT NULL,
    metrica    VARCHAR(60) NOT NULL,
    valor      NUMERIC(16,2),
    UNIQUE (empresa_id, ano, tri, metrica)
);
"""


def _ensure_tables(cur):
    global _TABLES_ENSURED
    if not _TABLES_ENSURED:
        cur.execute(_DDL)
        _TABLES_ENSURED = True


def _rows(cur, sql, params=None):
    cur.execute(sql, params or [])
    return cur.fetchall()


def _money(v):
    return round(float(v), 2) if v is not None else None


def _pct(num, den, nd=1):
    """Percentual = fração*100 com 1–2 casas. None se denominador inválido."""
    if num is None or den in (None, 0):
        return None
    return round(float(num) / float(den) * 100.0, nd)


# =============================================================================
# Autenticação + RBAC — cookie httpOnly `ck_session` v2 assinado com HMAC (12h)
# Contrato §"Autenticação + RBAC por usuário (Iteração 3)".
# =============================================================================
SESSION_TTL = 12 * 3600
COOKIE = "ck_session"
# Parâmetros do scrypt (hash de senha da tabela cockpit_user) — mesmos do CLI
# ia/cockpit_users.py. Formato armazenado: hex(salt)$hex(hash).
_SCRYPT = dict(n=2 ** 14, r=8, p=1)


def _password():
    return os.environ.get("COCKPIT_PASSWORD", "").strip()


def _dev_open():
    return os.environ.get("COCKPIT_DEV_OPEN", "") == "1"


def _secret():
    # segredo derivado da senha master (não guarda a senha em claro no token)
    return hashlib.sha256(("ck-session-v1:" + _password()).encode("utf-8")).digest()


def _hash_senha(senha, salt=None):
    """Hash scrypt da senha → 'hex(salt)$hex(hash)' (formato da cockpit_user)."""
    salt = salt if salt is not None else os.urandom(16)
    h = hashlib.scrypt(senha.encode("utf-8"), salt=salt, **_SCRYPT)
    return salt.hex() + "$" + h.hex()


def _senha_confere(senha, armazenado):
    """Verifica senha contra o hash armazenado (comparação em tempo constante)."""
    try:
        salt_hex, _hash_hex = armazenado.split("$", 1)
        calc = _hash_senha(senha, bytes.fromhex(salt_hex))
        return hmac.compare_digest(calc, armazenado)
    except Exception:
        return False


def _make_token(usuario):
    """Token v2: `v2.<username>.<exp>.<hmac(username.exp)>`."""
    exp = str(int(time.time()) + SESSION_TTL)
    sig = hmac.new(_secret(), f"{usuario}.{exp}".encode("utf-8"), hashlib.sha256).hexdigest()
    return f"v2.{usuario}.{exp}.{sig}"


def _token_usuario(token):
    """username do token v2 se válido; None caso contrário.
    Tokens no formato ANTIGO (`<exp>.<sig>`, sem prefixo v2) são rejeitados → re-login."""
    try:
        if not token.startswith("v2."):
            return None
        # rsplit: exp/sig não contêm '.', então usernames com '.' continuam válidos
        usuario, exp, sig = token[3:].rsplit(".", 2)
        good = hmac.new(_secret(), f"{usuario}.{exp}".encode("utf-8"), hashlib.sha256).hexdigest()
        if usuario and hmac.compare_digest(sig, good) and int(exp) > time.time():
            return usuario
    except Exception:
        pass
    return None


def _escopo(usuario, empresas_csv, admin=False):
    """Monta o dict de sessão a partir do campo `empresas` da cockpit_user.
    `admin` (Iteração 4) = flag super-admin, independente do escopo de empresas."""
    if (empresas_csv or "").strip().lower() == "todas":
        return {"usuario": usuario, "empresas": None, "todas": True, "admin": bool(admin)}
    slugs = {s.strip() for s in (empresas_csv or "").split(",") if s.strip() in BY_SLUG}
    return {"usuario": usuario, "empresas": slugs, "todas": False, "admin": bool(admin)}


# master `admin` (COCKPIT_PASSWORD) — sempre super-admin + todas as empresas
_MASTER = lambda u: {"usuario": u, "empresas": None, "todas": True, "admin": True}  # noqa: E731

# Hash descartável p/ equalizar o CUSTO do login quando o usuário NÃO existe
# (anti-enumeração por timing: caminho de erro roda scrypt igual ao de acerto).
_DUMMY_HASH = None


def _dummy_hash():
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = _hash_senha("equalizador-de-timing-nao-e-senha")
    return _DUMMY_HASH


def _cookie_secure():
    # Secure por default (produção é HTTPS); COCKPIT_COOKIE_SECURE=0 só p/ dev http
    return os.environ.get("COCKPIT_COOKIE_SECURE", "1") != "0"


def _carrega_usuario(usuario):
    """Escopo do usuário ATIVO na cockpit_user (consultado a cada request para
    que `disable`/mudança de escopo valham imediatamente). None se não existe."""
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        cur.execute("SELECT empresas, admin FROM cockpit_user WHERE username=%s AND ativo",
                    [usuario])
        r = cur.fetchone()
    return _escopo(usuario, r[0], r[1]) if r else None


def require_session(request: Request):
    """Dependência de TODOS os /api/* exceto /api/login e /api/health.
    Retorna {usuario, empresas: set(slugs) | None p/ todas, todas: bool}."""
    if _dev_open():
        dev_user = os.environ.get("COCKPIT_DEV_USER", "").strip()
        if dev_user:                       # simula o escopo do usuário da tabela
            u = _carrega_usuario(dev_user)
            if not u:                      # fail-closed: typo NÃO escala p/ master
                raise HTTPException(status_code=403,
                                    detail=f"COCKPIT_DEV_USER '{dev_user}' inexistente/inativo")
            return u
        return _MASTER("dev")              # sem DEV_USER: master (todas)
    if not _password():
        raise HTTPException(status_code=503, detail="COCKPIT_PASSWORD não configurada — API fechada")
    usuario = _token_usuario(request.cookies.get(COOKIE, ""))
    if not usuario:
        raise HTTPException(status_code=401, detail="sessão ausente ou expirada")
    if usuario == "admin":                 # master: todas as empresas
        return _MASTER("admin")
    u = _carrega_usuario(usuario)
    if not u:                              # desativado/removido após o login
        raise HTTPException(status_code=401, detail="usuário inativo — refaça o login")
    return u


def _autoriza(slug, user):
    """403 se o slug está fora do escopo do usuário. `grupo` (consolidado revela
    as outras empresas) exige escopo 'todas'. Contrato §RBAC."""
    if user["todas"]:
        return
    if slug == "grupo" or slug not in user["empresas"]:
        raise HTTPException(status_code=403, detail=f"acesso negado à empresa: {slug}")


def _empresas_do_usuario(user):
    """Sub-lista de EMPRESAS visível ao usuário (ordem canônica preservada)."""
    if user["todas"]:
        return EMPRESAS
    return [e for e in EMPRESAS if e["slug"] in user["empresas"]]


class LoginBody(BaseModel):
    senha: str
    usuario: str = "admin"    # opcional — default mantém compat com o front antigo


@router.post("/login", status_code=204)
def login(body: LoginBody):
    # minúsculo: usuários são criados/armazenados em lowercase (CLI + admin web);
    # varchar do Postgres é case-sensitive → sem isto 'Maria' logaria 401.
    usuario = (body.usuario or "admin").strip().lower() or "admin"
    if _dev_open():                       # dev local: aceita qualquer credencial
        resp = Response(status_code=204)  # cookie no MESMO Response retornado
        resp.set_cookie(COOKIE, _make_token(usuario), max_age=SESSION_TTL,
                        httponly=True, samesite="lax", path="/", secure=_cookie_secure())
        return resp
    if not _password():
        raise HTTPException(status_code=503, detail="COCKPIT_PASSWORD não configurada — API fechada")
    if usuario == "admin":                # master: admin + COCKPIT_PASSWORD → todas
        ok = hmac.compare_digest(body.senha, _password())
    else:                                 # demais: usuário ATIVO da cockpit_user
        with _conn() as con:
            cur = con.cursor()
            _ensure_tables(cur)
            cur.execute("SELECT senha_hash FROM cockpit_user WHERE username=%s AND ativo",
                        [usuario])
            r = cur.fetchone()
        if r:
            ok = _senha_confere(body.senha, r[0])
        else:
            _senha_confere(body.senha, _dummy_hash())   # equaliza timing (anti-enumeração)
            ok = False
    if not ok:
        time.sleep(0.4)                   # freio anti força-bruta
        raise HTTPException(status_code=401, detail="usuário ou senha inválidos")
    resp = Response(status_code=204)
    resp.set_cookie(COOKIE, _make_token(usuario), max_age=SESSION_TTL,
                    httponly=True, samesite="lax", path="/", secure=_cookie_secure())
    return resp


@router.get("/session")
def session(user=Depends(require_session)):
    return {"ok": True, "usuario": user["usuario"],
            "empresas": "todas" if user["todas"] else sorted(user["empresas"]),
            "admin": bool(user.get("admin"))}


def require_admin(user=Depends(require_session)):
    """Dependência das rotas /api/admin/* — exige sessão com flag super-admin.
    Super-admin = master `admin` (sempre) OU usuário da tabela com admin=true."""
    if not user.get("admin"):
        raise HTTPException(status_code=403, detail="acesso restrito a super-admin")
    return user


@router.get("/health")
def health():
    try:
        with _conn() as con:
            cur = con.cursor()
            cur.execute("SELECT 1")
            db_ok = cur.fetchone()[0] == 1
    except Exception:
        db_ok = False
    return {"status": "ok", "db": db_ok}


# =============================================================================
# Super-admin — gestão de usuários pela web (Iteração 4)
# Contrato §"Super-admin — gestão de usuários pela web". require_admin = sessão
# válida + flag super-admin; o master `admin` é reservado (fora da tabela).
# =============================================================================
# mesmo regex do CLI ia/cockpit_users.py (2–80 chars, minúsculo, começa com [a-z0-9])
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")


def _normaliza_empresas_out(empresas_csv):
    """Escopo armazenado -> forma de resposta: 'todas' OU lista ordenada de slugs válidos."""
    if (empresas_csv or "").strip().lower() == "todas":
        return "todas"
    return sorted({s.strip() for s in (empresas_csv or "").split(",") if s.strip() in BY_SLUG})


def _valida_empresas_in(empresas):
    """Valida o escopo recebido do front (str 'todas'/csv OU lista de slugs).
    Retorna o CSV a gravar ('todas' ou slugs em ordem canônica). HTTP 400 se inválido."""
    if isinstance(empresas, str):
        if empresas.strip().lower() == "todas":
            return "todas"
        itens = [s.strip() for s in empresas.split(",")]
    elif isinstance(empresas, list):
        if len(empresas) == 1 and str(empresas[0]).strip().lower() == "todas":
            return "todas"
        itens = [str(s).strip() for s in empresas]
    else:
        raise HTTPException(status_code=400, detail="empresas deve ser 'todas', lista ou CSV de slugs")
    slugs = [s for s in itens if s]
    if not slugs or any(s not in BY_SLUG for s in slugs):
        raise HTTPException(status_code=400,
                            detail="empresas inválidas — use 'todas' ou slugs válidos: "
                                   + ", ".join(BY_SLUG))
    # ordem canônica das EMPRESAS, sem duplicatas
    return ",".join(e["slug"] for e in EMPRESAS if e["slug"] in set(slugs))


def _valida_username_in(username):
    """Normaliza (minúsculo) e valida o username; rejeita o reservado 'admin'. HTTP 400."""
    u = (username or "").strip().lower()
    if not _USERNAME_RE.fullmatch(u):
        raise HTTPException(status_code=400,
                            detail="username inválido — 2 a 80 chars [a-z 0-9 . _ -], "
                                   "começando com letra/dígito")
    if u == "admin":
        raise HTTPException(status_code=400,
                            detail="'admin' é o master (COCKPIT_PASSWORD) — reservado, não vive na tabela")
    return u


class AdminUserCreate(BaseModel):
    username: str
    empresas: object = "todas"     # str 'todas'/csv OU lista de slugs
    senha: str
    admin: bool = False


class AdminUserPatch(BaseModel):
    empresas: object | None = None
    ativo: bool | None = None
    admin: bool | None = None
    senha: str | None = None


@router.get("/admin/users")
def admin_users_list(user=Depends(require_admin)):
    """Lista usuários da cockpit_user (NUNCA devolve hash; master `admin` é externo à tabela)."""
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        cur.execute("""SELECT username, empresas, ativo, admin, criado_em
                       FROM cockpit_user ORDER BY username""")
        rows = cur.fetchall()
    return [{"username": u, "empresas": _normaliza_empresas_out(emp),
             "ativo": bool(ativo), "admin": bool(adm),
             "criado_em": criado.isoformat() if criado else None}
            for u, emp, ativo, adm, criado in rows]


@router.post("/admin/users", status_code=201)
def admin_users_create(body: AdminUserCreate, user=Depends(require_admin)):
    usuario = _valida_username_in(body.username)          # 400 se inválido/reservado
    empresas = _valida_empresas_in(body.empresas)         # 400 se escopo inválido
    if not body.senha or len(body.senha) < 8:
        raise HTTPException(status_code=400, detail="senha deve ter ao menos 8 caracteres")
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        cur.execute("SELECT 1 FROM cockpit_user WHERE username=%s", [usuario])
        if cur.fetchone():
            raise HTTPException(status_code=409, detail=f"usuário '{usuario}' já existe")
        cur.execute("""INSERT INTO cockpit_user (username, senha_hash, empresas, admin)
                       VALUES (%s, %s, %s, %s)""",
                    [usuario, _hash_senha(body.senha), empresas, bool(body.admin)])
    return {"ok": True}


@router.patch("/admin/users/{username}")
def admin_users_patch(username: str, body: AdminUserPatch, user=Depends(require_admin)):
    alvo = (username or "").strip().lower()
    if alvo == "admin":
        raise HTTPException(status_code=400,
                            detail="'admin' é o master (COCKPIT_PASSWORD) — reservado, não é alvo de edição")
    sets, params = [], []
    if body.empresas is not None:
        sets.append("empresas=%s")
        params.append(_valida_empresas_in(body.empresas))
    if body.senha is not None:
        if len(body.senha) < 8:
            raise HTTPException(status_code=400, detail="senha deve ter ao menos 8 caracteres")
        sets.append("senha_hash=%s")
        params.append(_hash_senha(body.senha))
    if body.ativo is not None:
        # anti-lockout: o super-admin autenticado não pode desativar a si mesmo
        if body.ativo is False and alvo == user["usuario"]:
            raise HTTPException(status_code=409, detail="não é possível desativar o próprio usuário")
        sets.append("ativo=%s")
        params.append(bool(body.ativo))
    if body.admin is not None:
        # anti-lockout: o super-admin autenticado não pode remover o próprio admin
        if body.admin is False and alvo == user["usuario"]:
            raise HTTPException(status_code=409,
                                detail="não é possível remover o próprio acesso de admin")
        sets.append("admin=%s")
        params.append(bool(body.admin))
    if not sets:
        raise HTTPException(status_code=400, detail="nada para atualizar — informe ao menos um campo")
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        cur.execute(f"UPDATE cockpit_user SET {', '.join(sets)} WHERE username=%s",
                    params + [alvo])
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"usuário '{alvo}' não encontrado")
    return {"ok": True}


# =============================================================================
# Helpers de consulta (DRE)
# =============================================================================
def _slug_or_404(slug, allow_grupo=True):
    if allow_grupo and slug == "grupo":
        return GRUPO
    if slug not in BY_SLUG:
        raise HTTPException(status_code=404, detail=f"empresa desconhecida: {slug}")
    return BY_SLUG[slug]


def _emp_where(emp):
    """(fragmento SQL, params) do filtro de empresa; grupo = soma das 5 (sem filtro)."""
    if emp["code"] is None:
        return "", []
    return " AND e.codigo=%s", [emp["code"]]


def _ano_default(cur):
    cur.execute("""SELECT MAX(p.ano) FROM fato_dre_mensal f
                   JOIN dim_periodo p ON p.id=f.periodo_id""")
    r = cur.fetchone()
    return int(r[0]) if r and r[0] else datetime.date.today().year


def _dre_ano(cur, emp, ano, ate=None):
    """dict descricao -> soma no ano (empresa ou grupo). `ate` = só meses <= ate."""
    ef, ep = _emp_where(emp)
    mf, mp = ("", []) if ate is None else (" AND p.mes<=%s", [ate])
    cur.execute(f"""SELECT c.descricao, SUM(f.valor)
        FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
        JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
        WHERE p.ano=%s{mf}{ef} GROUP BY c.descricao""", [ano] + mp + ep)
    return {d: float(v) for d, v in cur.fetchall() if v is not None}


def _dre_mensal(cur, emp, ano):
    """dict mes -> {descricao: valor} (linhas-chave + custos/despesas da Iteração 2)."""
    ef, ep = _emp_where(emp)
    cur.execute(f"""SELECT p.mes, c.descricao, SUM(f.valor)
        FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
        JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
        WHERE p.ano=%s AND c.descricao = ANY(%s){ef}
        GROUP BY p.mes, c.descricao""", [ano, CONTAS_MENSAIS] + ep)
    out = {}
    for mes, d, v in cur.fetchall():
        if v is not None:
            out.setdefault(int(mes), {})[d] = float(v)
    return out


def _realizado_ate(ano):
    """Último mês REALIZADO do ano (Iteração 2): ano passado→12, corrente→mês-1, futuro→0."""
    hoje = datetime.date.today()
    if ano < hoje.year:
        return 12
    if ano > hoje.year:
        return 0
    return hoje.month - 1


def _folha_periodo_default(cur, ano):
    """Mês default = mais recente com folha carregada (no ano; senão DRE).
    As planilhas trazem folha PROJETADA até dez; para o ano corrente, limita o
    default ao último mês REALIZADO (mês-calendário anterior — mesma convenção
    de realizado_ate), com fallback para o mês corrente se ainda não houver dado."""
    import datetime as _dt
    hoje = _dt.date.today()
    cap = max(hoje.month - 1, 1) if ano == hoje.year else 12
    cur.execute("""SELECT MAX(p.mes) FROM fato_folha_mensal f
                   JOIN dim_periodo p ON p.id=f.periodo_id WHERE p.ano=%s AND p.mes<=%s""",
                [ano, cap])
    r = cur.fetchone()
    if r and r[0]:
        return int(r[0])
    cur.execute("""SELECT MAX(p.mes) FROM fato_dre_mensal f
                   JOIN dim_periodo p ON p.id=f.periodo_id WHERE p.ano=%s""", [ano])
    r = cur.fetchone()
    return int(r[0]) if r and r[0] else 12


def _folha_mes_total(cur, emp, ano, mes):
    """(total, headcount) da folha da empresa/grupo em ano/mes."""
    ef, ep = _emp_where(emp)
    cur.execute(f"""SELECT COALESCE(SUM(f.total),0), COUNT(*)
        FROM fato_folha_mensal f JOIN dim_empresa e ON e.id=f.empresa_id
        JOIN dim_periodo p ON p.id=f.periodo_id
        WHERE p.ano=%s AND p.mes=%s{ef}""", [ano, mes] + ep)
    t, h = cur.fetchone()
    return float(t or 0), int(h or 0)


# =============================================================================
# Endpoints de dados
# =============================================================================
@router.get("/empresas")
def empresas(user=Depends(require_session)):
    return _empresas_do_usuario(user)      # RBAC: só as empresas permitidas


@router.get("/kpis/grupo")
def kpis_grupo(ano: int | None = None, user=Depends(require_session)):
    _autoriza("grupo", user)               # consolidado exige escopo 'todas'
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        ano = ano or _ano_default(cur)
        dre = _dre_ano(cur, GRUPO, ano)
        prev = _dre_ano(cur, GRUPO, ano - 1)

        # folha_mes/headcount = mês mais recente com folha carregada (contrato)
        mes = _folha_periodo_default(cur, ano)
        folha_total, headcount = _folha_mes_total(cur, GRUPO, ano, mes)

        # mix de receita por empresa (donut da tela Macro)
        cur.execute("""SELECT e.codigo, SUM(f.valor)
            FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
            JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
            WHERE p.ano=%s AND c.descricao=%s GROUP BY e.codigo""", [ano, RB])
        por_emp = {code: float(v or 0) for code, v in cur.fetchall()}
        total_rb = sum(por_emp.values()) or None
        mix = [{"slug": e["slug"], "label": e["label"], "color": e["color"],
                "receita": _money(por_emp.get(e["code"], 0)),
                "pct": _pct(por_emp.get(e["code"], 0), total_rb) or 0.0}
               for e in EMPRESAS]

        return {"ano": ano,
                "realizado_ate": _realizado_ate(ano),
                "receita_bruta": _money(dre.get(RB)),
                "receita_liquida": _money(dre.get(RL)),
                "folha_mes": _money(folha_total),
                "headcount": headcount,
                "resultado_liquido": _money(dre.get(RLIQ)),
                "prev": {"ano": ano - 1,
                         "receita_bruta": _money(prev.get(RB)),
                         "resultado_liquido": _money(prev.get(RLIQ))},
                "mix": mix}


@router.get("/kpis/{slug}")
def kpis_empresa(slug: str, ano: int | None = None, user=Depends(require_session)):
    emp = _slug_or_404(slug, allow_grupo=False)
    _autoriza(slug, user)
    with _conn() as con:
        cur = con.cursor()
        ano = ano or _ano_default(cur)
        dre = _dre_ano(cur, emp, ano)
        prev = _dre_ano(cur, emp, ano - 1)
        return {"ano": ano,
                "realizado_ate": _realizado_ate(ano),
                "receita_bruta": _money(dre.get(RB)),
                "receita_liquida": _money(dre.get(RL)),
                "resultado_agencia": _money(dre.get(RA)),
                "ebit_pct": _pct(dre.get(EBIT), dre.get(RB)),   # EBIT / RECEITA BRUTA
                "resultado_liquido": _money(dre.get(RLIQ)),
                "prev": {"ano": ano - 1,
                         "receita_bruta": _money(prev.get(RB)),
                         "resultado_liquido": _money(prev.get(RLIQ))}}


@router.get("/dre/mensal/{slug}")
def dre_mensal(slug: str, ano: int | None = None, user=Depends(require_session)):
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    with _conn() as con:
        cur = con.cursor()
        ano = ano or _ano_default(cur)
        pm = _dre_mensal(cur, emp, ano)
        meses, caixa_cum = [], 0.0
        for m in range(1, 13):                               # sempre 12 itens
            d = pm.get(m, {})
            caixa_cum += d.get(RLIQ) or 0.0
            # conta GERACAO DE CAIXA da planilha (já acumulada — bate com a referência
            # do cliente); fallback: acumulado do resultado líquido se a linha faltar
            caixa = d.get(CAIXA) if d.get(CAIXA) is not None else caixa_cum
            meses.append({"mes": m,
                          "receita_bruta": _money(d.get(RB)),
                          "receita_liquida": _money(d.get(RL)),
                          "resultado_agencia": _money(d.get(RA)),
                          "resultado_liquido": _money(d.get(RLIQ)),
                          "ebit": _money(d.get(EBIT)),
                          "custos_diretos": _money(d.get(CUSTOS)),
                          "pessoal": _money(d.get(PESSOAL)),
                          "infra": _money(d.get(INFRA)),
                          "outras": _money(d.get(OUTRAS)),
                          "administrativas": _money(d.get(ADM)),
                          "tributos": _money(d.get(TRIB)),
                          "caixa_acum": round(caixa, 2)})
        return {"ano": ano, "realizado_ate": _realizado_ate(ano), "meses": meses}


@router.get("/dre/trimestral/{slug}")
def dre_trimestral(slug: str, ano: int | None = None, user=Depends(require_session)):
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    with _conn() as con:
        cur = con.cursor()
        ano = ano or _ano_default(cur)
        pm = _dre_mensal(cur, emp, ano)

        def _agg(meses):
            acc = {}
            for m in meses:
                for d, v in pm.get(m, {}).items():
                    acc[d] = acc.get(d, 0.0) + v
            return acc

        tris = []
        for t in range(1, 5):
            a = _agg(range((t - 1) * 3 + 1, (t - 1) * 3 + 4))
            tris.append({"tri": t,
                         "receita_bruta": _money(a.get(RB)),
                         "ebit_negocio_pct": _pct(a.get(EBIT), a.get(RB)),
                         # definição da PLANILHA do cliente: % EBIT AGÊNCIA = EBIT / RESULTADO AGÊNCIA
                         "ebit_agencia_pct": _pct(a.get(EBIT), a.get(RA)),
                         "resultado_liquido": _money(a.get(RLIQ))})
        tot = _agg(range(1, 13))
        total = {"receita_bruta": _money(tot.get(RB)),
                 "ebit_negocio_pct": _pct(tot.get(EBIT), tot.get(RB)),
                 "ebit_agencia_pct": _pct(tot.get(EBIT), tot.get(RA)),
                 "resultado_liquido": _money(tot.get(RLIQ))}

        # hist[] (Iteração 2): anos anteriores da fato_dre_tri_hist (exclui o ano pedido)
        _ensure_tables(cur)
        ef, ep = _emp_where(emp)
        cur.execute(f"""SELECT h.ano, h.tri, h.metrica, SUM(h.valor)
            FROM fato_dre_tri_hist h JOIN dim_empresa e ON e.id=h.empresa_id
            WHERE h.ano <> %s{ef} GROUP BY h.ano, h.tri, h.metrica
            ORDER BY h.ano, h.tri""", [ano] + ep)
        acc = {}
        for a, t, met, v in cur.fetchall():
            if v is not None:
                acc.setdefault(int(a), {}).setdefault(int(t), {})[met] = float(v)
        hist = []
        for a in sorted(acc):
            tris_h = []
            for t in range(1, 5):
                d = acc[a].get(t, {})
                if emp["code"] is None:
                    # grupo: percentuais NÃO se somam — deriva das somas (definição da planilha:
                    # EBIT/RECEITA BRUTA e EBIT/RESULTADO OP. DA AGENCIA)
                    neg = _pct(d.get("EBIT"), d.get("RECEITA_BRUTA"))
                    ag = _pct(d.get("EBIT"), d.get("RESULTADO_AGENCIA"))
                else:
                    neg, ag = d.get("EBIT_NEG_PCT"), d.get("EBIT_AG_PCT")
                tris_h.append({"tri": t,
                               "receita_bruta": _money(d.get("RECEITA_BRUTA")),
                               "ebit_negocio_pct": neg,
                               "ebit_agencia_pct": ag,
                               "resultado_liquido": _money(d.get("RESULTADO_LIQUIDO")),
                               "resultado_agencia": _money(d.get("RESULTADO_AGENCIA"))})
            hist.append({"ano": a, "tris": tris_h})
        return {"ano": ano, "tris": tris, "total": total, "hist": hist}


@router.get("/cascata/{slug}")
def cascata(slug: str, ano: int | None = None, ate: int | None = None,
            user=Depends(require_session)):
    """Cascata (waterfall) da DRE — Iteração 2. `ate` = só meses <= ate (semestre realizado).
    Convenção de sinais: custos/despesas gravados POSITIVOS no banco -> deltas NEGATIVOS."""
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    if ate is not None and not 1 <= ate <= 12:
        raise HTTPException(status_code=422, detail="ate deve estar entre 1 e 12")
    with _conn() as con:
        cur = con.cursor()
        ano = ano or _ano_default(cur)
        dre = _dre_ano(cur, emp, ano, ate)
        rb, rl = dre.get(RB, 0.0), dre.get(RL, 0.0)

        def tot(label, v):
            return {"label": label, "valor": _money(v or 0.0), "tipo": "total"}

        def neg(label, v):
            return {"label": label, "valor": _money(-(v or 0.0)), "tipo": "delta"}

        # Deltas derivados como RESÍDUOS entre os anchors do banco — a cascata
        # SEMPRE reconcilia (RB + Σdeltas = Resultado Líquido), mesmo com planilhas
        # parciais (ex.: Zup com #REF!) ou contas fora da cadeia (ADM em BD/4PR/VIV,
        # onde RA − pessoal − infra − outras = EBIT exato, sem a linha ADM).
        ra   = dre.get(RA)   or 0.0
        ebit = dre.get(EBIT) or 0.0
        rliq = dre.get(RLIQ) or 0.0
        pessoal = dre.get(PESSOAL) or 0.0
        infra   = dre.get(INFRA)   or 0.0
        outras_resid = (ra - ebit) - pessoal - infra   # absorve OUTRAS + ADM + lacunas
        passos = [
            tot("Receita Bruta", rb),
            neg("Deduções e Impostos", rb - rl),           # resíduo RB → Receita Líquida
            tot("Receita Líquida", rl),
            neg("Custos Diretos", rl - ra),                # resíduo RL → Resultado Agência
            tot("Resultado da Agência", ra),
            neg("Gastos com Pessoal", pessoal),
            neg("Infraestrutura", infra),
            neg("Outras despesas (incl. adm.)", outras_resid),
            tot("EBIT", ebit),
            neg("Tributos Federais", ebit - rliq),         # resíduo EBIT → Resultado Líquido
            tot("Resultado Líquido", rliq),
        ]
        return {"ano": ano, "ate": ate, "passos": passos}


@router.get("/despesas/{slug}")
def despesas(slug: str, ano: int | None = None, user=Depends(require_session)):
    """Despesas mensais + ranking anual por conta (pct sobre o total de despesas) — Iteração 2."""
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    with _conn() as con:
        cur = con.cursor()
        ano = ano or _ano_default(cur)
        pm = _dre_mensal(cur, emp, ano)
        meses = [{"mes": m,
                  "pessoal": _money(pm.get(m, {}).get(PESSOAL)),
                  "infra": _money(pm.get(m, {}).get(INFRA)),
                  "outras": _money(pm.get(m, {}).get(OUTRAS)),
                  "administrativas": _money(pm.get(m, {}).get(ADM))}
                 for m in range(1, 13)]                      # sempre 12 itens
        totais = {c: sum(pm.get(m, {}).get(c) or 0.0 for m in range(1, 13))
                  for c in CONTAS_DESPESA}
        total = sum(totais.values())
        ranking = [{"conta": c, "total": _money(v), "pct": _pct(v, total or None) or 0.0}
                   for c, v in sorted(totais.items(), key=lambda kv: -kv[1])]
        return {"ano": ano, "meses": meses, "ranking": ranking}


@router.get("/historico/{slug}")
def historico(slug: str, user=Depends(require_session)):
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    ef, ep = _emp_where(emp)
    with _conn() as con:
        cur = con.cursor()
        cur.execute(f"""SELECT p.ano,
                SUM(f.valor) FILTER (WHERE c.descricao=%s) AS rb,
                SUM(f.valor) FILTER (WHERE c.descricao=%s) AS rliq,
                SUM(f.valor) FILTER (WHERE c.descricao=%s) AS ebit
            FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
            JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
            WHERE p.ano >= 2018{ef} GROUP BY p.ano ORDER BY p.ano""", [RB, RLIQ, EBIT] + ep)
        anos = [{"ano": int(a), "receita_bruta": _money(rb),
                 "resultado_liquido": _money(rl), "ebit_pct": _pct(eb, rb)}
                for a, rb, rl, eb in cur.fetchall()]
        return {"anos": anos}


@router.get("/fees/{slug}")
def fees(slug: str, ano: int | None = None, user=Depends(require_session)):
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        ano = ano or _ano_default(cur)
        ef, ep = ("", []) if emp["code"] is None else (" AND e.codigo=%s", [emp["code"]])
        cur.execute(f"""SELECT ff.cliente, e.codigo, ff.fee_mensal
            FROM fato_fee_cliente ff JOIN dim_empresa e ON e.id=ff.empresa_id
            WHERE ff.ano=%s{ef} ORDER BY ff.fee_mensal DESC NULLS LAST""", [ano] + ep)
        rows = cur.fetchall()
        total_mensal = sum(float(fm or 0) for _, _, fm in rows)
        total_anual = total_mensal * 12.0
        clientes, acum = [], 0.0
        # curva ABC: ordenado desc por fee_anual; pct_acum acumulado
        for cliente, code, fm in sorted(rows, key=lambda r: -float(r[2] or 0)):
            e = BY_CODE.get(code, GRUPO)
            fee_mensal = float(fm or 0)
            fee_anual = fee_mensal * 12.0
            pct = (fee_anual / total_anual * 100.0) if total_anual else 0.0
            acum += pct
            clientes.append({"cliente": cliente, "empresa_slug": e["slug"],
                             "empresa_label": e["label"], "color": e["color"],
                             "fee_mensal": round(fee_mensal, 2), "fee_anual": round(fee_anual, 2),
                             "pct": round(pct, 2), "pct_acum": round(min(acum, 100.0), 2)})
        return {"total_fee_mensal": round(total_mensal, 2), "clientes": clientes}


@router.get("/receita-var/{slug}")
def receita_var(slug: str, ano: int | None = None, user=Depends(require_session)):
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    ef, ep = _emp_where(emp)
    with _conn() as con:
        cur = con.cursor()
        ano = ano or _ano_default(cur)
        cur.execute(f"""SELECT cl.nome, r.tipo_receita, SUM(r.valor)
            FROM fato_receita_cliente_mensal r JOIN dim_cliente cl ON cl.id=r.cliente_id
            JOIN dim_empresa e ON e.id=r.empresa_id JOIN dim_periodo p ON p.id=r.periodo_id
            WHERE p.ano=%s{ef} GROUP BY cl.nome, r.tipo_receita
            ORDER BY SUM(r.valor) DESC NULLS LAST""", [ano] + ep)
        return {"clientes": [{"cliente": n, "tipo_receita": t, "total": _money(v)}
                             for n, t, v in cur.fetchall()]}


# --- Folha — LGPD: nunca expor salário exato, só a banda ---------------------
_BANDAS = [(2500, "até R$ 2,5k"), (5000, "R$ 2,5–5k"), (7500, "R$ 5–7,5k"),
           (10000, "R$ 7,5–10k"), (15000, "R$ 10–15k"), (20000, "R$ 15–20k"),
           (30000, "R$ 20–30k")]


def _faixa_salarial(valor):
    v = float(valor or 0)
    for lim, rotulo in _BANDAS:
        if v < lim:
            return rotulo
    return "R$ 30k+"


@router.get("/folha/{slug}")
def folha(slug: str, ano: int | None = None, mes: int | None = None,
          user=Depends(require_session)):
    emp = _slug_or_404(slug)
    _autoriza(slug, user)
    is_grupo = emp["code"] is None
    ef, ep = _emp_where(emp)
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        ano = ano or _ano_default(cur)
        mes = mes or _folha_periodo_default(cur, ano)

        cur.execute(f"""SELECT f.departamento, f.cargo, f.salario, f.total
            FROM fato_folha_mensal f JOIN dim_empresa e ON e.id=f.empresa_id
            JOIN dim_periodo p ON p.id=f.periodo_id
            WHERE p.ano=%s AND p.mes=%s{ef}
            ORDER BY f.departamento, f.total DESC NULLS LAST""", [ano, mes] + ep)
        rows = cur.fetchall()
        total = round(sum(float(t or 0) for _, _, _, t in rows), 2)
        headcount = len(rows)
        custo_medio = round(total / headcount, 2) if headcount else None

        deps = {}
        for dep, cargo, sal, tot in rows:
            d = deps.setdefault(dep or "—", {"nome": dep or "—", "total": 0.0,
                                             "headcount": 0, "colaboradores": []})
            d["total"] += float(tot or 0)
            d["headcount"] += 1
            # LGPD: banda calculada sobre o salário-base (fallback: total)
            d["colaboradores"].append({"cargo": cargo,
                                       "faixa_salarial": _faixa_salarial(sal if sal is not None else tot)})
        departamentos = sorted(({**d, "total": round(d["total"], 2)} for d in deps.values()),
                               key=lambda d: -d["total"])

        out = {"ano": ano, "mes": mes, "total": total, "headcount": headcount,
               "custo_medio": custo_medio, "departamentos": departamentos}

        if is_grupo:   # por_empresa só no consolidado (contrato)
            cur.execute("""SELECT e.codigo, COALESCE(SUM(f.total),0), COUNT(*)
                FROM fato_folha_mensal f JOIN dim_empresa e ON e.id=f.empresa_id
                JOIN dim_periodo p ON p.id=f.periodo_id
                WHERE p.ano=%s AND p.mes=%s GROUP BY e.codigo""", [ano, mes])
            folha_emp = {c: (float(t), int(h)) for c, t, h in cur.fetchall()}
            cur.execute("""SELECT e.codigo, SUM(f.valor)
                FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
                JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
                WHERE p.ano=%s AND p.mes=%s AND c.descricao=%s GROUP BY e.codigo""", [ano, mes, RB])
            rec_emp = {c: float(v or 0) for c, v in cur.fetchall()}
            out["por_empresa"] = [
                {"slug": e["slug"], "label": e["label"], "color": e["color"],
                 "total": _money(folha_emp.get(e["code"], (0, 0))[0]),
                 "headcount": folha_emp.get(e["code"], (0, 0))[1],
                 "receita_mes": _money(rec_emp.get(e["code"])),
                 "ratio_folha_receita": _pct(folha_emp.get(e["code"], (0, 0))[0],
                                             rec_emp.get(e["code"]))}
                for e in EMPRESAS]
        return out


# =============================================================================
# Alertas A01–A10 (briefing §4) — avaliados no ano corrente (default do dado)
# =============================================================================
def _avaliar_alertas(cur, ano, emps=None):
    """Avalia A01–A10 para cada empresa de `emps` (default: todas).
    RBAC: o chamador passa só as empresas do escopo do usuário. Retorna (criticos, atencao)."""
    criticos, atencao = [], []
    emps = EMPRESAS if emps is None else emps

    def add(lista, regra, emp, titulo, detalhe, acao):
        lista.append({"id": f"{regra}:{emp['slug']}", "regra": regra,
                      "empresa_slug": emp["slug"], "titulo": titulo,
                      "detalhe": detalhe, "acao": acao})

    def brl(v):
        s = f"R$ {abs(v):,.0f}".replace(",", ".")
        return ("-" + s) if v < 0 else s

    for emp in emps:
        dre = _dre_ano(cur, emp, ano)
        prev = _dre_ano(cur, emp, ano - 1)
        pm = _dre_mensal(cur, emp, ano)
        rb, rliq, ebit = dre.get(RB), dre.get(RLIQ), dre.get(EBIT)
        ebit_pct = (ebit / rb * 100.0) if (ebit is not None and rb) else None

        # A01 — resultado líquido do ano negativo (CRÍTICO)
        if rliq is not None and rliq < 0:
            add(criticos, "A01", emp, "Resultado Líquido negativo",
                f"Resultado líquido acumulado {ano}: {brl(rliq)}.",
                "Revisar estrutura de custos e renegociar contratos deficitários.")

        # A02 — EBIT % do ano abaixo de 0 (CRÍTICO)
        if ebit_pct is not None and ebit_pct < 0:
            add(criticos, "A02", emp, "EBIT Negócio abaixo de 0%",
                f"EBIT {ano}: {round(ebit_pct, 1)}% da receita bruta ({brl(ebit)}).",
                "Investigar margem operacional: custos diretos e folha.")

        # A03 — folha do mês > receita do mês (CRÍTICO) — precisa de folha carregada
        mes_f = _folha_periodo_default(cur, ano)
        folha_total, _hc = _folha_mes_total(cur, emp, ano, mes_f)
        receita_mes = pm.get(mes_f, {}).get(RB)
        if folha_total and receita_mes is not None and folha_total > receita_mes:
            add(criticos, "A03", emp, "Folha maior que a receita do mês",
                f"Folha {mes_f:02d}/{ano}: {brl(folha_total)} vs receita {brl(receita_mes)}.",
                "Ação imediata: redimensionar equipe ou acelerar faturamento.")

        # A04/A05 — concentração de fees em um único cliente (CRIT >50% / ATEN >30%)
        cur.execute("""SELECT COALESCE(MAX(fee_mensal),0), COALESCE(SUM(fee_mensal),0)
            FROM fato_fee_cliente ff JOIN dim_empresa e ON e.id=ff.empresa_id
            WHERE ff.ano=%s AND e.codigo=%s""", [ano, emp["code"]])
        max_fee, tot_fee = [float(x or 0) for x in cur.fetchone()]
        conc = (max_fee / tot_fee) if tot_fee else 0.0
        if conc > 0.5:
            add(criticos, "A04", emp, "Cliente único concentra mais de 50% dos fees",
                f"Maior cliente representa {round(conc * 100, 1)}% dos fees de {ano}.",
                "Diversificar carteira: risco alto de dependência de um cliente.")
        elif conc > 0.3:   # A05 só quando A04 não disparou (evita alerta duplicado)
            add(atencao, "A05", emp, "Cliente único concentra mais de 30% dos fees",
                f"Maior cliente representa {round(conc * 100, 1)}% dos fees de {ano}.",
                "Monitorar concentração e prospectar novos clientes.")

        # A06 — EBIT mensal negativo em 3+ meses (CRÍTICO)
        meses_neg = [m for m, d in pm.items() if d.get(EBIT) is not None and d[EBIT] < 0]
        if len(meses_neg) >= 3:
            add(criticos, "A06", emp, "EBIT negativo por 3 ou mais meses",
                f"EBIT mensal negativo em {len(meses_neg)} meses de {ano}: "
                f"{', '.join(f'{m:02d}' for m in sorted(meses_neg))}.",
                "Analisar sazonalidade e custos fixos da operação.")

        # A07 — queda de receita > 30% vs ano anterior (CRÍTICO)
        rb_prev = prev.get(RB)
        if rb is not None and rb_prev and rb_prev > 0:
            yoy = (rb - rb_prev) / rb_prev
            if yoy < -0.30:
                add(criticos, "A07", emp, "Queda de receita superior a 30% vs ano anterior",
                    f"Receita bruta {ano}: {brl(rb)} vs {ano - 1}: {brl(rb_prev)} "
                    f"({round(yoy * 100, 1)}%).",
                    "Investigar perda de contratos e pipeline comercial.")

        # A08 — folha anualizada / receita anualizada > 25% (ATENÇÃO)
        n_meses = len(pm) or 1
        receita_media = (rb / n_meses) if rb else None
        if folha_total and receita_media:
            ratio = folha_total / receita_media   # ambos mensais = anualizado dos 2 lados
            if ratio > 0.25:
                add(atencao, "A08", emp, "Folha acima de 25% da receita",
                    f"Folha mensal {brl(folha_total)} = {round(ratio * 100, 1)}% "
                    f"da receita média mensal de {ano}.",
                    "Avaliar produtividade e estrutura de pessoal.")

        # Guarda anti-"zero = sem dado": se TODAS as linhas mensais da conta são 0
        # (ex.: Zup com P&L parcial), não dispara alertas de variação/meta sobre zero.
        rl_all_zero = pm and all((d.get(RLIQ) or 0) == 0 for d in pm.values())
        eb_all_zero = pm and all((d.get(EBIT) or 0) == 0 for d in pm.values())

        # A09 — EBIT % abaixo da meta (ATENÇÃO, meta default 8%); A02 cobre <0
        if ebit_pct is not None and not eb_all_zero and 0 <= ebit_pct < META_EBIT_PCT:
            add(atencao, "A09", emp, f"EBIT abaixo da meta de {META_EBIT_PCT:g}%",
                f"EBIT {ano}: {round(ebit_pct, 1)}% (meta {META_EBIT_PCT:g}%).",
                "Plano de recuperação de margem para atingir a meta.")

        # A10 — resultado líquido caiu mais de 40% yoy (ATENÇÃO)
        rliq_prev = prev.get(RLIQ)
        if rliq is not None and not rl_all_zero and rliq_prev not in (None, 0):
            yoy_rl = (rliq - rliq_prev) / abs(rliq_prev)
            if yoy_rl < -0.40:
                add(atencao, "A10", emp, "Resultado líquido caiu mais de 40% vs ano anterior",
                    f"Resultado líquido {ano}: {brl(rliq)} vs {ano - 1}: {brl(rliq_prev)} "
                    f"({round(yoy_rl * 100, 1)}%).",
                    "Comparar linhas de custo yoy para localizar a deterioração.")

    return criticos, atencao


@router.get("/alertas")
def alertas(ano: int | None = None, user=Depends(require_session)):
    emps = _empresas_do_usuario(user)      # RBAC: avalia SÓ as empresas do escopo
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        ano = ano or _ano_default(cur)
        criticos, atencao = _avaliar_alertas(cur, ano, emps)

        # snoozed: somem do badge mas continuam no log (frontend filtra);
        # RBAC: só ids de alertas de empresas no escopo (id = "A03:viv")
        cur.execute("SELECT alert_id FROM cockpit_alert_snooze WHERE ate >= CURRENT_DATE")
        permitidos = {e["slug"] for e in emps}
        snoozed = [r[0] for r in cur.fetchall()
                   if r[0].split(":", 1)[-1] in permitidos]

        # semáforo por empresa (só as do escopo)
        crit_por_emp = {a["empresa_slug"] for a in criticos}
        aten_por_emp = {a["empresa_slug"] for a in atencao}
        primeiro = {}
        for a in criticos + atencao:
            primeiro.setdefault(a["empresa_slug"], a["titulo"])
        semaforo = []
        for e in emps:
            if e["slug"] in crit_por_emp:
                status = "critico"
            elif e["slug"] in aten_por_emp:
                status = "atencao"
            else:
                status = "saudavel"
            semaforo.append({"slug": e["slug"], "label": e["label"], "color": e["color"],
                             "status": status,
                             "motivo": primeiro.get(e["slug"], "Sem alertas ativos")})

        # heatmap N x 12 de resultado líquido mensal (N = empresas do escopo)
        heat_emp = []
        for e in emps:
            pm = _dre_mensal(cur, e, ano)
            heat_emp.append({"slug": e["slug"], "label": e["label"],
                             "valores": [_money(pm.get(m, {}).get(RLIQ)) for m in range(1, 13)]})

        return {"semaforo": semaforo, "criticos": criticos, "atencao": atencao,
                "heatmap": {"meses": list(range(1, 13)), "empresas": heat_emp},
                "snoozed": snoozed}


class SnoozeBody(BaseModel):
    dias: int = 7


@router.post("/alertas/{alert_id}/snooze", status_code=204)
def snooze(alert_id: str, body: SnoozeBody, user=Depends(require_session)):
    if body.dias < 1 or body.dias > 365:
        raise HTTPException(status_code=422, detail="dias deve estar entre 1 e 365")
    # RBAC: id do alerta = "A03:viv" — snooze só de empresas no escopo do usuário
    slug_alerta = alert_id.split(":", 1)[-1] if ":" in alert_id else ""
    _autoriza(slug_alerta, user)
    with _conn() as con:
        cur = con.cursor()
        _ensure_tables(cur)
        cur.execute("""INSERT INTO cockpit_alert_snooze (alert_id, ate)
            VALUES (%s, CURRENT_DATE + %s)
            ON CONFLICT (alert_id) DO UPDATE SET ate = EXCLUDED.ate""",
                    [alert_id, body.dias])
    return Response(status_code=204)
