<#
.SYNOPSIS
    Bootstrap do PostgreSQL 16 portátil (EDB) para o Cockpit Financeiro Estratégico.

.DESCRIPTION
    Baixa os binários portáteis do PostgreSQL 16 (zip do EDB), roda initdb, sobe o
    servidor, cria o banco "cockpit" e aplica os SQLs do projeto:
        db\schema.sql  ->  db\rbac.sql  ->  db\seed_reference.sql
    Script IDEMPOTENTE: pode ser re-executado com segurança (pula etapas já feitas).

    NOTA pgvector (Windows): os binários EDB NAO incluem a extensao "vector".
    Veja a funcao Show-PgvectorFallbackNote (impressa ao final) com as 3 opcoes:
        A) prebuilt DLL    B) build MSVC    C) Docker/WSL (recomendado).
    A Fase 1 funciona sem pgvector; a Fase 2 (RAG) exige a extensao.

.PARAMETER Port
    Porta do PostgreSQL (default 5432).

.PARAMETER DbName
    Nome do banco (default "cockpit"). Conforme SPEC.md.

.PARAMETER SuperUser
    Superusuario do cluster (default "postgres").

.PARAMETER PgPassword
    Senha do superusuario (default "postgres"). Em producao, passe um valor seguro.

.PARAMETER SkipDownload
    Nao baixa binarios (use se ja existirem em scripts\.pg\pgsql).

.PARAMETER IngestOnly
    Apenas garante o servidor no ar e aplica os SQLs (sem re-download/initdb).
    Util para reaproveitar como passo agendado de carga/refresh.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap_postgres.ps1
#>

[CmdletBinding()]
param(
    [int]    $Port         = 5432,
    [string] $DbName       = "cockpit",
    [string] $SuperUser    = "postgres",
    [string] $PgPassword   = "postgres",
    [switch] $SkipDownload,
    [switch] $IngestOnly
)

$ErrorActionPreference = "Stop"

# --- Caminhos (todos relativos a raiz do projeto, derivada da pasta deste script) ---
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$PgRoot      = Join-Path $ScriptDir ".pg"          # tudo do Postgres portatil vive aqui
$PgZip       = Join-Path $PgRoot   "postgresql-16-windows-x64-binaries.zip"
$PgBinDir    = Join-Path $PgRoot   "pgsql\bin"
$PgDataDir   = Join-Path $PgRoot   "data"
$PgLogFile   = Join-Path $PgRoot   "server.log"
$PwFile      = Join-Path $PgRoot   "pgpass.txt"

# URL dos binarios portateis do EDB (PostgreSQL 16 x64).
$EdbUrl = "https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip"

$DbSchema = Join-Path $ProjectRoot "db\schema.sql"
$DbRbac   = Join-Path $ProjectRoot "db\rbac.sql"
$DbSeed   = Join-Path $ProjectRoot "db\seed_reference.sql"

function Write-Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok  ([string]$msg) { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Info([string]$msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Write-Warn2([string]$msg){ Write-Host "    [aviso] $msg" -ForegroundColor Yellow }

function Show-PgvectorFallbackNote {
    Write-Host ""
    Write-Host "------------------------------------------------------------------" -ForegroundColor Yellow
    Write-Host " NOTA pgvector no Windows (necessario para a Fase 2 / RAG)" -ForegroundColor Yellow
    Write-Host "------------------------------------------------------------------" -ForegroundColor Yellow
    Write-Host " Os binarios EDB NAO trazem a extensao 'vector'. Escolha UMA opcao:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  A) PREBUILT (mais rapido no Windows nativo):" -ForegroundColor Yellow
    Write-Host "     - Baixe a DLL 'vector' compativel com PG16." -ForegroundColor Yellow
    Write-Host "     - Copie vector.dll          -> $PgRoot\pgsql\lib\" -ForegroundColor Yellow
    Write-Host "     - Copie vector*.sql/.control -> $PgRoot\pgsql\share\extension\" -ForegroundColor Yellow
    Write-Host "     - Depois: psql -d $DbName -c 'CREATE EXTENSION vector;'" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  B) BUILD (MSVC) se nao houver prebuilt:" -ForegroundColor Yellow
    Write-Host "     - Visual Studio Build Tools + 'nmake /F Makefile.win' no repo pgvector;" -ForegroundColor Yellow
    Write-Host "       instale os artefatos como na opcao A." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  C) DOCKER / WSL (RECOMENDADO se Docker disponivel):" -ForegroundColor Yellow
    Write-Host "     docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16" -ForegroundColor Yellow
    Write-Host "     (aponte PGHOST=localhost; dispensa build no host)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host " A Fase 1 (ingestao/consolidacao) funciona SEM pgvector." -ForegroundColor Yellow
    Write-Host "------------------------------------------------------------------" -ForegroundColor Yellow
}

# ==================================================================================
Write-Host ""
Write-Host "############################################################" -ForegroundColor White
Write-Host "#  Bootstrap PostgreSQL 16 - Cockpit Financeiro Estrategico #" -ForegroundColor White
Write-Host "############################################################" -ForegroundColor White
Write-Info "Projeto : $ProjectRoot"
Write-Info "PG root : $PgRoot"
Write-Info "Porta   : $Port    Banco: $DbName    Superusuario: $SuperUser"

New-Item -ItemType Directory -Force -Path $PgRoot | Out-Null

# --- [1/7] Baixar binarios (idempotente) ---
Write-Step "[1/7] Verificar/baixar PostgreSQL 16 (EDB zip)"
if ($IngestOnly) { $SkipDownload = $true }

if (Test-Path $PgBinDir) {
    Write-Ok "Binarios ja presentes em $PgBinDir (pulando download)."
}
elseif ($SkipDownload) {
    Write-Warn2 "SkipDownload/IngestOnly ativo, mas binarios nao encontrados em $PgBinDir."
}
else {
    if (-not (Test-Path $PgZip)) {
        Write-Info "Baixando: $EdbUrl"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $EdbUrl -OutFile $PgZip -UseBasicParsing
            Write-Ok "Download concluido: $PgZip"
        } catch {
            Write-Warn2 "Falha no download automatico ($($_.Exception.Message))."
            Write-Warn2 "Baixe manualmente o zip dos binarios PG16 x64 do EDB e salve em:"
            Write-Warn2 "  $PgZip"
            Write-Warn2 "Depois re-execute este script."
            throw
        }
    } else {
        Write-Ok "Zip ja baixado: $PgZip"
    }
    Write-Info "Extraindo binarios..."
    Expand-Archive -Path $PgZip -DestinationPath $PgRoot -Force
    if (-not (Test-Path $PgBinDir)) { throw "Extracao nao produziu $PgBinDir." }
    Write-Ok "Binarios extraidos em $PgBinDir"
}

$Initdb = Join-Path $PgBinDir "initdb.exe"
$PgCtl  = Join-Path $PgBinDir "pg_ctl.exe"
$Psql   = Join-Path $PgBinDir "psql.exe"
$CreateDb = Join-Path $PgBinDir "createdb.exe"
foreach ($exe in @($Initdb,$PgCtl,$Psql)) {
    if (-not (Test-Path $exe)) { throw "Executavel ausente: $exe (binarios incompletos?)" }
}

# --- [2/7] initdb (idempotente) ---
Write-Step "[2/7] initdb do cluster"
if (Test-Path (Join-Path $PgDataDir "PG_VERSION")) {
    Write-Ok "Cluster ja inicializado em $PgDataDir (pulando initdb)."
}
elseif ($IngestOnly) {
    Write-Warn2 "IngestOnly ativo e cluster inexistente; rode o bootstrap completo antes."
}
else {
    Set-Content -Path $PwFile -Value $PgPassword -NoNewline -Encoding ascii
    Write-Info "Executando initdb (UTF8, autenticacao md5)..."
    & $Initdb -D $PgDataDir -U $SuperUser --pwfile=$PwFile -E UTF8 --auth=md5 | Out-Null
    Remove-Item $PwFile -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $PgDataDir "PG_VERSION"))) { throw "initdb falhou." }
    Write-Ok "Cluster inicializado em $PgDataDir"
}

# --- [3/7] Iniciar servidor (idempotente) ---
Write-Step "[3/7] Iniciar servidor PostgreSQL (porta $Port)"
$status = & $PgCtl -D $PgDataDir status 2>$null
if ($LASTEXITCODE -eq 0 -and $status -match "server is running") {
    Write-Ok "Servidor ja esta em execucao."
} else {
    Write-Info "Subindo servidor (log: $PgLogFile)..."
    & $PgCtl -D $PgDataDir -l $PgLogFile -o "-p $Port" -w start | Out-Null
    Start-Sleep -Seconds 2
    $status = & $PgCtl -D $PgDataDir status 2>$null
    if ($LASTEXITCODE -ne 0 -or -not ($status -match "server is running")) {
        Write-Warn2 "Nao foi possivel confirmar o servidor. Verifique $PgLogFile"
        throw "Falha ao iniciar o PostgreSQL."
    }
    Write-Ok "Servidor no ar na porta $Port."
}

# Ambiente para psql/createdb (evita prompt de senha)
$env:PGPASSWORD = $PgPassword
$env:PGHOST     = "localhost"
$env:PGPORT     = "$Port"
$env:PGUSER     = $SuperUser

# --- [4/7] Criar banco (idempotente) ---
Write-Step "[4/7] Criar banco '$DbName'"
$exists = & $Psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName';"
if ($exists -match "1") {
    Write-Ok "Banco '$DbName' ja existe."
} else {
    & $CreateDb -O $SuperUser $DbName
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o banco '$DbName'." }
    Write-Ok "Banco '$DbName' criado."
}

# Tenta habilitar pgvector (nao fatal). A Fase 2 precisa; a Fase 1 nao.
Write-Info "Tentando habilitar extensao 'vector' (pgvector)..."
& $Psql -d $DbName -c "CREATE EXTENSION IF NOT EXISTS vector;" *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Extensao 'vector' disponivel."
    $script:PgVectorOk = $true
} else {
    Write-Warn2 "Extensao 'vector' indisponivel nestes binarios (esperado no EDB)."
    Write-Warn2 "A Fase 2 (RAG) exige pgvector -> veja a nota de fallback ao final."
    $script:PgVectorOk = $false
}

# --- Helper para aplicar um .sql ---
function Invoke-Sql([string]$file, [string]$label) {
    if (-not (Test-Path $file)) {
        Write-Warn2 "Arquivo nao encontrado: $file (pulando $label)."
        return
    }
    Write-Info "Aplicando $label : $file"
    & $Psql -d $DbName -v ON_ERROR_STOP=1 -f $file
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "psql retornou erro ao aplicar $label."
        if ($label -eq "schema.sql" -and -not $script:PgVectorOk) {
            Write-Warn2 "Provavel causa: kb_embeddings exige 'vector'. Instale pgvector e re-rode."
        }
        throw "Falha ao aplicar $label."
    }
    Write-Ok "$label aplicado."
}

# --- [5/7] schema.sql ---
Write-Step "[5/7] Aplicar db\schema.sql"
Invoke-Sql $DbSchema "schema.sql"

# --- [6/7] rbac.sql ---
Write-Step "[6/7] Aplicar db\rbac.sql"
Invoke-Sql $DbRbac "rbac.sql"

# --- [7/7] seed_reference.sql ---
Write-Step "[7/7] Aplicar db\seed_reference.sql"
Invoke-Sql $DbSeed "seed_reference.sql"

# --- Resumo ---
Write-Step "Concluido"
Write-Ok "PostgreSQL '$DbName' pronto em localhost:$Port (usuario $SuperUser)."
Write-Info "psql:    `"$Psql`" -h localhost -p $Port -U $SuperUser -d $DbName"
Write-Info "parar:   `"$PgCtl`" -D `"$PgDataDir`" stop"
Write-Info "log:     $PgLogFile"
Write-Host ""
Write-Info "Proximos passos:"
Write-Info "  python .\data\generate_data.py      # gera dados + dashboard_data.json"
Write-Info "  .\scripts\serve_dashboard.ps1       # serve o dashboard em http://localhost:8088"

if (-not $script:PgVectorOk) { Show-PgvectorFallbackNote }

Write-Host ""
Write-Ok "Bootstrap finalizado."
