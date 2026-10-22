@echo off
REM Vigia da TV Livre MH: se o servidor nao responder, inicia de novo.
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3001/health' -TimeoutSec 8; if ($r.StatusCode -ne 200) { throw 'down' } } catch { Start-ScheduledTask -TaskName 'TV Livre MH' }" >nul 2>&1
