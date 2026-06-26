# restart_grafana.ps1 — reinicia o Grafana aplicando conf/custom.ini
# (bind 127.0.0.1 · acesso anônimo OFF · provisioning do projeto · senha do datasource no .yaml gitignored).
# Requer privilégio de Administrador para encerrar o processo atual.
#   powershell -ExecutionPolicy Bypass -File grafana\restart_grafana.ps1
$ErrorActionPreference = 'SilentlyContinue'
Get-Process grafana, grafana-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$gh = 'C:\Users\Administrator\gf'
Start-Process -FilePath "$gh\bin\grafana-server.exe" -ArgumentList '--homepath', $gh -WindowStyle Hidden
Start-Sleep -Seconds 6
try {
  $h = (Invoke-WebRequest 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 8).StatusCode
  $bind = (Get-NetTCPConnection -LocalPort 3000 -State Listen).LocalAddress -join ','
  "grafana up: health=$h  bind=$bind  (esperado 127.0.0.1)"
} catch { "grafana ainda subindo / verifique: $($_.Exception.Message)" }
