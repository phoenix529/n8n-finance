<#
.SYNOPSIS
    Sobe um servidor estatico local para o dashboard do Cockpit Financeiro Estrategico.

.DESCRIPTION
    Serve a pasta dashboard\ (index.html + app.js + styles.css + dashboard_data.json)
    em http://localhost:<Port> usando o servidor HTTP embutido do Python:
        python -m http.server <Port> --directory <dashboard>
    O dashboard le APENAS dashboard\dashboard_data.json e funciona 100% offline.
    Se atualizar dados, rode antes: python .\data\generate_data.py (recopia o JSON).

.PARAMETER Port
    Porta HTTP (default 8088, conforme o pedido de ops).

.PARAMETER NoBrowser
    Nao abre o navegador automaticamente.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\serve_dashboard.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\serve_dashboard.ps1 -Port 9090 -NoBrowser
#>

[CmdletBinding()]
param(
    [int]    $Port = 8088,
    [switch] $NoBrowser
)

$ErrorActionPreference = "Stop"

$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot  = Split-Path -Parent $ScriptDir
$DashboardDir = Join-Path $ProjectRoot "dashboard"
$DataFile     = Join-Path $DashboardDir "dashboard_data.json"
$Url          = "http://localhost:$Port"

function Write-Info([string]$m){ Write-Host "    $m" -ForegroundColor Gray }
function Write-Ok  ([string]$m){ Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "    [aviso] $m" -ForegroundColor Yellow }

Write-Host ""
Write-Host "#############################################################" -ForegroundColor White
Write-Host "#  Dashboard - Cockpit Financeiro Estrategico (Grupo Aurora) #" -ForegroundColor White
Write-Host "#############################################################" -ForegroundColor White
Write-Info "Pasta servida : $DashboardDir"
Write-Info "URL           : $Url"

# --- Validacoes ---
if (-not (Test-Path $DashboardDir)) {
    throw "Pasta do dashboard nao encontrada: $DashboardDir"
}
if (-not (Test-Path (Join-Path $DashboardDir "index.html"))) {
    Write-Warn2 "index.html nao encontrado em $DashboardDir (o dashboard ainda foi gerado?)."
}
if (-not (Test-Path $DataFile)) {
    Write-Warn2 "dashboard_data.json ausente."
    Write-Warn2 "Rode primeiro: python .\data\generate_data.py"
} else {
    Write-Ok "dashboard_data.json encontrado."
}

# --- Localizar Python ---
$PythonCmd = $null
foreach ($cand in @("python","py","python3")) {
    $found = Get-Command $cand -ErrorAction SilentlyContinue
    if ($found) { $PythonCmd = $found.Source; break }
}
if (-not $PythonCmd) {
    throw "Python nao encontrado no PATH. Instale Python 3.10+ (marque 'Add to PATH') e tente novamente."
}
Write-Ok "Python: $PythonCmd"

# --- Abrir navegador (best-effort) ---
if (-not $NoBrowser) {
    try { Start-Process $Url | Out-Null; Write-Info "Abrindo o navegador em $Url ..." } catch {}
}

Write-Host ""
Write-Ok "Servindo o dashboard. Acesse: $Url"
Write-Info "Pressione Ctrl+C para encerrar o servidor."
Write-Host ""

# --- Servir (bloqueante) ---
# 'py' usa o launcher; demais usam o executavel direto.
if ($PythonCmd -match "py(\.exe)?$") {
    & $PythonCmd -3 -m http.server $Port --directory $DashboardDir --bind 127.0.0.1
} else {
    & $PythonCmd -m http.server $Port --directory $DashboardDir --bind 127.0.0.1
}
