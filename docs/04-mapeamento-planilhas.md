# Mapeamento das planilhas — REF Group (Technical Blueprint §6.1)

Artefato de mapeamento exigido antes da codificação. Documenta, por empresa, a aba
principal, as linhas-chave, as colunas de período e as particularidades tratadas
pelos parsers (`ingestao/parsers/`).

## Fonte canônica mensal: aba `DRE-Base`
Em todas as 5 planilhas a DRE mensal detalhada de 2026 está na aba **`DRE-Base`**:
- **Coluna B** = descrição da linha contábil; **colunas E…P** = meses (datas `2026-01-01`…`2026-12-01`).
- O parser detecta o cabeçalho automaticamente (datas `datetime` **ou** texto `JAN/FEV…`).
- NaN/células vazias → `0.0`; linhas de `% EBIT` e linhas em branco são ignoradas.

| Empresa | Cód. | Aba principal | Linhas-chave | Colunas de período | Particularidades |
|---|---|---|---|---|---|
| REF Comunicação | REF | DRE-Base | RECEITA BRUTA, RECEITA OPERACIONAL LÍQUIDA, **RESULTADO OP. DA AGÊNCIA**, EBIT, RESULTADO LÍQUIDO | jan–dez (datetime) | Aba `Resumo Faturamento` (receita por cliente FEE/Variável); `Dados_Clientes`; histórico `Resumo 18 a 26` (2018→); linhas NaN intercaladas |
| BD | BD | DRE-Base | idem; **"RESULTADO OP. DA PRODUTORA"** (nomenclatura) | jan–dez | Produtora; resultado líquido = "RESULTADO ANTES DAS PARTICIPAÇÕES"; histórico 2018→ |
| 4PR | 4PR | DRE-Base | idem | jan–dez | Dados desde 2018; linha "RESULTADO LIQUIDO" explícita |
| Viv | VIV | DRE-Base | idem; **"RESULTADO OP. AGÊNCIA"** (sem "DA") | jan–dez | Dados desde 2021; algumas linhas ausentes em anos anteriores |
| Zup | ZUP | DRE-Base | RECEITA BRUTA, DEDUÇÕES, RECEITA LÍQUIDA, TRIBUTOS | jan–dez | Somente 2025–2026; **custos/resultado de 2026 são fórmulas sobre células vazias** (entram como 0,0) |

## Plano de contas canônico (mapeamento de nomenclatura → conta unificada)
As variações de nome entre empresas são mapeadas por `parsers/base.py` (CANON) para uma
única `dim_conta.descricao`:

| Linha na planilha (variações) | `dim_conta.descricao` | `grupo` |
|---|---|---|
| RECEITA BRUTA | RECEITA BRUTA | REVENUE |
| DEDUÇÕES IMPOSTOS (ISS/PIS/COFINS) | DEDUCOES IMPOSTOS | TAXES |
| RECEITA OPERACIONAL LÍQUIDA | RECEITA OPERACIONAL LIQUIDA | REVENUE |
| CUSTOS DOS SERVIÇOS VENDIDOS | CUSTOS DOS SERVICOS | DIRECT_COST |
| RESULTADO OP. DA AGÊNCIA / PRODUTORA / EMPRESA | RESULTADO OPERACIONAL DA AGENCIA | RESULT |
| GASTOS COM PESSOAL | GASTOS COM PESSOAL | PERSONNEL |
| INFRA-ESTRUTURA | INFRAESTRUTURA | FACILITIES |
| OUTRAS DESPESAS | OUTRAS DESPESAS | ADMIN |
| DESPESAS ADM. (bancárias/IOF/juros) | DESPESAS ADMINISTRATIVAS | FINANCIAL |
| TRIBUTOS FEDERAIS (IRPJ/CSLL) | TRIBUTOS FEDERAIS | TAXES |
| RESULTADO OPERACIONAL ANTES DOS IMPOSTOS | RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT) | RESULT |
| RESULTADO LÍQUIDO / ANTES DAS PARTICIPAÇÕES | RESULTADO LIQUIDO | RESULT |
| GERAÇÃO DE CAIXA | GERACAO DE CAIXA | RESULT |

## Receita por cliente (REF) — aba `Resumo Faturamento`
Colunas `CLIENTES | FEES | VARIÁVEL`. Carregada em `fato_receita_cliente_mensal`
(`tipo_receita` = FEE / VARIAVEL), período 2026. Clientes: LOCALIZA, PORTO SEGURO,
AMBEV, TECBAN, BVS, DOLARAPP, SHEIN, EUROFARMA, GOMES DA COSTA, SIEMENS, ZEISS, BMG…

## Histórico anual 2018–2025 — abas `Resumo NN a 26`
Os anos anteriores a 2026 existem como **totais anuais** nas abas de resumo. São
carregados (`ingestao/history.py`) como um ponto em **dezembro** de cada ano, para as
5 linhas-chave. Cobertura por empresa: REF/BD/4PR **2018→**, Viv **2021→**, Zup **2025→**.

## Janela de dados de 2026
As planilhas trazem o ano inteiro de 2026. Os meses **jan–jun** são realizados; **jul–dez**
são projeção (cauda repetida). A carga do blueprint (`fato_dre_mensal`) é **fiel à planilha**
(12 meses), o que reproduz os totais "TOTAL 2026" (critério de reprodutibilidade, R$ 0,01).
O cockpit customizado (visão executiva) filtra para os realizados jan–jun.

## Reconciliação (critério de aceite §6.5)
`SUM(RECEITA BRUTA REF, 2026)` no banco = **R$ 94.215.954,69** = "TOTAL 2026" da aba Resumo. ✓
