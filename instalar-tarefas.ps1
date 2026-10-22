# Cria/atualiza as tarefas agendadas da TV Livre MH e a regra de firewall.
$ErrorActionPreference = "Stop"

# 1) Firewall: libera a porta 3001 (TCP) para a rede local/tailnet
$regra = Get-NetFirewallRule -DisplayName "TV Livre MH" -ErrorAction SilentlyContinue
if (-not $regra) {
  New-NetFirewallRule -DisplayName "TV Livre MH" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow | Out-Null
  Write-Output "firewall: regra criada (TCP 3001)"
} else {
  Write-Output "firewall: regra ja existe"
}

# 2) Tarefa principal: inicia a TV 30s apos o login
$acao = New-ScheduledTaskAction -Execute "C:\tvlivreMH\iniciar-servico.bat" -WorkingDirectory "C:\tvlivreMH"
$gatilho = New-ScheduledTaskTrigger -AtLogOn -RandomDelay (New-TimeSpan -Seconds 30)
$conf = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TV Livre MH" -Action $acao -Trigger $gatilho -Settings $conf -Force | Out-Null
Write-Output "tarefa 'TV Livre MH' registrada"

# 3) Vigia: a cada 5 min, religa o servidor se ele caiu
$vigiaBat = "C:\tvlivreMH\vigia.bat"
$acaoVigia = New-ScheduledTaskAction -Execute $vigiaBat -WorkingDirectory "C:\tvlivreMH"
$gatilhoVigia = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$confVigia = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "TV Livre MH Vigia" -Action $acaoVigia -Trigger $gatilhoVigia -Settings $confVigia -Force | Out-Null
Write-Output "tarefa 'TV Livre MH Vigia' registrada"
Write-Output "instalacao concluida"
