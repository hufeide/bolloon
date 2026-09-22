#!/usr/bin/env bash
# 一键启动本地 bolloon web(含源码改动) 并跑通 setup 连通性门禁。
#
# 用法:
#   npm run web:local
#   BOLLOON_HOST=0.0.0.0 npm run web:local   # 绑定所有网卡(手机/局域网可访问, 注意安全)
#
# 说明:
#   - 默认只绑 127.0.0.1; 要局域网访问设 BOLLOON_HOST=0.0.0.0 再跑。
#   - 会先停掉旧的本地 web 实例(匹配 "src/index.ts --web"), 避免端口冲突。
#   - 启动后用 POST /api/setup/test 把初始化门禁翻成 ready, 否则桌面聊天发消息会 503 "发送失败"。
set -euo pipefail

cd "$(dirname "$0")/.."

LOG="${BOLLOON_WEB_LOG:-/tmp/bolloon-web.log}"

echo "[web:local] 1/5 构建前端(把 src/web 改动打进 dist/web)..."
npm run build:web

echo "[web:local] 2/5 停掉旧的本地 web 实例..."
pkill -f "src/index.ts --web" 2>/dev/null || true
sleep 1

echo "[web:local] 3/5 后台启动本地服务(setsid 脱离会话)..."
: > "$LOG"
setsid bash -c 'exec env BOLLOON_HOST='"${BOLLOON_HOST:-127.0.0.1}"' npx tsx -r dotenv/config src/index.ts --web > "'"$LOG"'" 2>&1' < /dev/null &
disown

# 等端口(BOLLOON_PORT=xxxx 出现在日志)
PORT=""
for i in $(seq 1 90); do
  PORT=$(grep -a -oE 'BOLLOON_PORT=[0-9]+' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)
  if [ -n "$PORT" ]; then break; fi
  if ! kill -0 "$(pgrep -f 'src/index.ts --web' | head -1)" 2>/dev/null; then
    echo "[web:local] 进程已退出, 启动失败。末尾日志:"
    tail -25 "$LOG" || true
    exit 1
  fi
  sleep 1
done
if [ -z "$PORT" ]; then
  echo "[web:local] 等待端口超时, 末尾日志:"
  tail -25 "$LOG" || true
  exit 1
fi
echo "[web:local]     服务已起: http://${BOLLOON_HOST:-127.0.0.1}:$PORT"

# 等 HTTP 通
for i in $(seq 1 30); do
  if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 1
done

echo "[web:local] 4/5 跑 setup 连通性实测(翻门禁, 否则发消息 503)..."
curl -s --max-time 120 -X POST "http://127.0.0.1:$PORT/api/setup/test" \
  -H 'Content-Type: application/json' -d '{}' \
  | grep -a -oE '"gate":"[a-z]+"|"allow":\{[^}]*\}' | head -3 || true

GATE=$(curl -s --max-time 6 "http://127.0.0.1:$PORT/api/setup" | grep -a -oE '"gate":"[a-z]+"' | head -1 || true)
echo "[web:local]     setup gate: ${GATE:-未知}"

echo "[web:local] 5/5 完成 → 打开 http://${BOLLOON_HOST:-127.0.0.1}:$PORT/  (首次请硬刷新清缓存)"
echo "[web:local]     日志: $LOG"
