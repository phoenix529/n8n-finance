#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
cockpit_users.py — CLI de gestão de usuários do Cockpit (tabela cockpit_user).
Contrato: cockpit-app/API_CONTRACT.md §"Autenticação + RBAC por usuário (Iteração 3)".

Uso (no servidor: docker compose exec -it ia python cockpit_users.py ...):
  python cockpit_users.py add USERNAME --empresas viv,zuptech   # senha via prompt
  python cockpit_users.py add USERNAME --empresas todas --senha SEGREDO
  python cockpit_users.py list
  python cockpit_users.py disable USERNAME
  python cockpit_users.py password USERNAME                     # nova senha via prompt

Reusa .env/DB/hash scrypt de ia/api_cockpit.py (mesmo formato hex(salt)$hex(hash)).
NUNCA imprime hashes de senha. O usuário `admin` é o master (COCKPIT_PASSWORD do
.env) e NÃO vive nesta tabela.
"""
import argparse
import getpass
import os
import re
import sys

import psycopg2

# mesmo .env/DB/scrypt da API — importa do módulo vizinho (mesma pasta/container)
from api_cockpit import BY_SLUG, DB, _DDL, _hash_senha


def _conn():
    return psycopg2.connect(connect_timeout=6, **DB)


def _ensure(cur):
    cur.execute(_DDL)   # CREATE TABLE IF NOT EXISTS (inclui cockpit_user)


def _valida_empresas(csv):
    """Normaliza o escopo: 'todas' OU CSV de slugs válidos (ordem preservada)."""
    if csv.strip().lower() == "todas":
        return "todas"
    slugs, vistos = [], set()
    for s in csv.split(","):
        s = s.strip()
        if not s:
            continue
        if s not in BY_SLUG:
            sys.exit(f"erro: slug desconhecido '{s}' — válidos: "
                     f"{', '.join(BY_SLUG)} ou 'todas'")
        if s not in vistos:
            vistos.add(s)
            slugs.append(s)
    if not slugs:
        sys.exit("erro: --empresas vazio — informe slugs (ex.: viv,zuptech) ou 'todas'")
    return ",".join(slugs)


def _pede_senha(arg_senha):
    """Senha por env COCKPIT_NOVA_SENHA (não vaza no ps/history), --senha
    (INSEGURO: fica no histórico do shell — evite) ou prompt getpass."""
    env = os.environ.get("COCKPIT_NOVA_SENHA", "")
    if env:
        return env
    if arg_senha:
        print("aviso: --senha fica visível no histórico do shell; prefira o prompt "
              "ou a env COCKPIT_NOVA_SENHA", file=sys.stderr)
        return arg_senha
    s1 = getpass.getpass("Senha: ")
    s2 = getpass.getpass("Confirme a senha: ")
    if s1 != s2:
        sys.exit("erro: senhas não conferem")
    if not s1:
        sys.exit("erro: senha vazia")
    return s1


_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")


def _valida_username(u):
    if not _USERNAME_RE.fullmatch(u):
        sys.exit("erro: username inválido — use 2-80 chars [a-z 0-9 . _ -], começando "
                 "com letra/dígito (ex.: leonel, gestor.viv)")
    return u


def cmd_add(args):
    usuario = _valida_username(args.username.strip().lower())
    if not usuario:
        sys.exit("erro: username vazio")
    if usuario == "admin":
        sys.exit("erro: 'admin' é o master (COCKPIT_PASSWORD do .env) — não vive na tabela")
    empresas = _valida_empresas(args.empresas)
    senha = _pede_senha(args.senha)
    with _conn() as con:
        cur = con.cursor()
        _ensure(cur)
        cur.execute("SELECT 1 FROM cockpit_user WHERE username=%s", [usuario])
        if cur.fetchone():
            sys.exit(f"erro: usuário '{usuario}' já existe (use 'password' p/ trocar a senha)")
        cur.execute("""INSERT INTO cockpit_user (username, senha_hash, empresas)
                       VALUES (%s, %s, %s)""", [usuario, _hash_senha(senha), empresas])
    print(f"ok: usuário '{usuario}' criado — empresas: {empresas}")


def cmd_list(_args):
    with _conn() as con:
        cur = con.cursor()
        _ensure(cur)
        cur.execute("""SELECT username, empresas, ativo, criado_em
                       FROM cockpit_user ORDER BY username""")
        rows = cur.fetchall()
    if not rows:
        print("(nenhum usuário — só o master 'admin' via COCKPIT_PASSWORD)")
        return
    # nunca imprime senha_hash
    print(f"{'USERNAME':<24} {'EMPRESAS':<40} {'ATIVO':<6} CRIADO_EM")
    for u, emp, ativo, criado in rows:
        print(f"{u:<24} {emp:<40} {'sim' if ativo else 'NAO':<6} {criado:%Y-%m-%d %H:%M}")


def cmd_disable(args):
    with _conn() as con:
        cur = con.cursor()
        _ensure(cur)
        cur.execute("UPDATE cockpit_user SET ativo=FALSE WHERE username=%s",
                    [args.username])
        if cur.rowcount == 0:
            sys.exit(f"erro: usuário '{args.username}' não existe")
    print(f"ok: usuário '{args.username}' desativado (sessões param de valer imediatamente)")


def cmd_password(args):
    senha = _pede_senha(args.senha)
    with _conn() as con:
        cur = con.cursor()
        _ensure(cur)
        cur.execute("UPDATE cockpit_user SET senha_hash=%s WHERE username=%s",
                    [_hash_senha(senha), args.username])
        if cur.rowcount == 0:
            sys.exit(f"erro: usuário '{args.username}' não existe")
    print(f"ok: senha de '{args.username}' atualizada")


def main():
    ap = argparse.ArgumentParser(description="Gestão de usuários do Cockpit (cockpit_user)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="cria usuário")
    p_add.add_argument("username")
    p_add.add_argument("--empresas", required=True,
                       help="CSV de slugs (ex.: viv,zuptech) OU 'todas'")
    p_add.add_argument("--senha", help="senha (default: prompt interativo)")
    p_add.set_defaults(fn=cmd_add)

    p_list = sub.add_parser("list", help="lista usuários (sem hashes)")
    p_list.set_defaults(fn=cmd_list)

    p_dis = sub.add_parser("disable", help="desativa usuário")
    p_dis.add_argument("username")
    p_dis.set_defaults(fn=cmd_disable)

    p_pwd = sub.add_parser("password", help="troca a senha de um usuário")
    p_pwd.add_argument("username")
    p_pwd.add_argument("--senha", help="nova senha (default: prompt interativo)")
    p_pwd.set_defaults(fn=cmd_password)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
