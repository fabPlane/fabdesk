#!/usr/bin/env python3
"""Tiny result receiver for guests that cannot ssh out (Windows). Accepts PUT /<name> (saved into the
output dir) and POST /__done (creates <dir>/.done). Usage: receiver.py <port> <out-dir>"""
import os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, out = int(sys.argv[1]), sys.argv[2]
os.makedirs(out, exist_ok=True)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _ok(self): self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")
    def do_PUT(self):
        name = os.path.basename(self.path.split("?")[0]) or "unnamed"
        n = int(self.headers.get("Content-Length", "0"))
        with open(os.path.join(out, name), "wb") as f:
            while n > 0:
                chunk = self.rfile.read(min(n, 1 << 20)); n -= len(chunk); f.write(chunk)
                if not chunk: break
        self._ok()
    def do_POST(self):
        if self.path.startswith("/__done"): open(os.path.join(out, ".done"), "w").close()
        self._ok()

ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
