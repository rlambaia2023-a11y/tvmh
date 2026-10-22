@echo off
REM TV Livre MH - servico (usado pela tarefa agendada). Nao fechar esta janela manualmente.
cd /d "C:\tvlivreMH"
"%USERPROFILE%\.bun\bin\bun.exe" run server.ts >> "C:\tvlivreMH\logs\tv.log" 2>&1
