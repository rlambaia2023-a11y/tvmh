@echo off
REM TV Livre MH - inicia o servidor da TV
REM Deixe esta janela aberta enquanto assiste. Depois abra http://localhost:3001
cd /d "%~dp0"
where bun >nul 2>nul
if errorlevel 1 (
  echo [TV Livre MH] Bun nao encontrado. Instale em https://bun.sh e rode de novo.
  pause
  exit /b 1
)
echo [TV Livre MH] Ligando a TV em http://localhost:3001 ...
bun run server.ts
pause
