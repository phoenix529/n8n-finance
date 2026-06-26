# Integração dos dados reais — Ref Comunicação (5 planilhas DRE)

Este documento descreve como as **5 planilhas reais** (`* - DRE Acumulado 2026.xlsx`)
das unidades **REF+, BD, Viv, 4PR e Zup** foram integradas ao cockpit, substituindo
os dados demonstrativos (Grupo Aurora).

## 1. O que as planilhas contêm (e o que não contêm)

Cada arquivo é um **modelo de DRE (P&L)** de agência, com a aba canônica **`DRE-Base`**:
linhas contábeis na **coluna B** e meses como **colunas datadas** (`jan…dez/2026`).

- **Há** (resultado/P&L): Receita Bruta, Deduções (ISS/PIS/COFINS), Receita Líquida,
  Custos dos Serviços, Resultado Operacional (Lucro Bruto), Despesas Fixas
  (Pessoal/Infra/Outras/Adm), EBIT, Tributos (IRPJ/CSLL), Resultado Líquido, Geração de Caixa.
- **NÃO há** (posição/balanço): saldo de caixa em banco, dívida, contas a receber/pagar.
  → Por isso o cockpit foi **re-orientado para a história de resultado (P&L)**; os antigos
  cartões de Caixa/Runway/Dívida/DSO/Capital de Giro foram substituídos por
  Receita, Margens, Resultado Operacional, Lucro Líquido e **Geração de Caixa**.

### Dois achados importantes (decisões de modelagem)
1. **Janela de atuais = jan–jun/2026 (6 meses).** As planilhas trazem o ano inteiro,
   mas jul–dez são **projeção** (cauda repetida/alternada). O adaptador corta em
   `DRE_MAX_PERIOD` (default `2026-06`) e descarta a projeção.
2. **Zup — dados parciais de 2026.** No arquivo da Zup, as linhas de custo/resultado de
   2026 são **fórmulas sobre células vazias** (ainda não lançadas). Entram apenas
   Receita/Deduções/Tributos. Consequência: a Zup soma **receita** ao grupo, mas seu
   **resultado** fica de fora — o DRE consolidado não fecha exatamente `Receita − Custos`
   (a diferença ≈ receita da Zup). Está sinalizado no cockpit (cartão "dados parciais" e
   Key Insight). Para fechar 100%: lançar os custos de 2026 da Zup **ou** excluí-la do consolidado.

## 2. Pipeline (3 passos, fonte da verdade = PostgreSQL)

```
data/incoming/*.xlsx
   │  (1) data/adapter_dre.py      — lê DRE-Base, casa linhas por texto (robusto a variações
   │                                  de rótulo: AGENCIA/PRODUTORA/EMPRESA, "RESULTADO LIQUIDO"
   │                                  vs "RESULTADO ANTES DAS PARTICIPAÇÕES"), corta projeções
   ▼
cockpit.fact_financials  ◄─ (2) data/load_real_to_db.py   — reseed dim_company (5 unidades)
   │                          + dim_account (13 linhas do DRE) + carga dos fatos
   │                          + telemetria em pipeline_runs (load_id = real-dre-2026)
   ▼
dashboard/dashboard_data.json  ◄─ (3) dashboard/build_cockpit_real.py  — consulta o Postgres
                                     e gera o JSON do cockpit (KPIs, séries, por unidade,
                                     DRE, gastos por categoria, insights, Q&A)
```

### Como rodar / reprocessar
```bash
set PGHOST=127.0.0.1& set PGPORT=5432& set PGDATABASE=cockpit& set PGUSER=postgres& set PGPASSWORD=postgres
python data/adapter_dre.py            # relatório + reconciliação (sanity check)
python data/load_real_to_db.py        # carrega os 5 arquivos no PostgreSQL
set GEN_DATE=2026-06-25& python dashboard/build_cockpit_real.py   # gera o JSON do cockpit
```

Para incluir mais meses quando o cliente enviar planilhas atualizadas, ajuste
`DRE_MAX_PERIOD` (ex.: `set DRE_MAX_PERIOD=2026-07`) e rode os 3 passos novamente.

## 3. Reconciliação (atuais jan–jun/2026, consolidado)

| Linha | Valor |
|---|---|
| Receita Bruta | R$ 89,2 mi |
| Receita Líquida | R$ 87,1 mi |
| Resultado Operacional / Lucro Bruto | R$ 18,6 mi |
| **EBIT (Resultado Operacional)** | **R$ 5,1 mi** (margem 5,9%) |
| **Resultado Líquido** | **R$ 3,0 mi** (margem 3,5%) |
| Geração de Caixa | −R$ 2,7 mi (após distribuições de lucro) |

Participação na receita: **REF+ 81,5%**, BD 9,4%, Viv 4,9%, 4PR 2,1%, Zup 2,0%.

## 4. RAG (Pergunte aos seus dados)

`rag/rag_server.py` foi atualizado para **fundamentar nas tabelas reais**
(`cockpit.fact_financials`) — consolidado, último mês e por unidade. O retrieval já
devolve os números reais; a **geração ao vivo depende de créditos na conta Anthropic**
(hoje a API retorna *"credit balance too low"*). Sem créditos, o cockpit cai
graciosamente nas respostas offline (também fundamentadas nos números reais).

## 5. Mapeamento de contas (DRE da agência → cockpit)

| Linha no arquivo (col B) | account_code | grupo | sinal |
|---|---|---|---|
| RECEITA BRUTA | RECEITA_BRUTA | RECEITA | + |
| DEDUÇÕES IMPOSTOS (ISS/PIS/COFINS) | DEDUCOES | RECEITA | − |
| RECEITA OPERACIONAL LÍQUIDA | RECEITA_LIQUIDA | RECEITA | + |
| CUSTOS DOS SERVIÇOS VENDIDOS | CUSTOS | CUSTO | − |
| RESULTADO OP. DA AGÊNCIA/PRODUTORA/EMPRESA | RESULTADO_AGENCIA | RESULTADO | + |
| GASTOS COM PESSOAL | DESP_PESSOAL | OPEX | − |
| INFRA-ESTRUTURA | DESP_INFRA | OPEX | − |
| OUTRAS DESPESAS | DESP_OUTRAS | OPEX | − |
| DESPESAS ADM. | DESP_ADM | OPEX | − |
| TRIBUTOS FEDERAIS (IRPJ/CSLL) | TRIBUTOS | IMPOSTO | − |
| RESULTADO OPERACIONAL ANTES DOS IMPOSTOS | EBIT | RESULTADO | + |
| RESULTADO LÍQUIDO / ANTES DAS PARTICIPAÇÕES | RESULTADO_LIQUIDO | RESULTADO | + |
| GERAÇÃO DE CAIXA | GERACAO_CAIXA | CAIXA | + |
