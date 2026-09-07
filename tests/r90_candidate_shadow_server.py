#!/usr/bin/env python3
"""R90候选本地影子服务：候选静态文件 + 本地API，其余生产资产只读代理。"""

from __future__ import annotations

import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
CANDIDATE = ROOT / "release-candidates/cockpit-r90-operating-capabilities-20260816-204727/payload"
PORT = int(os.environ.get("R90_SHADOW_PORT", "4198"))
BACKEND = os.environ.get("R90_BACKEND", "http://127.0.0.1:3910").rstrip("/")
PRODUCTION = "https://www.firstcare.cloud"
HOP_HEADERS = {"connection", "content-length", "transfer-encoding", "content-encoding"}


class Handler(BaseHTTPRequestHandler):
    server_version = "CockpitR90Shadow/1.0"

    def log_message(self, _format, *_args):
        return

    def send_file(self, file_path: Path):
        contents = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(contents)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(contents)

    def proxy(self, origin: str):
        split = urlsplit(self.path)
        target = f"{origin}{split.path}{'?' + split.query if split.query else ''}"
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else None
        headers = {
            key: value for key, value in self.headers.items()
            if key.lower() not in {"host", "connection", "content-length", "accept-encoding"}
        }
        request = Request(target, data=body, headers=headers, method=self.command)
        try:
            response = urlopen(request, timeout=30)
        except HTTPError as error:
            response = error
        contents = response.read()
        self.send_response(response.status)
        for key, value in response.headers.items():
            if key.lower() not in HOP_HEADERS:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(contents)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(contents)

    def handle_request(self):
        split = urlsplit(self.path)
        request_path = split.path
        if request_path.startswith("/api/"):
            return self.proxy(BACKEND)

        relative = request_path.lstrip("/")
        local_file = CANDIDATE / relative
        if relative and local_file.is_file() and CANDIDATE in local_file.parents:
            return self.send_file(local_file)

        if request_path == "/" or "." not in Path(request_path).name:
            return self.send_file(CANDIDATE / "index.expected.html")

        return self.proxy(PRODUCTION)

    def do_GET(self):
        self.handle_request()

    def do_HEAD(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
