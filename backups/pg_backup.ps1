# pg_backup.ps1 — backup diário do PostgreSQL no Windows, retenção 7 dias (Blueprint §8).
# Agende no Task Scheduler (diário). Requer pg_dump no PATH.
$ErrorActionPreference = 'Stop'
$dir = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { 'C:\Users\Administrator\Documents\n8n\backups' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$db = if ($env:DB_NAME) { $env:DB_NAME } else { 'cockpit_ref' }
$usr = if ($env:DB_USER) { $env:DB_USER } else { 'cockpit_user' }
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$out = Join-Path $dir "${db}_${stamp}.sql"
# senha NUNCA hardcoded (§8): vem do ambiente ou do .env do projeto
if (-not $env:DB_PASSWORD) {
  $envFile = 'C:\Users\Administrator\Documents\n8n\.env'
  if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^DB_PASSWORD=' } |
      ForEach-Object { $env:DB_PASSWORD = ($_ -split '=', 2)[1].Trim() }
  }
}
if (-not $env:DB_PASSWORD) { throw 'DB_PASSWORD ausente (defina no ambiente ou no .env)' }
$env:PGPASSWORD = $env:DB_PASSWORD
# localizar pg_dump (no Windows raramente está no PATH)
$pgdump = if ($env:PG_BIN) { Join-Path $env:PG_BIN 'pg_dump.exe' } else { 'C:\pg16\pgsql\bin\pg_dump.exe' }
if (-not (Test-Path $pgdump)) { $pgdump = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source }
if (-not $pgdump) { throw 'pg_dump nao encontrado (defina $env:PG_BIN)' }
# pg_dump escreve o arquivo DIRETO (-f): evita o BOM do Out-File e, sobretudo, evita
# gravar um arquivo VAZIO quando o pg_dump falha (ex.: Postgres fora do ar no horário
# agendado). Sem isto, a falha era silenciosa e a retenção apagava o último bom backup.
& $pgdump -U $usr -h '127.0.0.1' -f $out $db
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out) -or (Get-Item $out).Length -eq 0) {
  if (Test-Path $out) { Remove-Item $out -Force }
  throw "pg_dump FALHOU (exit $LASTEXITCODE) - backup abortado; retencao NAO executada (backups antigos preservados)"
}
# Retencao dos 7 dias SO roda apos confirmar um dump valido (nao-vazio).
Get-ChildItem $dir -Filter "${db}_*.sql" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force
"backup ok: $out ($((Get-Item $out).Length) bytes)"
