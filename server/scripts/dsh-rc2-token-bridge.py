#!/usr/bin/env python3
"""给桌面客户端用：把 rc.2 实例（127.0.0.1:3081）当前进程的 token 暴露在 127.0.0.1:19393，
   由 nginx 的 /_dsh/token（BasicAuth 保护）转发出去。
   token 每次 dsh web 重启都会变（写在启动日志里），客户端靠这个接口自动换新。
   与 3080 的 /root/dsh-token-bridge.py 同思路，只是数据源换成 rc.2 的日志。"""
import re
import subprocess
import urllib.request
import urllib.error
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 19393
LOG = "/root/dsh-web-rc2.log"
TOKEN_RE = re.compile(r"[?&]token=([A-Za-z0-9_-]{16,})")
CACHE = {"at": 0.0, "token": None}
COOKIE_CACHE = {"at": 0.0, "cookie": None}


def current_token():
    now = time.time()
    if CACHE["token"] and now - CACHE["at"] < 8:
        return CACHE["token"]
    token = None
    for args in (
        ["tail", "-n", "4000", LOG],
        ["journalctl", "-u", "dsh-rc2", "-n", "400", "--no-pager", "-o", "cat"],
    ):
        try:
            out = subprocess.run(args, capture_output=True, text=True, timeout=10).stdout
        except Exception:
            continue
        found = TOKEN_RE.findall(out)
        if found:
            token = found[-1]
            break
    CACHE.update(at=now, token=token)
    return token


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/plain"):
        buf = body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(buf)))
        self.end_headers()
        self.wfile.write(buf)

    def rc2_cookie(self):
        """用 token 登录 rc2，把它的 dsh-auth cookie 取出来（nginx 子请求用，5 分钟缓存）。"""
        now = time.time()
        if COOKIE_CACHE["at"] and now - COOKIE_CACHE["at"] < 300 and COOKIE_CACHE["cookie"]:
            return COOKIE_CACHE["cookie"]
        token = current_token()
        if not token:
            return None
        try:
            import urllib.request
            req = urllib.request.Request("http://127.0.0.1:3081/?token=" + token)
            # 不让 urllib 自动跟随 303，我们要 Set-Cookie
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *a, **k):
                    return None
            opener = urllib.request.build_opener(NoRedirect)
            try:
                resp = opener.open(req, timeout=8)
                headers = resp.headers
            except urllib.error.HTTPError as e:
                headers = e.headers
            raw = headers.get_all("Set-Cookie") or []
            jar = "; ".join(x.split(";")[0] for x in raw if "=" in x)
            if jar:
                COOKIE_CACHE.update(at=now, cookie=jar)
                return jar
        except Exception:
            return None
        return None

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/m2login":
            # 浏览器带 dshm 来（nginx 已校验），这里把 rc.2 的 cookie 种到浏览器，然后回 /m2/
            jar = self.rc2_cookie()
            if not jar:
                return self._send(503, "cookie unavailable")
            self.send_response(302)
            for pair in jar.split("; "):
                if "=" in pair:
                    self.send_header("Set-Cookie", pair + "; Path=/; Max-Age=2592000; SameSite=Lax")
            from urllib.parse import urlparse, parse_qs
            back = (parse_qs(urlparse(self.path).query).get("back") or ["/m2/"])[0]
            if not back.startswith("/") or back.startswith("//"):
                back = "/m2/"
            self.send_header("Location", back)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        if path == "/cookie":
            jar = self.rc2_cookie()
            if not jar:
                return self._send(503, "cookie unavailable")
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.send_header("x-rc2-cookie", jar)
            self.send_header("content-length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if path in ("/token", "/_dsh/token"):
            token = current_token()
            if not token:
                return self._send(503, "token unavailable")
            return self._send(200, token)
        if path in ("/healthz", "/health"):
            token = current_token()
            return self._send(200 if token else 503, "ok" if token else "no-token")
        return self._send(404, "not found")


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"dsh-rc2 token bridge listening 127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
