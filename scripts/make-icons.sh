#!/usr/bin/env bash
# 把 src/icons/icon.svg 渲染成扩展清单要的四个尺寸（Chrome 的清单不收 SVG）。
# 用法：CHROME=/path/to/chrome scripts/make-icons.sh ；不给 CHROME 就找 Playwright 缓存里的 headless shell。
set -euo pipefail
cd "$(dirname "$0")/../src/icons"
CHROME="${CHROME:-$(ls ~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | tail -1)}"
[ -x "$CHROME" ] || { echo "找不到 Chromium，用 CHROME= 指一个" >&2; exit 1; }
tmp=$(mktemp --suffix=.html)
trap 'rm -f "$tmp"' EXIT
for s in 16 32 48 128; do
  echo "<body style='margin:0'><img src='file://$PWD/icon.svg' width=$s height=$s style='display:block'>" > "$tmp"
  "$CHROME" --no-sandbox --headless --hide-scrollbars --default-background-color=00000000 \
    --window-size=$s,$s --screenshot="$PWD/icon$s.png" "file://$tmp" >/dev/null 2>&1
  echo "icon$s.png"
done
