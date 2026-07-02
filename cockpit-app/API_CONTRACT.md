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

## Autenticação
- `POST /api/login` body `{"senha": "..."}` → 204 + cookie httpOnly `ck_session` (12h). 401 se errada.
- `GET /api/session` → `{"ok": true}` ou 401.
- Demais `/api/*` exigem o cookie (401 sem ele). `COCKPIT_PASSWORD` não definida → 503
  (fechado por padrão). `COCKPIT_DEV_OPEN=1` desativa auth (só dev local).

## Endpoints (todos GET, exceto login/snooze; `ano` default = último ano com dados)
- `/api/health` → `{status, db}` — **aberto** (sem cookie; usado por smoke tests/monitoração)
- `/api/empresas` → `[{slug, code, label, color}]` (+`grupo` não incluso)
- `/api/kpis/grupo?ano=` → `{ano, receita_bruta, receita_liquida, folha_mes, headcount,
   resultado_liquido, prev: {ano, receita_bruta, resultado_liquido}, mix: [{slug,label,color,receita,pct}]}`
   (`folha_mes`/`headcount` = mês mais recente com folha carregada)
- `/api/kpis/{slug}?ano=` → `{ano, receita_bruta, receita_liquida, resultado_agencia,
   ebit_pct, resultado_liquido, prev:{...}}`
- `/api/dre/mensal/{slug}?ano=` → `{ano, meses:[{mes, receita_bruta, resultado_agencia, resultado_liquido, ebit}] }` (12 itens)
- `/api/dre/trimestral/{slug}?ano=` → `{ano, tris:[{tri, receita_bruta, ebit_negocio_pct, ebit_agencia_pct, resultado_liquido}] }` (+`total`)
- `/api/historico/{slug}` → `{anos:[{ano, receita_bruta, resultado_liquido, ebit_pct}]}` (2018→, o que houver)
- `/api/fees/{slug|grupo}?ano=` → `{total_fee_mensal, clientes:[{cliente, empresa_slug, empresa_label, color,
   fee_mensal, fee_anual, pct, pct_acum}]}` ordenado desc por fee_anual (curva ABC)
- `/api/receita-var/{slug}?ano=` → `{clientes:[{cliente, tipo_receita, total}]}` (fato_receita_cliente_mensal)
- `/api/folha/{slug|grupo}?ano=&mes=` → `{ano, mes, total, headcount, custo_medio,
   departamentos:[{nome, total, headcount, colaboradores:[{cargo, faixa_salarial}]}],
   por_empresa:[{slug,label,color,total,headcount,receita_mes,ratio_folha_receita}]}`  ← por_empresa só no `grupo`
   (faixa_salarial = banda "R$ 5–7,5k", nunca salário exato — LGPD)
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
- Tokens CSS/tipografia: EXATAMENTE os do mockup (`--bg-base #0D0F14`, `--accent #F5C842`, Inter +
  JetBrains Mono etc. — ver cockpit_ref_mockup.html). Sidebar colapsa <1024px. aria-label em todo gráfico.
