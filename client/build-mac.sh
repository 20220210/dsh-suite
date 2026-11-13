#!/bin/bash
# 构建 macOS arm64 绿色包（未签名）+ 小更新包
# 用法: ./build-mac.sh <版本号> [arm64|x64]
set -euo pipefail
VERSION="${1:?用法: ./build-mac.sh 1.5.4 [arm64|x64]}"
ARCH="${2:-arm64}"
ROOT="/root/API/dsh-client"
APP="$ROOT/app"
CACHE="$ROOT/.cache"
OUT="$ROOT/out-mac"
WORK="/tmp/dsh-mac-build-$VERSION-$ARCH"
ELECTRON_VER="45.2.2"
ZIP="electron-v$ELECTRON_VER-darwin-$ARCH.zip"
mkdir -p "$CACHE" "$OUT"

echo "== 1) Electron $ELECTRON_VER darwin-$ARCH =="
if [ ! -f "$CACHE/$ZIP" ]; then
  curl -fL --retry 3 -o "$CACHE/$ZIP" "https://npmmirror.com/mirrors/electron/$ELECTRON_VER/$ZIP"
fi
ls -la "$CACHE/$ZIP" | awk '{print "  缓存包:", $5, "bytes"}'

echo "== 2) 解包并改名 =="
rm -rf "$WORK"; mkdir -p "$WORK"
unzip -q "$CACHE/$ZIP" -d "$WORK"
mv "$WORK/Electron.app" "$WORK/DSH Desktop.app"
APPB="$WORK/DSH Desktop.app"

echo "== 3) Info.plist =="
python3 - "$APPB" "$VERSION" <<'PY'
import plistlib, sys, os
app, version = sys.argv[1], sys.argv[2]
p = os.path.join(app, 'Contents', 'Info.plist')
with open(p, 'rb') as f: d = plistlib.load(f)
d.update({
    'CFBundleName': 'DSH Desktop',
    'CFBundleDisplayName': 'DSH Desktop',
    'CFBundleIdentifier': 'com.dsh.desktop',
    'CFBundleShortVersionString': version,
    'CFBundleVersion': version,
    'CFBundleIconFile': 'dsh',
    'LSMinimumSystemVersion': '13.0',
    'NSHighResolutionCapable': True,
    'LSApplicationCategoryType': 'public.app-category.productivity',
})
with open(p, 'wb') as f: plistlib.dump(d, f)
print('  bundle=', d['CFBundleIdentifier'], 'version=', d['CFBundleShortVersionString'])
PY

echo "== 4) 应用图标 dsh.icns =="
python3 - "$APP/assets/dsh.ico" "$APPB/Contents/Resources/dsh.icns" <<'PY'
import sys, subprocess, struct, tempfile, os
ico, out = sys.argv[1], sys.argv[2]
sizes = {128: b'ic07', 256: b'ic08', 512: b'ic09', 1024: b'ic10'}
body = b''
for size, typ in sizes.items():
    tmp = tempfile.mktemp(suffix='-%d.png' % size)
    subprocess.run(['convert', '%s[0]' % ico, '-resize', '%dx%d' % (size, size), tmp], check=True)
    data = open(tmp, 'rb').read(); os.unlink(tmp)
    body += typ + struct.pack('>I', len(data) + 8) + data
icns = b'icns' + struct.pack('>I', len(body) + 8) + body
open(out, 'wb').write(icns)
print('  icns', len(icns), 'bytes')
PY

echo "== 5) 放入 app 载荷 =="
RES="$APPB/Contents/Resources"
rm -rf "$RES/app"
mkdir -p "$RES/app/node_modules"
cp "$APP/main.cjs" "$APP/updater.cjs" "$APP/apply-update.cjs" "$APP/proxy.mjs" "$APP/ws-mux.mjs" "$APP/package.json" "$APP/default-config.json" "$RES/app/"
cp -r "$APP/node_modules/ws" "$RES/app/node_modules/"
cp -r "$APP/assets" "$RES/app/"
cat > "$WORK/使用说明-mac.txt" <<'EOF'
DSH Desktop（macOS 未签名版）
1) 把 DSH Desktop.app 拖到「应用程序」文件夹
2) 首次打开：右键点图标 → 打开 → 再点「打开」（未签名，系统会拦一次）
   或者终端执行：xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
3) 需要 macOS 13 或更高版本；首次运行会弹密码框，输入 DSH 访问密码
4) 开机自启 / 自动更新 在菜单栏托盘图标里
EOF
cp "$WORK/使用说明-mac.txt" "$APPB/使用说明-mac.txt" 2>/dev/null || true

echo "== 6) 打包 =="
cd "$WORK"
rm -f "$OUT/dsh-desktop-v$VERSION-mac-$ARCH.zip"
zip -qry "$OUT/dsh-desktop-v$VERSION-mac-$ARCH.zip" "DSH Desktop.app" "使用说明-mac.txt"
cd "$RES/app"
rm -f "$OUT/app-$VERSION-mac-$ARCH.zip"
zip -qr "$OUT/app-$VERSION-mac-$ARCH.zip" .

echo "== 7) 结果 =="
for f in "$OUT/dsh-desktop-v$VERSION-mac-$ARCH.zip" "$OUT/app-$VERSION-mac-$ARCH.zip"; do
  printf "  %-52s %8.1f MB  sha256=%s\n" "$(basename "$f")" "$(stat -c %s "$f" | awk '{print $1/1048576}')" "$(sha256sum "$f" | cut -c1-16)"
done
echo "  symlink 条目数（应 >0）: $(unzip -l "$OUT/dsh-desktop-v$VERSION-mac-$ARCH.zip" | grep -c "Frameworks/")"
