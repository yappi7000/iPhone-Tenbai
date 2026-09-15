import os
import json
import time
import urllib.request
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "10000"))
UPSTREAM = "https://lite.kaitori.app/api/search"
API_KEY = os.environ.get("LITE_API_KEY", "").strip()
ROOT = Path(__file__).resolve().parent
CACHE = {}
CACHE_SECONDS = 300


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET, HEAD")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET, HEAD")
        self.end_headers()

    def do_HEAD(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            data = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return
        if path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            return self.send_json(200, {"ok": True, "service": "iphone-kaitori-cloud"})
        if path in ("/", "/index.html"):
            data = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/search":
            return self.send_json(404, {"error": "Not found"})

        if not API_KEY:
            print("LITE_API_KEY is not configured", flush=True)
            return self.send_json(500, {"error": "サーバー側のAPIキーが未設定です"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            jan = "".join(c for c in str(body.get("jan", "")) if c.isdigit())

            if not 7 <= len(jan) <= 14:
                return self.send_json(400, {"error": "JANは7〜14桁で入力してください"})

            now = time.time()
            cached = CACHE.get(jan)
            if cached and now - cached[0] < CACHE_SECONDS:
                return self.send_json(200, cached[1])

            url = UPSTREAM + "?" + urllib.parse.urlencode({"jan": jan})
            request = urllib.request.Request(
                url,
                headers={
                    "Lite-API-Key": API_KEY,
                    "Accept": "application/json",
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
                    "Origin": "https://lite.kaitori.app",
                    "Referer": "https://lite.kaitori.app/",
                },
                method="GET",
            )

            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))

            CACHE[jan] = (now, payload)
            return self.send_json(200, payload)

        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            print(f"Upstream HTTP error: status={error.code}, body={raw[:500]}", flush=True)
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {"error": raw or f"HTTP {error.code}"}
            return self.send_json(error.code, payload)

        except Exception as error:
            print(f"Search error: {type(error).__name__}: {error}", flush=True)
            return self.send_json(500, {"error": "検索中にサーバーエラーが発生しました"})

    def log_message(self, format_string, *args):
        print(format_string % args, flush=True)


if __name__ == "__main__":
    print(f"Starting server on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
