#!/usr/bin/env python3
"""给桌面客户端用：把 rc.2 实例（127.0.0.1:3081）当前进程的 token 暴露在 127.0.0.1:19393，
   由 nginx 的 /_dsh/token（BasicAuth 保护）转发出去。
   token 每次 dsh web 重启都会变（写在启动日志里），客户端靠这个接口自动换新。
   与 3080 的 /root/dsh-token-bridge.py 同思路，只是数据源换成 rc.2 的日志。"""
import re
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 19393
LOG = "/root/dsh-web-rc2.log"
TOKEN_RE = re.compile(r"[?&]token=([A-Za-z0-9_-]{16,})")
CACHE = {"at": 0.0, "token": None}


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

    def do_GET(self):
        path = self.path.split("?")[0]
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
