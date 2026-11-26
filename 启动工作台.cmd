@echo off
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 goto failed
for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\find-codex.ps1"`) do set "DEMO_STUDIO_CODEX=%%I"
if not defined DEMO_STUDIO_CODEX (
  echo 未找到 Codex CLI。请安装并登录 Codex 桌面应用后重试。
  goto failed
)
if not exist node_modules\vite\package.json (
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto failed
)
set DEMO_STUDIO_OPEN=1
call npm start
if errorlevel 1 goto failed
exit /b 0

:failed
echo Startup failed. Check Node.js, dependencies, or port 17860.
pause
exit /b 1
