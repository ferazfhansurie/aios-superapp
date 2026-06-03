#!/usr/bin/env bash
# frame.sh — wrap a raw screenshot in a premium rounded frame on a dark gradient,
# matching the cover aesthetic. Renders via headless Chrome at 2x.
#
# usage: ./frame.sh <input.png> <output.png> [bar]
#   pass a 3rd arg "bar" to add a macOS traffic-light titlebar (skip if the app
#   already draws its own titlebar — these shots do).
set -euo pipefail

IN="$1"; OUT="$2"; BAR_MODE="${3:-nobar}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ABS_IN="$(cd "$(dirname "$IN")" && pwd)/$(basename "$IN")"

read W H < <(sips -g pixelWidth -g pixelHeight "$ABS_IN" | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w, h}')
PAD=70
CSS_W=$(( W>2000 ? 1100 : W/2 ))
CSS_H=$(( CSS_W * H / W ))
BAR=0
BAR_HTML=""
if [ "$BAR_MODE" = "bar" ]; then
  BAR=34
  BAR_HTML='<div class="bar"><i class="r"></i><i class="y"></i><i class="g"></i></div>'
fi
CANVAS_W=$(( CSS_W + PAD*2 ))
CANVAS_H=$(( CSS_H + BAR + PAD*2 ))

TMP="$DIR/.frame.html"
cat > "$TMP" <<HTML
<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${CANVAS_W}px;height:${CANVAS_H}px}
body{display:flex;align-items:center;justify-content:center;
  background:radial-gradient(800px 600px at 70% 8%,rgba(36,200,219,0.16),transparent 60%),
             radial-gradient(700px 600px at 12% 96%,rgba(124,92,255,0.15),transparent 55%),
             linear-gradient(160deg,#0b0b12,#08080c 60%,#06060a)}
.win{width:${CSS_W}px;border-radius:14px;overflow:hidden;
  border:1px solid rgba(255,255,255,0.10);
  box-shadow:0 50px 100px -30px rgba(0,0,0,0.85),inset 0 1px 0 rgba(255,255,255,0.06)}
.bar{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;
  background:linear-gradient(#16161f,#101018);border-bottom:1px solid rgba(255,255,255,0.06)}
.bar i{width:11px;height:11px;border-radius:50%;display:inline-block}
.r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
img{display:block;width:100%}
</style></head><body>
<div class="win">${BAR_HTML}<img src="file://${ABS_IN}"></div>
</body></html>
HTML

"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --allow-file-access-from-files --default-background-color=00000000 \
  --window-size=${CANVAS_W},${CANVAS_H} --screenshot="$OUT" "file://$TMP" >/dev/null 2>&1
rm -f "$TMP"
echo "framed → $OUT ($(sips -g pixelWidth -g pixelHeight "$OUT" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}'))"
