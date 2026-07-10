# Contrato da API — Cockpit Financeiro Grupo REF (v1)

Fonte da verdade entre backend (`ia/api_cockpit.py`) e frontend (`cockpit-app/`).
Todos os valores vêm do PostgreSQL `cockpit_ref` (NUNCA hardcoded — spec §6 do briefing).

## Registro de empresas (slug ↔ código do banco)
| slug (URL) | code (dim_empresa.codigo) | label (UI) | cor |
|---|---|---|---|
| `ref-plus`   | REF | REF+           | `#F5C842` |
| `black-door` | BD  | Black Door     | `#22C55E` |
| `4in`        | 4PR | 4In            | `#F97316` |
| `viv`        | VIV | Viv Experience | `#A855F7` |
| `zuptech`    | ZUP | Zuptech        | `#3B82F6` |
| `grupo`      | —   | Grupo REF (consolidado = soma das 5) | `#F5C842` |

## Contas DRE usadas (dim_conta.descricao)
- `RECEITA BRUTA`, `RECEITA OPERACIONAL LIQUIDA`, `RESULTADO OPERACIONAL DA AGENCIA`,
  `RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)`, `RESULTADO LIQUIDO`.
- `ebit_pct = EBIT / RECEITA BRUTA` (mesma janela).

## Autenticação + RBAC por usuário (Iteração 3)
- `POST /api/login` body `{"usuario": "...", "senha": "..."}` → 204 + cookie httpOnly `ck_session` (12h).
  401 se credencial errada. Usuários na tabela `cockpit_user(id PK, username UNIQUE, senha_hash
  varchar(200) — scrypt salt$hash hex, empresas varchar(200) — CSV de slugs OU 'todas',
  ativo bool default true, criado_em)`. **Master**: usuario `admin` + `COCKPIT_PASSWORD` → todas.
- Cookie v2: `v2.<username>.<exp>.<hmac>` (HMAC-SHA256 sobre `username.exp`, secret derivado de
  COCKPIT_PASSWORD). Tokens no formato antigo são rejeitados (re-login).
- `GET /api/session` → `{"ok": true, "usuario": "...", "empresas": ["viv", ...] | "todas"}` ou 401.
- **Enforcement SERVER-SIDE em todos os endpoints**: slug fora do escopo → **403**;
  `grupo`/consolidado (kpis/grupo, fees/grupo, folha/grupo, cascata/grupo, dre*/grupo,
  despesas/grupo, historico/grupo) → só usuários `todas` (o consolidado revela as outras);
  `/api/empresas` → só as permitidas; `/api/alertas` → semáforo/críticos/atenção/heatmap
  FILTRADOS ao escopo; snooze → só de alertas de empresas no escopo.
- `COCKPIT_PASSWORD` não definida → 503 (fechado por padrão; ela também é o secret de assinatura).
  `COCKPIT_DEV_OPEN=1` desativa auth (só dev local) — opcional `COCKPIT_DEV_USER=<username>`
  simula esse usuário (escopo da tabela) p/ testar RBAC sem senha.
- Gestão de usuários: CLI `ia/cockpit_users.py` (`add|list|disable|password`), senha via prompt
  interativo (getpass) ou `--senha`; roda no servidor: `docker compose exec -it ia python cockpit_users.py ...`.
- Front: campo usuário no login; sidebar mostra SÓ empresas permitidas; item "Macro — Grupo" e
  telas consolidadas escondidos p/ escopo parcial; rota default de escopo parcial = 1ª empresa
  permitida; chips de empresa filtrados; widgets grupo-only escondidos. (Backend 403 é a rede de segurança.)

### Super-admin — gestão de usuários pela web (Iteração 4)
- Coluna nova `cockpit_user.admin BOOLEAN NOT NULL DEFAULT FALSE` (migração idempotente
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS admin ...`). **Super-admin** = master `admin` (sempre)
  OU usuário da tabela com `admin=true`. `admin` é independente do escopo de empresas, mas a UI
  de admin exige apenas a flag (não força `todas`).
- `GET /api/session` passa a incluir **`admin` (bool)**.
- Dependência `require_admin` (= `require_session` + `user.admin` senão **403**). Rotas `/api/admin/*`:
  - `GET /api/admin/users` → `[{username, empresas: 'todas'|[slugs], ativo, admin, criado_em}]`
    (NUNCA devolve hash; o master `admin` NÃO aparece na lista — é implícito/externo à tabela).
  - `POST /api/admin/users` body `{username, empresas: 'todas'|[slugs]|csv, senha, admin?:false}`
    → 201. Valida username (`^[a-z0-9][a-z0-9._-]{1,79}$`, minúsculo), rejeita duplicado (409) e
    o reservado `admin` (400). Empresas: 'todas' ou subconjunto de slugs válidos (senão 400).
    Senha mín. 8 chars (400 se curta).
  - `PATCH /api/admin/users/{username}` body parcial `{empresas?, ativo?, admin?, senha?}` → 200.
    Reset de senha, mudança de escopo, ativar/desativar, promover/rebaixar admin.
  - **Trava anti-lockout (server-side, sempre):** o super-admin autenticado NÃO pode desativar a si
    mesmo nem remover o próprio `admin` (409 "não é possível remover o próprio acesso de admin");
    `admin` (master) é reservado e não é alvo de PATCH/POST (400). Mutações checam
    `hmac.compare_digest`-nada — mas exigem sessão admin válida (cookie samesite=lax mitiga CSRF).
  - Todas as respostas de erro em PT-BR no `detail`.
- Front: rota `#/admin` + item de menu "Administração" (ícone engrenagem) **visível só p/ `session.admin`**.
  Tela = tabela de usuários (usuário, empresas, status, admin, ações) + form "Novo usuário"
  (username, multiselect de empresas ou "Todas", senha, checkbox admin) + ações por linha
  (editar escopo, ativar/desativar, resetar senha via prompt). Router BLOQUEIA `#/admin` p/ não-admin
  (redireciona p/ rota inicial). Backend 403 continua sendo a rede de segurança.

## Endpoints (todos GET, exceto login/snooze; `ano` default = último ano com dados)
- `/api/health` → `{status, db}` — **aberto** (sem cookie; usado por smoke tests/monitoração)
- `/api/empresas` → `[{slug, code, label, color}]` (+`grupo` não incluso)
- `/api/kpis/grupo?ano=` → `{ano, receita_bruta, receita_liquida, folha_mes, headcount,
   resultado_liquido, prev: {ano, receita_bruta, resultado_liquido}, mix: [{slug,label,color,receita,pct}]}`
   (`folha_mes`/`headcount` = mês mais recente com folha carregada)
- `/api/kpis/{slug}?ano=` → `{ano, receita_bruta, receita_liquida, resultado_agencia,
   ebit_pct, resultado_liquido, prev:{...}}`
- `/api/dre/mensal/{slug}?ano=` → `{ano, meses:[{mes, receita_bruta, resultado_agencia, resultado_liquido, ebit}] }` (12 itens)
- `/api/dre/trimestral/{slug}?ano=` → `{ano, tris:[{tri, receita_bruta, ebit_negocio_pct, ebit_agencia_pct, resultado_liquido}] }` (+`total`).
  Definições (idênticas à planilha): `ebit_negocio_pct = EBIT/RECEITA BRUTA`; `ebit_agencia_pct = EBIT/RESULTADO AGÊNCIA`.
- `/api/historico/{slug}` → `{anos:[{ano, receita_bruta, resultado_liquido, ebit_pct}]}` (2018→, o que houver)
- `/api/fees/{slug|grupo}?ano=` → `{total_fee_mensal, clientes:[{cliente, empresa_slug, empresa_label, color,
   fee_mensal, fee_anual, pct, pct_acum}]}` ordenado desc por fee_anual (curva ABC)
- `/api/receita-var/{slug}?ano=` → `{clientes:[{cliente, tipo_receita, total}]}` (fato_receita_cliente_mensal)
- `/api/folha/{slug|grupo}?ano=&mes=` → `{ano, mes, total, headcount, custo_medio,
   departamentos:[{nome, total, headcount, colaboradores:[{cargo, faixa_salarial}]}],
   por_empresa:[{slug,label,color,total,headcount,receita_mes,ratio_folha_receita}]}`  ← por_empresa só no `grupo`
   (faixa_salarial = banda "R$ 5–7,5k", nunca salário exato — LGPD)
### Iteração 2 (dashboard de referência do cliente — realizado vs projetado + DRE detalhada)
- Campo **`realizado_ate`** (int 0..12) em `/api/dre/mensal` e `/api/kpis/*`: último mês REALIZADO
  do ano (ano passado→12, ano corrente→mês-calendário anterior, ano futuro→0). Meses acima disso
  são PROJEÇÃO — o front desenha com alpha/borda tracejada + chip "Realizado até {mês}".
- `/api/dre/mensal/{slug}` ganha, por mês: `custos_diretos, pessoal, infra, outras, administrativas,
  tributos, receita_liquida, caixa_acum` (= conta **GERACAO DE CAIXA** da planilha, que já vem
  acumulada mês a mês; fallback = acumulado do resultado líquido se a linha faltar).
- `/api/cascata/{slug}?ano=&ate=` → `{passos:[{label, valor, tipo:'total'|'delta'}]}` — cascata
  RB → deduções → RL → custos diretos → RA → pessoal → infra → outras (incl. adm.) → EBIT → tributos → Res. Líq.
  Deltas derivados como RESÍDUOS entre os anchors (a cascata SEMPRE reconcilia — RB+Σdeltas = RL final,
  mesmo com planilhas parciais como a da Zup ou ADM fora da cadeia em BD/4PR/VIV).
  (`ate` opcional = só meses ≤ ate, p/ "cascata do semestre realizado").
  Nota /api/despesas: ADM entra no ranking como linha informativa; confirmar com o cliente a natureza
  da conta (nas planilhas de BD/4PR/VIV a DRE fecha SEM ela — provável sub-linha).
- `/api/despesas/{slug}?ano=` → `{meses:[{mes, pessoal, infra, outras, administrativas}],
  ranking:[{conta, total, pct}]}` (ranking soma ano; contas de despesa canônicas).
- `/api/dre/trimestral/{slug}?ano=` passa a incluir `hist: [{ano, tris:[{tri, receita_bruta,
  ebit_negocio_pct, ebit_agencia_pct, resultado_liquido, resultado_agencia}]}]` com os anos
  anteriores vindos da NOVA tabela `fato_dre_tri_hist` (aba 'Comparativo/Resumo tri' das planilhas):
  `fato_dre_tri_hist(id PK, empresa_id, ano int, tri int, metrica varchar(60), valor numeric(16,2),
   UNIQUE(empresa_id, ano, tri, metrica))` — métricas: RECEITA_BRUTA, RECEITA_LIQUIDA,
   RESULTADO_AGENCIA, EBIT, EBIT_NEG_PCT, EBIT_AG_PCT, RESULTADO_LIQUIDO.
- PENDENTE (aguarda cliente indicar fonte): custo/cobertura por cliente (ded/over/tcost/ppl do
  arquivo de referência não existe nas abas atuais).

- `/api/alertas?ano=` (ano opcional) → `{semaforo:[{slug,label,color,status: 'critico'|'atencao'|'saudavel', motivo}],
   criticos:[{id, regra, empresa_slug, titulo, detalhe, acao}], atencao:[...idem],
   heatmap:{meses:[1..12], empresas:[{slug,label,valores:[12 x resultado_liquido]}]}, snoozed:[ids]}`
- `POST /api/alertas/{id}/snooze` body `{dias}` → 204 (grava em cockpit_alert_snooze)

## Regras de alerta (A01–A10 do briefing §4) — avaliadas no ano corrente
A01 res_liq_ano<0 (CRIT) · A02 ebit_pct<0 (CRIT) · A03 folha_mes>receita_mes (CRIT)
A04 max_fee/total_fees>0.5 (CRIT) · A05 >0.3 (ATEN) · A06 EBIT mensal<0 em ≥3 meses (CRIT)
A07 receita yoy<−30% (CRIT) · A08 folha_anualizada/receita>0.25 (ATEN)
A09 ebit_pct<meta (ATEN, meta default 8%) · A10 res_liq yoy<−40% (ATEN)
`id` do alerta = `"A03:viv"` (regra:empresa). Snoozed some do badge, continua no log.

## Novas tabelas (criadas via CREATE TABLE IF NOT EXISTS pelo módulo de ingestão)
```sql
fato_folha_mensal(id serial PK, empresa_id int→dim_empresa, periodo_id int→dim_periodo,
  nome varchar(160), departamento varchar(120), cargo varchar(120), tipo varchar(40),
  salario numeric(14,2), extra numeric(14,2), total numeric(14,2),
  UNIQUE(empresa_id, periodo_id, nome, departamento, cargo))
fato_fee_cliente(id serial PK, empresa_id int, cliente varchar(160), fee_mensal numeric(14,2),
  ano int, UNIQUE(empresa_id, cliente, ano))
cockpit_alert_snooze(alert_id varchar(40) PK, ate date NOT NULL)
```

## Frontend — contratos globais (`cockpit-app/`)
- Convenção de percentuais: a API devolve SEMPRE em pontos percentuais (3.8 = "3,8%").
  `CK.fmt.percent(v)` espera pontos percentuais; `CK.fmt.pct(v)` espera FRAÇÃO (legado).
- Drawers: overlay 40% é só visual (`pointer-events:none`) — fundo interativo; fechar = ✕ ou Escape (topo da pilha).
- Namespace `window.CK`: `CK.api(path)` (fetch + 401→tela login), `CK.fmt` (moeda/percent pt-BR),
  `CK.EMPRESAS` (tabela acima), `CK.registerScreen(name, {title, subtitle, render(el, params)})`,
  `CK.openDrawer({title, render})` (slide-over, overlay 40%, fundo interativo NÃO bloqueado),
  `CK.charts` (helpers Chart.js com tema dark).
- Rotas hash: `#/macro` `#/micro/{slug}` `#/receitas` `#/custos` `#/alertas` (+login gate).
- Tokens CSS/tipografia: **TEMA CLARO** (iteração 2, paleta do dashboard de referência do cliente):
  paper `#F9F8F6`, ink `#1C1C1C`, gray `#81807C`, line `#E6E3DC`, accent `#D9DA00` (`#FEFF00` bright),
  red `#E5484D`; fontes Urbanist + JetBrains Mono (valores). Sidebar colapsa <1024px. aria-label em todo gráfico.
