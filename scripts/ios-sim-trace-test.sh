#!/usr/bin/env bash
# ios-sim-trace-test.sh — 在 iOS 模拟器里验证「智能体操作轨迹 (.agent-trace)」真渲染并留证
#
# 与 ios-sim-join-test.sh 同套路: 探针只注入**构建产物** App.app/public (不动仓库源码)。
#   ① 清掉之前注入过的其它探针 (避免两个探针抢点同一个按钮)
#   ② 注入 scripts/ios-trace-probe.js (桌面基址可传参)
#   ③ 装进已启动的模拟器并 launch
#   ④ 每 5s 截一张图 → $OUT (最后一张应是 phase=trace-ok 的 overlay: 轨迹行数 + 每行文本)
#
# 前置: npm run ios:sim 已构建; 桌面 server 可选 (在跑则入网登记的步骤为 ✓)
# 用法: bash scripts/ios-sim-trace-test.sh [桌面基址] [输出目录]
set -euo pipefail
cd "$(dirname "$0")/.."

DESKTOP="${1:-http://127.0.0.1:54188}"
OUT="${2:-$HOME/ios-trace-evidence}"
APP="build/dd/Build/Products/Debug-iphonesimulator/App.app"
BUNDLE_ID="com.hibs.bolloon"
export DEVELOPER_DIR="${DEVELOPER_DIR:-$HOME/Downloads/Xcode.app/Contents/Developer}"

[ -d "$APP" ] || { echo "❌ 找不到 $APP — 先跑 npm run ios:sim"; exit 1; }
mkdir -p "$OUT"

echo "① 清掉旧探针 + 注入轨迹探针 (桌面基址=$DESKTOP)"
rm -f "$APP/public/ios-join-probe.js"
sed "s|__DESKTOP_BASE__|$DESKTOP|" scripts/ios-trace-probe.js > "$APP/public/ios-trace-probe.js"
node -e '
  const fs = require("fs"); const p = process.argv[1];
  let h = fs.readFileSync(p, "utf8");
  h = h.replace(/[ \t]*<script src="ios-join-probe\.js"><\/script>\n?/g, "");
  if (!h.includes("ios-trace-probe.js")) h = h.replace(/<\/body>/i, "  <script src=\"ios-trace-probe.js\"></script>\n</body>");
  fs.writeFileSync(p, h);
  console.log("   index.html 已注入:", h.includes("ios-trace-probe.js"));
' "$APP/public/index.html"

echo "② 安装 + 启动 ($BUNDLE_ID)"
xcrun simctl terminate booted "$BUNDLE_ID" >/dev/null 2>&1 || true
# 关键: 先卸载 — 否则 WebView 的 Service Worker 会拿旧缓存里的 index.html/探针 运行
# (2026-09-16 实测: 不卸载时跑的还是上一次注入的探针)
xcrun simctl uninstall booted "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install booted "$APP"
xcrun simctl launch booted "$BUNDLE_ID" | head -2

echo "③ 等探针跑出轨迹 (最多 90s, 每 5s 一张图)…"
for i in $(seq 1 18); do
  sleep 5
  xcrun simctl io booted screenshot "$OUT/shot-$i.png" >/dev/null 2>&1 || true
done

echo "④ 收尾截图"
xcrun simctl io booted screenshot "$OUT/ios-trace-final.png" >/dev/null 2>&1 || true
ls -la "$OUT" | tail -4
echo "✅ 证据目录: $OUT"
