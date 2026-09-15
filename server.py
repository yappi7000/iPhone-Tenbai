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
UPSTREAM = "https://iphone-kaitori-api.thank-you-8p.workers.dev/api/search"
API_KEY = os.environ.get("LITE_API_KEY", "").strip()
ROOT = Path(__file__).resolve().parent
CACHE = {}
CACHE_SECONDS = 300
VERSION = "diagnostic-2026-09-15"


def upstream_request(jan):
    data = json.dumps({"jan": jan}).encode("utf-8")

    request = urllib.request.Request(
        UPSTREAM,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw[:1000]}
        return response.status, payload
        raw = response.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw[:1000]}
        return response.status, payload


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
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path == "/health":
            return self.send_json(200, {"ok": True, "service": "iphone-kaitori-cloud", "version": VERSION})

        if path == "/diagnostic":
            jan = "".join(c for c in params.get("jan", [""])[0] if c.isdigit())
            result = {
                "version": VERSION,
                "api_key_exists": bool(API_KEY),
                "api_key_length": len(API_KEY),
                "jan_received": jan,
            }
            if not jan:
                result["message"] = "JANを指定すると外部APIへの接続結果も確認できます"
                return self.send_json(200, result)
            if not 7 <= len(jan) <= 14:
                result["message"] = "JANは7〜14桁で指定してください"
                return self.send_json(200, result)
            try:
                status, payload = upstream_request(jan)
                result["upstream_status"] = status
                result["upstream_response"] = payload
            except urllib.error.HTTPError as error:
                raw = error.read().decode("utf-8", "replace")
                result["upstream_status"] = error.code
                try:
                    result["upstream_response"] = json.loads(raw) if raw else {}
                except json.JSONDecodeError:
                    result["upstream_response"] = {"raw": raw[:1000]}
            except Exception as error:
                result["upstream_error"] = f"{type(error).__name__}: {error}"
            return self.send_json(200, result)

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

            status, payload = upstream_request(jan)
            CACHE[jan] = (now, payload)
            return self.send_json(status, payload)

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
    print(f"Starting server on {HOST}:{PORT} version={VERSION} api_key_exists={bool(API_KEY)}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
