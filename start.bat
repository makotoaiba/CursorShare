@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules (
  call npm install --omit=dev || (pause & exit /b 1)
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8787/host"
node server.js
pause
