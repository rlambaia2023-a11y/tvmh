# ocultar-tarefas.ps1
# Faz as tarefas agendadas dos nossos sistemas (TV Livre MH, TV Nova,
# Correcao de Provas, Resumo Semanal) rodarem SEM mostrar janela do
# cmd/PowerShell na area de trabalho.
#
# Como funciona: para cada tarefa, cria um lancador .vbs ao lado do script
# original e troca a acao da tarefa para "wscript.exe <lancador>", que executa
# tudo com a janela totalmente oculta (estilo 0). O que a tarefa faz nao muda.
#
# Pode rodar quantas vezes quiser: o que ja estiver oculto e ignorado.
# Os servidores principais sao reiniciados no final para a janela antiga
# (visivel) fechar e a nova (oculta) assumir.

$ErrorActionPreference = "Stop"

$padroes = @("TV Livre", "TV Nova", "Correcao", "Resumo Semanal")

function Write-VbsOculto {
    param(
        [string]$Comando,
        [string]$ArquivoVbs
    )
    # Em VBScript, aspas dentro de uma string viram "" (aspas duplas)
    $cmdVbs = $Comando -replace '"', '""'
    $linha = 'CreateObject("WScript.Shell").Run "' + $cmdVbs + '", 0, False'
    [IO.File]::WriteAllText($ArquivoVbs, $linha + "`r`n", [Text.Encoding]::ASCII)
}

$tarefas = Get-ScheduledTask | Where-Object {
    $n = $_.TaskName
    $achou = $false
    foreach ($p in $padroes) {
        if ($n -like "*$p*") { $achou = $true; break }
    }
    $achou
}

if (-not $tarefas) {
    Write-Output "nenhuma tarefa encontrada"
    exit 0
}

foreach ($t in $tarefas) {
    $nome = $t.TaskName
    $acao = $t.Actions[0]
    $exec = $acao.Execute
    $argumentos = $acao.Arguments
    $pastaTrabalho = $acao.WorkingDirectory

    if ($exec -match '(?i)wscript\.exe$' -and $argumentos -match '-oculto\.vbs') {
        Write-Output "ja oculta: $nome"
        continue
    }

    # Linha de comando original da tarefa (o que ela executa hoje)
    $cmd = '"' + $exec + '"'
    if ($argumentos) { $cmd += ' ' + $argumentos }

    # Pasta onde o .vbs sera criado: working directory da tarefa, ou a pasta
    # do executavel, ou a pasta do primeiro caminho citado nos argumentos.
    $pasta = $pastaTrabalho
    if (-not $pasta -and [IO.Path]::IsPathRooted($exec)) {
        $pasta = Split-Path $exec -Parent
    }
    if (-not $pasta -and $argumentos) {
        $m = [regex]::Match($argumentos, '"([a-zA-Z]:\\[^"]+)"')
        if ($m.Success) { $pasta = Split-Path $m.Groups[1].Value -Parent }
    }
    if (-not $pasta -or -not (Test-Path $pasta)) { $pasta = $env:TEMP }

    $base = (($nome -replace '[^\w\- ]', '').Trim() -replace ' +', ' ')
    $vbs = Join-Path $pasta ($base + "-oculto.vbs")
    Write-VbsOculto -Comando $cmd -ArquivoVbs $vbs

    $novaAcao = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"') -WorkingDirectory $pasta
    Set-ScheduledTask -TaskName $nome -TaskPath $t.TaskPath -Action $novaAcao | Out-Null
    Write-Output "ocultada: $nome"
}

# Reinicia os servidores principais: mata o processo antigo (que ainda tem a
# janela visivel) pela porta que ele escuta e religa a tarefa, que agora sobe
# oculta. So mexe em processo bun/node — nunca em outra coisa.
$servidores = @{
    "TV Livre MH"             = 3001
    "TV Nova"                 = 3002
    "Correcao de Provas Odonto" = 3000
}

foreach ($nome in $servidores.Keys) {
    $tarefaExiste = Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
    if (-not $tarefaExiste) { continue }
    $porta = $servidores[$nome]
    $conn = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match '^(bun|node)$') {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Write-Output "janela antiga fechada (porta $porta)"
            Start-Sleep -Seconds 3
        }
    }
    Start-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
    Write-Output "reiniciada oculta: $nome"
}

Write-Output "pronto: nenhuma janela do cmd vai mais aparecer na area de trabalho"
