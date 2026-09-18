#!/usr/bin/env python3
import json, re, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "data" / "product_master.json"
REGISTRY = ROOT / "data" / "source_registry.json"
PRICES = ROOT / "data" / "prices.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; iPhone-Tenbai-PriceBot/1.0; +https://yappi7000.github.io/iPhone-Tenbai/)"
}
TIMEOUT = 25

COLOR_ALIASES = {
    "黒":"ブラック", "ブラック":"ブラック",
    "白":"シルバー", "銀":"シルバー", "シルバー":"シルバー",
    "紫":"バーガンディ", "バーガンディ":"バーガンディ",
    "赤":"バーガンディ",
    "青":"グレイシャー", "グレイシャー":"グレイシャー",
}

MODEL_ALIASES = {
    "iPhone18 Pro Max":"iPhone 18 Pro Max",
    "iPhone18PROMax":"iPhone 18 Pro Max",
    "iPhone 18 Pro Max":"iPhone 18 Pro Max",
    "iPhone18 Pro":"iPhone 18 Pro",
    "iPhone18PRO":"iPhone 18 Pro",
    "iPhone 18 Pro":"iPhone 18 Pro",
}

def clean(s):
    return re.sub(r"\s+", " ", s.replace("\u3000"," ")).strip()

def price_from(text):
    m = re.search(r"(?<!\d)(\d{2,3}(?:,\d{3})+|\d{5,6})\s*円", text)
    if not m:
        return None
    n = int(m.group(1).replace(",",""))
    return n if 5000 <= n <= 600000 else None

def norm_model(s):
    s = s.replace("　"," ")
    for k,v in MODEL_ALIASES.items():
        if k in s: return v
    return None

def norm_storage(s):
    m = re.search(r"(256GB|512GB|1TB|2TB)", s, re.I)
    return m.group(1) if m else None

def norm_color(s):
    for k,v in COLOR_ALIASES.items():
        if k in s: return v
    return None

def load_master():
    data = json.loads(MASTER.read_text(encoding="utf-8"))
    # 支持 {"items":[...]} と {key:jan} の両方
    if isinstance(data, dict) and "items" in data:
        return data["items"]
    items=[]
    if isinstance(data, dict):
        for key, jan in data.items():
            parts = key.split("_")
            if len(parts) >= 3:
                model = "_".join(parts[:-2]); storage=parts[-2]; color=parts[-1]
                items.append({"model":model,"storage":storage,"color":color,"jan":str(jan)})
    return items

def fetch(url):
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    r.encoding = r.apparent_encoding or r.encoding
    return r.text

def candidate_pages(source):
    html = fetch(source["url"])
    pages = [(source["url"], html)]
    if source["mode"] == "follow_iphone18":
        soup = BeautifulSoup(html, "html.parser")
        seen=set()
        for a in soup.find_all("a", href=True):
            label=clean(a.get_text(" ", strip=True))
            href=urljoin(source["url"], a["href"])
            if "iphone18" in (label+href).lower() and href not in seen:
                seen.add(href)
                try:
                    pages.append((href, fetch(href)))
                except Exception as e:
                    print(f"[WARN] {source['store']} subpage failed: {href} :: {e}")
                if len(pages) >= 40:
                    break
    return pages

def parse_source(source, items):
    found={}
    pages=candidate_pages(source)
    for url,html in pages:
        soup=BeautifulSoup(html,"html.parser")
        # 価格表の行・カード単位を優先
        blocks=soup.find_all(["tr","li","article","div"])
        for block in blocks:
            txt=clean(block.get_text(" ", strip=True))
            if "iPhone" not in txt or "18 Pro" not in txt:
                continue
            model=norm_model(txt); storage=norm_storage(txt); color=norm_color(txt)
            if not (model and storage): continue
            p=price_from(txt)
            if not p: continue
            for it in items:
                if it["model"]==model and it["storage"]==storage:
                    # 色が取れる場合は一致必須。色なし価格表は容量共通価格として全色へ適用。
                    if color and color != it["color"]:
                        continue
                    found[it["jan"]] = {
                        "store":source["store"],
                        "price":p,
                        "url":url,
                        "condition":"unopened",
                        "scope":"jan" if color else "model_storage"
                    }
        # ページ全体のフォールバック（色なし容量価格）
        text=clean(soup.get_text(" ", strip=True))
        for it in items:
            if it["model"] not in text or it["storage"] not in text:
                continue
            if it["jan"] in found: continue
            # モデル+容量の直後500文字以内から価格を探す
            pat=re.escape(it["model"]).replace(r"\ ","\s*") + r".{0,1800}?" + re.escape(it["storage"])
            m=re.search(pat,text,re.I)
            if m:
                p=price_from(m.group(0))
                if p:
                    found[it["jan"]]={"store":source["store"],"price":p,"url":source["url"],"condition":"unopened","scope":"model_storage"}
    return found

def main():
    items=load_master()
    registry=json.loads(REGISTRY.read_text(encoding="utf-8"))
    prices=json.loads(PRICES.read_text(encoding="utf-8")) if PRICES.exists() else {}
    run_time=datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    total=0
    for src in registry["sources"]:
        if not src.get("enabled"): continue
        try:
            found=parse_source(src, items)
            for jan, rec in found.items():
                entry=prices.setdefault(jan, {"stores":[]})
                stores=[x for x in entry.get("stores",[]) if x.get("store") != src["store"]]
                stores.append(rec)
                entry["stores"]=stores
                entry["last_update"]=run_time
                total += 1
            print(f"[OK] {src['store']}: {len(found)} records")
        except Exception as e:
            print(f"[ERROR] {src['store']}: {type(e).__name__}: {e}")
        time.sleep(1)
    PRICES.write_text(json.dumps(prices, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[DONE] updated records: {total}")

if __name__ == "__main__":
    main()
