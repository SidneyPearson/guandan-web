@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本，然后重新打开此文件。
  pause
  exit /b 1
)
if not exist node_modules\socket.io\package.json (
  call npm ci --omit=dev --no-fund --no-audit
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo 同一 Wi-Fi 联机服务运行期间，请保持此窗口打开。按 Ctrl+C 停止服务。
node server\index.cjs --mode=lan
pause
