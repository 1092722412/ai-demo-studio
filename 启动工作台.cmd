@echo off
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 goto failed
if not exist node_modules\vite\package.json (
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto failed
)
if not exist dist\index.html (
  call npm run build
  if errorlevel 1 goto failed
)
set DEMO_STUDIO_OPEN=1
node server\studio.mjs
if errorlevel 1 goto failed
exit /b 0

:failed
echo Startup failed. Check Node.js, dependencies, or port 17860.
pause
exit /b 1
