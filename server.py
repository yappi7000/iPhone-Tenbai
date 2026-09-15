```python
import json
import time
import urllib.error
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "0.0.0.0"
PORT = int(__import__("os").environ.get("PORT", "10000"))

# Cloudflare Worker経由で買取APIへ接続
UPSTREAM = "https://iphone-kaitori-api.thank-you-8p.workers.dev/api/search"

ROOT = Path(__file__).resolve().parent

CACHE = {}
CACHE_SECONDS = 300
VERSION = "worker-proxy-2026-09-16"


def upstream_request(jan):
    request_body = json.dumps({"jan": jan}).encode("utf-8")

    request = urllib.request.Request(
        UPSTREAM,
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
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
                    "error": "WorkerからJSONではない応答が返りました",
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
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

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
            jan = "".join(
                c for c in params.get("jan", [""])[0]
                if c.isdigit()
            )

            result = {
                "version": VERSION,
                "worker_url": UPSTREAM,
                "jan_received": jan,
            }

            if not jan:
                result["message"] = (
                    "JANを指定するとWorker経由の接続結果を確認できます"
                )
                return self.send_json(200, result)

            if not 7 <= len(jan) <= 14:
                result["message"] = "JANは7〜14桁で指定してください"
                return self.send_json(400, result)

            try:
                status, payload = upstream_request(jan)

                result["upstream_status"] = status
                result["upstream_response"] = payload

                return self.send_json(200, result)

            except Exception as error:
                result["upstream_error"] = (
                    f"{type(error).__name__}: {error}"
                )
                return self.send_json(500, result)

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
            content_length = int(
                self.headers.get("Content-Length", "0")
            )

            raw_body = self.rfile.read(content_length)
            body = json.loads(raw_body)

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
                print(
                    f"Cache hit: JAN={jan}",
                    flush=True
                )
                return self.send_json(
                    200,
                    cached["payload"]
                )

            status, payload = upstream_request(jan)

            if status == 200:
                CACHE[jan] = {
                    "time": now,
                    "payload": payload,
                }

            print(
                f"Worker response: JAN={jan}, status={status}",
                flush=True
            )

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
```
