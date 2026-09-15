import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "10000"))

# RenderからCloudflare Workerへ接続する
UPSTREAM = "https://iphone-kaitori-api.thank-you-8p.workers.dev/test"

ROOT = Path(__file__).resolve().parent
CACHE = {}
CACHE_SECONDS = 300
VERSION = "worker-proxy-2026-09-16"


def request_worker(jan):
    body = json.dumps({"jan": jan}).encode("utf-8")

    request = urllib.request.Request(
        UPSTREAM,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8", "replace")

            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {
                    "error": "Workerから正しいJSONが返りませんでした",
                    "raw": raw[:1000],
                }

            return response.status, payload

    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")

        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {
                "error": raw[:1000] or f"HTTP {error.code}",
            }

        return error.code, payload


class Handler(BaseHTTPRequestHandler):

    def send_json(self, status, payload):
        data = json.dumps(
            payload,
            ensure_ascii=False
        ).encode("utf-8")

        self.send_response(status)
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8"
        )
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type"
        )
        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS, HEAD"
        )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(data)

    def send_html(self):
        file_path = ROOT / "index.html"

        if not file_path.exists():
            return self.send_json(
                404,
                {"error": "index.htmlが見つかりません"}
            )

        data = file_path.read_bytes()

        self.send_response(200)
        self.send_header(
            "Content-Type",
            "text/html; charset=utf-8"
        )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type"
        )
        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS, HEAD"
        )
        self.end_headers()

    def do_HEAD(self):
        path = self.path.split("?", 1)[0]

        if path in ("/", "/index.html"):
            return self.send_html()

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/health":
            return self.send_json(
                200,
                {
                    "ok": True,
                    "service": "iphone-kaitori",
                    "version": VERSION,
                }
            )

        if path == "/diagnostic":
            query = self.path.split("?", 1)
            jan = ""

            if len(query) == 2:
                for item in query[1].split("&"):
                    key, _, value = item.partition("=")
                    if key == "jan":
                        jan = "".join(
                            c for c in value
                            if c.isdigit()
                        )

            result = {
                "version": VERSION,
                "worker_url": UPSTREAM,
                "jan_received": jan,
            }

            if not jan:
                result["message"] = "JANを指定してください"
                return self.send_json(200, result)

            if not 7 <= len(jan) <= 14:
                result["message"] = "JANは7〜14桁で指定してください"
                return self.send_json(400, result)

            status, payload = request_worker(jan)

            result["upstream_status"] = status
            result["upstream_response"] = payload

            return self.send_json(200, result)

        if path in ("/", "/index.html"):
            return self.send_html()

        return self.send_json(
            404,
            {"error": "Not found"}
        )

    def do_POST(self):
        path = self.path.split("?", 1)[0]

        if path != "/api/search":
            return self.send_json(
                404,
                {"error": "Not found"}
            )

        try:
            length = int(
                self.headers.get("Content-Length", "0")
            )

            body = json.loads(
                self.rfile.read(length)
            )

            jan = "".join(
                c for c in str(body.get("jan", ""))
                if c.isdigit()
            )

            if not 7 <= len(jan) <= 14:
                return self.send_json(
                    400,
                    {"error": "JANは7〜14桁で入力してください"}
                )

            now = time.time()
            cached = CACHE.get(jan)

            if cached and now - cached["time"] < CACHE_SECONDS:
                return self.send_json(
                    200,
                    cached["payload"]
                )

            status, payload = request_worker(jan)

            if status == 200:
                CACHE[jan] = {
                    "time": now,
                    "payload": payload,
                }

            return self.send_json(status, payload)

        except json.JSONDecodeError:
            return self.send_json(
                400,
                {"error": "リクエスト形式が正しくありません"}
            )

        except Exception as error:
            print(
                f"Search error: {type(error).__name__}: {error}",
                flush=True
            )

            return self.send_json(
                500,
                {"error": "検索中にサーバーエラーが発生しました"}
            )

    def log_message(self, format_string, *args):
        print(
            format_string % args,
            flush=True
        )


if __name__ == "__main__":
    print(
        f"Starting server on {HOST}:{PORT} "
        f"version={VERSION}",
        flush=True
    )

    server = ThreadingHTTPServer(
        (HOST, PORT),
        Handler
    )

    server.serve_forever()
