# register_task.ps1 — registra o backup diário no Task Scheduler (Blueprint §8).
# Rode UMA vez como Administrador:  powershell -ExecutionPolicy Bypass -File backups\register_task.ps1
$ErrorActionPreference = 'Stop'
$script = 'C:\Users\Administrator\Documents\n8n\backups\pg_backup.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At 03:00            # fora da janela de ingestão (07:00/07:30/08:00)
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -RunLevel Highest
Register-ScheduledTask -TaskName 'CockpitRef-PgBackup' -Action $action -Trigger $trigger -Principal $principal `
  -Description 'Backup diário pg_dump do cockpit_ref, retenção 7 dias (Blueprint §8)' -Force | Out-Null
"OK -> tarefa 'CockpitRef-PgBackup' registrada (diária 03:00)"
