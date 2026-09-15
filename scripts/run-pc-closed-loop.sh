#!/usr/bin/env bash
# run-pc-closed-loop.sh — PC 端入网闭环三项真跑验证 (顺序执行, 各自独立起服务)
#   ① verify-pc-gateway-join.ts     确定性: 真 HTTP + 真 registry + 真 P2P
#   ② verify-gateway-join-agent.ts   真 LLM 在环: agent 自己读入网说明并加入
#   ③ verify-agent-delegate-real.ts  真两节点 P2P: 被委派端真执行 + 结果落 CID
# 日志: $HOME/bolloon-logs/pc-*.log
set -uo pipefail
cd "$(dirname "$0")/.."
L="$HOME/bolloon-logs"; mkdir -p "$L"

run() {  # run <标签> <日志名> <命令...>
  local label="$1"; shift; local log="$1"; shift
  echo "===== $label ====="
  { "$@"; echo "EXIT=$?"; } > "$L/$log" 2>&1
  grep -E "✅|❌|结果|EXIT=|passed|failed" "$L/$log" | tail -22
  echo
}

run "① 确定性闭环 verify-pc-gateway-join.ts"      pc-1-deterministic.log npx tsx scripts/verify-pc-gateway-join.ts
run "② 真 LLM 闭环 verify-gateway-join-agent.ts"  pc-2-agent-llm.log     npx tsx scripts/verify-gateway-join-agent.ts
run "③ 真两节点被委派 verify-agent-delegate-real.ts" pc-3-delegate-real.log npx tsx scripts/verify-agent-delegate-real.ts

echo "全部日志在 $L/pc-*.log"
