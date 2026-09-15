import os, json, time, urllib.request, urllib.error, urllib.parse
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
        data=json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Access-Control-Allow-Headers","Content-Type")
        self.send_header("Access-Control-Allow-Methods","POST, OPTIONS, GET"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_OPTIONS(self): self.send_json(204,{})
    def do_GET(self):
        path=self.path.split("?",1)[0]
        if path == "/health": return self.send_json(200,{"ok":True,"service":"iphone-kaitori-cloud"})
        if path in ("/", "/index.html"):
            data=(ROOT/"index.html").read_bytes(); self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data); return
        self.send_json(404,{"error":"Not found"})
    def do_POST(self):
        if self.path.split("?",1)[0] != "/api/search": return self.send_json(404,{"error":"Not found"})
        if not API_KEY: return self.send_json(500,{"error":"サーバー側のAPIキーが未設定です"})
        try:
            n=int(self.headers.get("Content-Length","0")); body=json.loads(self.rfile.read(n))
            jan="".join(c for c in str(body.get("jan","")) if c.isdigit())
            if not 7 <= len(jan) <= 14: return self.send_json(400,{"error":"JANは7〜14桁で入力してください"})
            now=time.time(); hit=CACHE.get(jan)
            if hit and now-hit[0] < CACHE_SECONDS: return self.send_json(200,hit[1])
            url=UPSTREAM+"?"+urllib.parse.urlencode({"jan":jan})
            req=urllib.request.Request(url,headers={"Lite-API-Key":API_KEY,"Accept":"application/json","User-Agent":"iPhone-Kaitori-Checker/1.0"})
            with urllib.request.urlopen(req,timeout=30) as r: payload=json.loads(r.read().decode())
            CACHE[jan]=(now,payload); self.send_json(200,payload)
        except urllib.error.HTTPError as e:
            raw=e.read().decode("utf-8","replace")
            try: payload=json.loads(raw) if raw else {}
            except: payload={"error":raw or f"HTTP {e.code}"}
            self.send_json(e.code,payload)
        except Exception as e: self.send_json(500,{"error":str(e)})
    def log_message(self, fmt, *args): print(fmt % args, flush=True)

ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()
