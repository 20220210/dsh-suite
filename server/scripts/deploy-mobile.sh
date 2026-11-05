#!/bin/bash
# 把 mobile/ 部署到 Nginx 静态目录，并自增构建号（供前端下拉刷新检测更新）
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../../mobile" && pwd)"
DEST="${1:-/var/www/dsh-mobile}"

cd "$SRC"
n=$(( $(cat .build 2>/dev/null || echo 0) + 1 ))
echo "$n" > .build
echo "$n" > build.txt
sed -i "s/const BUILD = '[^']*';/const BUILD = '$n';/" app.js
sed -i "s/const CACHE = '[^']*';/const CACHE = 'dsh-m-$n';/" sw.js

node --check app.js
node --check sw.js
mkdir -p "$DEST"
cp -a index.html app.js style.css sw.js manifest.webmanifest build.txt "$DEST"/
chmod -R a+rX "$DEST"
echo "deployed v$n -> $DEST"
