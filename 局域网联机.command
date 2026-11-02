#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  printf '请先安装 Node.js 22 或更新版本，然后重新打开此文件。\n'
  exit 1
fi
if ! node -e "require('socket.io')" >/dev/null 2>&1; then
  printf '首次使用，正在安装联机服务依赖…\n'
  npm ci --omit=dev --no-fund --no-audit
fi
exec node tools/start-online.cjs
