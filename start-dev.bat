@echo off
setlocal

cd /d "%~dp0"

echo Starting AI Mock Interview backend on http://127.0.0.1:8000
start "AI Mock Interview Backend" cmd /k ""%~dp0start-backend.bat""

echo Starting AI Mock Interview frontend on http://127.0.0.1:5175
start "AI Mock Interview Frontend" cmd /k ""%~dp0start-frontend.bat""

echo.
echo Wait until the frontend terminal says Local: http://127.0.0.1:5175/
echo Then open http://127.0.0.1:5175/ in your browser.
echo.
pause
