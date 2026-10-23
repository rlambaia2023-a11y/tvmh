# Cria/atualiza as tarefas agendadas da TV Livre MH e a regra de firewall.
# As tarefas rodam OCULTAS: nenhum cmd aparece na area de trabalho.
$ErrorActionPreference = "Stop"

function Write-VbsOculto {
    param([string]$Comando, [string]$ArquivoVbs)
    $cmdVbs = $Comando -replace '"', '""'
    $linha = 'CreateObject("WScript.Shell").Run "' + $cmdVbs + '", 0, False'
    [IO.File]::WriteAllText($ArquivoVbs, $linha + "`r`n", [Text.Encoding]::ASCII)
}

function New-AcaoOculta {
    param([string]$NomeTarefa, [string]$ScriptBat, [string]$Pasta)
    $vbs = Join-Path $Pasta ($NomeTarefa + "-oculto.vbs")
    Write-VbsOculto -Comando ('"' + $ScriptBat + '"') -ArquivoVbs $vbs
    return New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"') -WorkingDirectory $Pasta
}

# 1) Firewall: libera a porta 3001 (TCP) para a rede local/tailnet
$regra = Get-NetFirewallRule -DisplayName "TV Livre MH" -ErrorAction SilentlyContinue
if (-not $regra) {
  New-NetFirewallRule -DisplayName "TV Livre MH" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow | Out-Null
  Write-Output "firewall: regra criada (TCP 3001)"
} else {
  Write-Output "firewall: regra ja existe"
}

# 2) Tarefa principal: inicia a TV 30s apos o login (oculta)
$acao = New-AcaoOculta -NomeTarefa "TV Livre MH" -ScriptBat "C:\tvlivreMH\iniciar-servico.bat" -Pasta "C:\tvlivreMH"
$gatilho = New-ScheduledTaskTrigger -AtLogOn -RandomDelay (New-TimeSpan -Seconds 30)
$conf = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TV Livre MH" -Action $acao -Trigger $gatilho -Settings $conf -Force | Out-Null
Write-Output "tarefa 'TV Livre MH' registrada (oculta)"

# 3) Vigia: a cada 5 min, religa o servidor se ele caiu (oculto)
$acaoVigia = New-AcaoOculta -NomeTarefa "TV Livre MH Vigia" -ScriptBat "C:\tvlivreMH\vigia.bat" -Pasta "C:\tvlivreMH"
$gatilhoVigia = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$confVigia = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "TV Livre MH Vigia" -Action $acaoVigia -Trigger $gatilhoVigia -Settings $confVigia -Force | Out-Null
Write-Output "tarefa 'TV Livre MH Vigia' registrada (oculta)"
Write-Output "instalacao concluida"
