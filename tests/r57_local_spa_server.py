#!/usr/bin/env python3
"""仅供 R57 布局验收使用的本地 SPA 静态服务器。"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(
    os.environ.get(
        "R57_STATIC_ROOT",
        str(Path(__file__).resolve().parents[1] / "firstcare-cloud-local"),
    )
).resolve()
FALLBACK_ROOT = (Path(__file__).resolve().parents[1] / "firstcare-cloud-local").resolve()
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4198


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def do_PUT(self):
        self.handle_request()

    def do_PATCH(self):
        self.handle_request()

    def do_DELETE(self):
        self.handle_request()

    def handle_request(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path.startswith("/api/"):
            payload = json.dumps(
                {"code": "PROJECT_DATA_QUALITY_BLOCKED", "status": "blocked", "ready": False},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(409)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        relative = path.lstrip("/")
        candidate = (ROOT / relative).resolve()
        if not str(candidate).startswith(str(ROOT)):
            candidate = ROOT / "index.html"
        if path in {"/arrears/", "/arrears/index.html"}:
            candidate = ROOT / "arrears/index.html"
            if not candidate.is_file():
                candidate = FALLBACK_ROOT / "arrears/index.html"
        elif not relative or candidate.is_dir():
            candidate = ROOT / "index.html"
        elif not candidate.is_file():
            fallback = (FALLBACK_ROOT / relative).resolve()
            candidate = (
                fallback
                if str(fallback).startswith(str(FALLBACK_ROOT)) and fallback.is_file()
                else ROOT / "index.html"
            )

        payload = candidate.read_bytes()
        mime = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
