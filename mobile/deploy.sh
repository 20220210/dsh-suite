#!/bin/bash
# 手机页部署：自增构建号 -> 注入 app.js/sw.js -> 同步 /var/www/dsh-mobile -> 自检
set -euo pipefail
DIR=/root/API/dsh-mobile-web
DEST=/var/www/dsh-mobile
CNT_FILE="$DIR/.build"
n=$(( $(cat "$CNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$CNT_FILE"
echo "$n" > "$DIR/build.txt"

python3 - "$n" <<'PY'
import re, sys
n = sys.argv[1]
s = open('/root/API/dsh-mobile-web/app.js', encoding='utf-8').read()
s = re.sub(r"const BUILD = '[^']*';", f"const BUILD = '{n}';", s, count=1)
open('/root/API/dsh-mobile-web/app.js','w',encoding='utf-8').write(s)
sw = open('/root/API/dsh-mobile-web/sw.js', encoding='utf-8').read()
sw = re.sub(r"const CACHE = '[^']*';", f"const CACHE = 'dsh-m-{n}';", sw, count=1)
open('/root/API/dsh-mobile-web/sw.js','w',encoding='utf-8').write(sw)
print(f'build = v{n}')
PY

node --check "$DIR/app.js"
node --check "$DIR/sw.js"
mkdir -p "$DEST"
cp -a "$DIR/index.html" "$DIR/app.js" "$DIR/style.css" "$DIR/sw.js" "$DIR/manifest.webmanifest" \
      "$DIR/icon-192.png" "$DIR/icon-512.png" "$DIR/build.txt" "$DEST/"
chmod -R a+rX "$DEST"
echo "deployed to $DEST"
