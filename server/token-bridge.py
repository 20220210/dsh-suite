#!/usr/bin/env python3
"""给桌面客户端用：把 DSH 当前进程的 token 暴露在本机 127.0.0.1:19391，
   由 nginx 的 /_dsh/token（BasicAuth 保护）转发出去。
   token 每次 dsh web 重启都会变，客户端靠这个接口自动换新 token。"""
import re, subprocess, time, json, hmac, hashlib, os, secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CACHE = {"at": 0.0, "token": None}
SECRET_FILE = "/root/.dsh/bridge-secret"
COOKIE_NAME = "dshm"
COOKIE_TTL = 365 * 24 * 3600

def bridge_secret():
    try:
        raw = open(SECRET_FILE, "rb").read().strip()
        if len(raw) >= 32:
            return raw
    except FileNotFoundError:
        pass
    raw = secrets.token_hex(32).encode()
    with open(SECRET_FILE, "wb") as fh:
        fh.write(raw)
    os.chmod(SECRET_FILE, 0o600)
    return raw

def make_cookie():
    exp = int(time.time()) + COOKIE_TTL
    sig = hmac.new(bridge_secret(), str(exp).encode(), hashlib.sha256).hexdigest()
    return f"{COOKIE_NAME}=v1:{exp}.{sig}; Max-Age={COOKIE_TTL}; Path=/; Secure; HttpOnly; SameSite=Lax"

def cookie_ok(cookie_header):
    if not cookie_header:
        return False
    for part in cookie_header.split(";"):
        name, _, val = part.strip().partition("=")
        if name != COOKIE_NAME or not val.startswith("v1:"):
            continue
        try:
            exp_s, sig = val[3:].split(".", 1)
            exp = int(exp_s)
        except Exception:
            return False
        if exp < time.time():
            return False
        want = hmac.new(bridge_secret(), exp_s.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, want)
    return False
TOKEN_RE = re.compile(r"[?&]token=([A-Za-z0-9_-]{16,})")

def current_token():
    now = time.time()
    if CACHE["token"] and now - CACHE["at"] < 8:
        return CACHE["token"]
    token = None
    for args in (
        ["journalctl", "-u", "dsh", "-n", "400", "--no-pager", "-o", "cat"],
        ["tail", "-n", "400", "/root/.dsh/mobile-link/endpoint.json"],
    ):
        try:
            out = subprocess.run(args, capture_output=True, text=True, timeout=10).stdout
        except Exception:
            continue
        m = TOKEN_RE.findall(out)
        if m:
            token = m[-1]
            break
    CACHE.update(at=now, token=token)
    return token

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/pauth":
            # nginx auth_request：只认 bridge 自己签发的 cookie（BasicAuth 输过一次之后就不用再输）
            if cookie_ok(self.headers.get("Cookie")):
                self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers()
            else:
                self.send_response(401); self.send_header("Content-Length", "0"); self.end_headers()
            return
        if path == "/auto":
            # 手机一键登录：拿当前进程 token，302 跳转 DSH 登录 URL（浏览器会种 30 天 cookie）
            tok = current_token()
            if not tok:
                self.send_response(503); self.end_headers(); self.wfile.write(b"token-unavailable"); return
            self.send_response(302)
            self.send_header("Location", "/?token=" + tok)
            self.send_header("Set-Cookie", make_cookie())
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if path in ("/token", "/"):
            tok = current_token()
            if not tok:
                self.send_response(503); self.end_headers(); self.wfile.write(b"token-unavailable"); return
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Set-Cookie", make_cookie())
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(tok.encode())
            return
        self.send_response(404); self.end_headers()
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 19391), Handler).serve_forever()
