# windows_expose.ps1 — habilita o acesso ao cockpit (Grafana) pelo IP público do
# servidor Windows. RODE COMO ADMINISTRADOR (PowerShell > "Executar como administrador").
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows_expose.ps1
#   # ou, para liberar SÓ para o IP do cliente (recomendado):
#   powershell -ExecutionPolicy Bypass -File deploy\windows_expose.ps1 -ClientIP 200.x.x.x
#
# O que faz: (1) libera a porta 3000 no Firewall do Windows; (2) reinicia o Grafana
# aplicando conf/custom.ini (bind 0.0.0.0 + login obrigatório + provisioning).
param([string]$ClientIP = "")
$ErrorActionPreference = 'Stop'

# 1) Firewall do Windows — liberar inbound TCP 3000
if (-not (Get-NetFirewallRule -DisplayName 'Cockpit-Grafana-3000' -ErrorAction SilentlyContinue)) {
  $a = @{ DisplayName='Cockpit-Grafana-3000'; Direction='Inbound'; Protocol='TCP'; LocalPort=3000; Action='Allow'; Profile='Any' }
  if ($ClientIP) { $a['RemoteAddress'] = $ClientIP }
  New-NetFirewallRule @a | Out-Null
  "Firewall: porta 3000 liberada" + $(if ($ClientIP) { " apenas para $ClientIP" } else { " (para qualquer origem — restrinja com -ClientIP)" })
} else {
  "Firewall: regra 'Cockpit-Grafana-3000' já existe"
}

# 2) Reiniciar o Grafana para aplicar custom.ini (0.0.0.0, anônimo OFF)
Get-Process grafana, grafana-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$gh = 'C:\Users\Administrator\gf'
Start-Process -FilePath "$gh\bin\grafana-server.exe" -ArgumentList '--homepath', $gh -WindowStyle Hidden
Start-Sleep -Seconds 7
$bind = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).LocalAddress -join ','
$ip = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 8 -ErrorAction SilentlyContinue)
""
"Grafana reiniciado. bind=$bind (esperado 0.0.0.0)."
"Acesse:  http://$ip:3000/d/cockpit-ref   (login: cliente / [redacted])"
""
"IMPORTANTE: se o servidor tiver firewall do PROVEDOR de nuvem (security group),"
"libere a porta 3000 inbound lá também. E como é HTTP (sem criptografia), prefira"
"restringir ao IP do cliente (-ClientIP) ou habilitar HTTPS no Grafana."
