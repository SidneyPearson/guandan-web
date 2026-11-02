#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
URL="http://127.0.0.1:8896/"

is_ready() {
  curl --noproxy '*' --fail --silent --connect-timeout 1 --max-time 2 \
    "${URL}index.html" | cmp -s - "$PROJECT_DIR/index.html"
}

if ! is_ready; then
  LOG_FILE=$(mktemp "${TMPDIR:-/tmp}/guandan-local.XXXXXX")
  # 独立进程会话：关闭终端或结束开发会话后，网页仍能访问。
  python3 - "$PROJECT_DIR" "$LOG_FILE" <<'PY'
import subprocess
import sys

with open(sys.argv[2], "a") as log:
    subprocess.Popen(
        [sys.executable, "-u", "-m", "http.server", "8896",
         "--bind", "127.0.0.1", "--directory", sys.argv[1]],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
PY
  attempt=0
  while ! is_ready; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      printf '启动失败。请检查 8896 端口是否被其他程序占用。日志：%s\n' "$LOG_FILE" >&2
      cat "$LOG_FILE" >&2
      exit 1
    fi
    sleep 0.1
  done
fi

printf '掼蛋已就绪：%s\n服务在后台运行，可关闭此终端。电脑重启后，再双击此文件即可。\n' "$URL"
if [ "${1:-}" != "--no-open" ]; then
  open "$URL"
fi
