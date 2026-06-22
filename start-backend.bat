@echo off
cd /d "%~dp0backend"
"%~dp0venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8000
echo.
echo Backend stopped. If this was unexpected, copy the error above and send it to Codex.
pause
