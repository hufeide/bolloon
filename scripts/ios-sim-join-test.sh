#!/usr/bin/env bash
# ios-sim-join-test.sh — 在 iOS 模拟器里真点「一键入网」并留证 (2026-09-15)
#
# 做什么:
#   ① 把 scripts/ios-join-probe.js 注入**构建产物** App.app/public (不污染仓库源码)
#   ② 装进已启动的模拟器并 launch
#   ③ 探针在真 WebView 里: 切到网络页 → 写桌面基址 → 点「一键入网」→ 等真回复
#      → 把结果渲染成全屏 overlay (供截图) 且 document.title = PROBE:phase=…
#   ④ 截图到 $OUT
#
# 前置: npm run ios:sim 已构建; 桌面 server 在跑 (默认 http://127.0.0.1:54188)
# 用法: bash scripts/ios-sim-join-test.sh [桌面基址] [输出目录]
set -euo pipefail
cd "$(dirname "$0")/.."

DESKTOP="${1:-http://127.0.0.1:54188}"
OUT="${2:-/tmp/ios-join-evidence}"
APP="build/dd/Build/Products/Debug-iphonesimulator/App.app"
BUNDLE_ID="com.hibs.bolloon"
export DEVELOPER_DIR="${DEVELOPER_DIR:-$HOME/Downloads/Xcode.app/Contents/Developer}"

[ -d "$APP" ] || { echo "❌ 找不到 $APP — 先跑 npm run ios:sim"; exit 1; }
mkdir -p "$OUT"

echo "① 注入探针 (桌面基址=$DESKTOP)"
sed "s|__DESKTOP_BASE__|$DESKTOP|" scripts/ios-join-probe.js > "$APP/public/ios-join-probe.js"
if ! grep -q "ios-join-probe.js" "$APP/public/index.html"; then
  node -e '
    const fs=require("fs");const p=process.argv[1];
    let h=fs.readFileSync(p,"utf8");
    h=h.replace(/<\/body>/i, "  <script src=\"ios-join-probe.js\"></script>\n</body>");
    fs.writeFileSync(p,h);
    console.log("   index.html 已插入探针脚本");
  ' "$APP/public/index.html"
else
  echo "   index.html 已含探针脚本 (跳过)"
fi

echo "② 安装 + 启动 ($BUNDLE_ID)"
xcrun simctl terminate booted "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install booted "$APP"
xcrun simctl launch booted "$BUNDLE_ID" | head -2

echo "③ 等探针执行 (最多 75s)…"
for i in $(seq 1 15); do
  sleep 5
  xcrun simctl io booted screenshot "$OUT/shot-$i.png" >/dev/null 2>&1 || true
done

echo "④ 收尾截图 + 明细"
xcrun simctl io booted screenshot "$OUT/ios-join-final.png" >/dev/null 2>&1 || true
ls -la "$OUT" | tail -5
echo "✅ 证据目录: $OUT"
