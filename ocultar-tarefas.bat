@echo off
REM Oculta as janelas do cmd das tarefas agendadas (TV Livre MH, TV Nova,
REM Correcao de Provas). Basta dar dois cliques neste arquivo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ocultar-tarefas.ps1"
echo.
pause
