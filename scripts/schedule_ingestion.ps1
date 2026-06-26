# =============================================================================
# schedule_ingestion.ps1 — agenda a ingestão diária + o monitor (Windows Task Scheduler)
# =============================================================================
# Suporta o critério da Fase 1: "pipeline rodando 10 dias sem intervenção manual".
# Registra duas tarefas agendadas:
#   - CockpitIngestao : roda scripts\run_ingestion.py todo dia às 05:30
#   - CockpitMonitor  : roda scripts\monitor_pipeline.py de hora em hora (heartbeat/alerta)
#
# Uso (PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\scripts\schedule_ingestion.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\schedule_ingestion.ps1 -Remove
# =============================================================================
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$root   = Split-Path -Parent $PSScriptRoot
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { Write-Error "python não está no PATH."; exit 1 }

$ingestTask  = "CockpitIngestao"
$monitorTask = "CockpitMonitor"

if ($Remove) {
  foreach ($t in @($ingestTask, $monitorTask)) {
    schtasks /Delete /TN $t /F 2>$null
    Write-Host "Removida tarefa $t (se existia)."
  }
  exit 0
}

# Variáveis de ambiente do banco (ajuste conforme seu ambiente).
$envPrefix = '$env:PGHOST=''127.0.0.1''; $env:PGPORT=''5432''; $env:PGDATABASE=''cockpit''; $env:PGUSER=''postgres''; $env:PGPASSWORD=''postgres'';'

# --- CockpitIngestao : diário 05:30 ---------------------------------------------
$ingestCmd = "$envPrefix `"$python`" `"$root\scripts\run_ingestion.py`""
schtasks /Create /TN $ingestTask /SC DAILY /ST 05:30 /F `
  /TR "powershell -NoProfile -WindowStyle Hidden -Command `"$ingestCmd`"" | Out-Null
Write-Host "OK -> tarefa '$ingestTask' criada (diária 05:30)."

# --- CockpitMonitor : de hora em hora -------------------------------------------
$monCmd = "$envPrefix `"$python`" `"$root\scripts\monitor_pipeline.py`""
schtasks /Create /TN $monitorTask /SC HOURLY /F `
  /TR "powershell -NoProfile -WindowStyle Hidden -Command `"$monCmd`"" | Out-Null
Write-Host "OK -> tarefa '$monitorTask' criada (de hora em hora)."

Write-Host ""
Write-Host "Verifique:  schtasks /Query /TN $ingestTask"
Write-Host "Rodar já :  schtasks /Run   /TN $ingestTask"
Write-Host ""
Write-Host "O relógio dos 10 dias começa a contar a partir da primeira execução agendada."
Write-Host "Alternativa: ativar o Schedule Trigger do workflow n8n (01_ingestao_planilhas)."
