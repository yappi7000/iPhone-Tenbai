#!/usr/bin/env python3
from pathlib import Path
import json
import sys
import time
import re
import urllib.request
from html import unescape

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.crawl_catalog import STORES, fetch_quote

BUNDLE_ID = "pokemon-30th-celebration-cardset-9"


NINE_SET_FALLBACK_URL = (
    "https://pokeca-box-hikaku.com/box/"
    "30th-celebration-cardset.html"
)

NINE_SET_FALLBACK_STORES = {
    "買取ホムラ": "homura",
    "海峡通信": "kaikyo",
    "買取一丁目": "ichome",
    "買取ルデヤ": "rudeya",
}


def fetch_nine_set_fallback():
    """Read published 9-set buyback prices from the comparison page.

    This is used only when direct store crawling cannot obtain the
    9-set listing. Values are explicitly marked as comparison-site
    observations and are never presented as direct official fetches.
    """
    checked = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    ).isoformat()

    req = urllib.request.Request(
        NINE_SET_FALLBACK_URL,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "text/html",
        },
    )

    with urllib.request.urlopen(req, timeout=20) as response:
        if response.status != 200:
            raise ValueError("HTTP " + str(response.status))

        raw = response.read(4_000_001)

    if len(raw) > 4_000_000:
        raise ValueError("Response exceeds limit")

    html = raw.decode("utf-8", errors="replace")

    # 表の<tr>単位で安全に読む
    rows = re.findall(
        r"<tr\b[^>]*>(.*?)</tr>",
        html,
        flags=re.I | re.S
    )

    result = []

    for row_html in rows:
        text_value = re.sub(
            r"<[^>]+>",
            " ",
            row_html
        )

        text_value = unescape(text_value)
        text_value = re.sub(r"\s+", " ", text_value).strip()

        for store_name, store_id in NINE_SET_FALLBACK_STORES.items():
            if store_name not in text_value:
                continue

            # 「取扱なし」は価格として採用しない
            if "取扱なし" in text_value:
                continue

            m = re.search(
                r"[¥￥]\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)",
                text_value
            )

            if not m:
                continue

            price = int(m.group(1).replace(",", ""))

            if not 1000 <= price <= 1000000:
                continue

            result.append({
                "store_id": store_id,
                "store": store_name,
                "url": NINE_SET_FALLBACK_URL,
                "checked_at": checked,
                "observed_at": checked,
                "price": price,
                "status": "ok",
                "matched_name":
                    "30th CELEBRATION カードセット 9種セット",
                "note":
                    "補助ソース取得。比較サイト掲載の公開買取価格。"
                    "店舗公式ページからの直接取得ではありません。"
            })

    # 店舗重複防止
    unique = {}

    for row in result:
        unique[row["store_id"]] = row

    return list(unique.values())


TARGET_IDS = {
    "pokemon-30th-4521329462295",
    "pokemon-30th-4521329462325",
    "pokemon-30th-4521329462349",
    "pokemon-30th-4521329462356",
    "pokemon-30th-4521329462363",
    "pokemon-30th-4521329462370",
    "pokemon-30th-4521329462387",
    "pokemon-30th-4521329462394",
    "pokemon-30th-4521329462400",
}

catalog = json.loads((ROOT / "data/catalog.json").read_text(encoding="utf-8"))
price_path = ROOT / "data/catalog_prices.json"
prices = json.loads(price_path.read_text(encoding="utf-8"))

targets = [p for p in catalog["products"] if p["id"] in TARGET_IDS]
bundle = next(
    (p for p in catalog["products"] if p["id"] == BUNDLE_ID),
    None
)

if bundle is None:
    raise SystemExit("Missing 30th 9-set bundle product")

if len(targets) != len(TARGET_IDS):
    missing = TARGET_IDS - {p["id"] for p in targets}
    raise SystemExit("Missing catalog products: " + ", ".join(sorted(missing)))

for p in targets:
    print("FETCH", p["name"], flush=True)
    rows = []
    for store in STORES:
        row = fetch_quote(store, p)
        rows.append(row)
        print(" ", store, row["status"], row["price"], flush=True)
        time.sleep(0.8)
    prices["products"][p["id"]] = rows

print("FETCH", bundle["name"], flush=True)
bundle_rows = []

for store in STORES:
    row = fetch_quote(store, bundle)
    bundle_rows.append(row)
    print(" ", store, row["status"], row["price"], flush=True)
    time.sleep(0.8)

# 7店舗の直接取得で1件も取れなければ補助ソースを使用
direct_good = [
    q for q in bundle_rows
    if q.get("status") == "ok"
    and isinstance(q.get("price"), int)
    and q.get("price") > 0
]

if not direct_good:
    try:
        fallback_rows = fetch_nine_set_fallback()

        if fallback_rows:
            bundle_rows = fallback_rows
            print(
                "  fallback",
                len(fallback_rows),
                "shops",
                flush=True
            )

            for row in fallback_rows:
                print(
                    " ",
                    row["store"],
                    "ok",
                    row["price"],
                    "(comparison source)",
                    flush=True
                )

    except Exception as e:
        print(
            "  fallback error:",
            type(e).__name__,
            str(e)[:160],
            flush=True
        )

prices["products"][BUNDLE_ID] = bundle_rows

tmp = price_path.with_suffix(".tmp")
tmp.write_text(json.dumps(prices, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
tmp.replace(price_path)

print("\nSUMMARY", flush=True)
for p in targets:
    good = [
        q for q in prices["products"][p["id"]]
        if q.get("status") == "ok" and isinstance(q.get("price"), int)
    ]
    if good:
        best = max(good, key=lambda q: q["price"])
        print(f"{p['name']}: {len(good)} shops / best {best['price']:,}円 ({best['store']})")
    else:
        print(f"{p['name']}: published individual price not found")

bundle_good = [
    q for q in prices["products"].get(BUNDLE_ID, [])
    if q.get("status") == "ok"
    and isinstance(q.get("price"), int)
]

if bundle_good:
    best = max(bundle_good, key=lambda q: q["price"])
    print(
        f"9種セット: {len(bundle_good)} shops / "
        f"best {best['price']:,}円 ({best['store']})"
    )
else:
    print("9種セット: published 9-set price not found")

print(
    "PASS: 9 individual 30th card sets + real 9-set product refreshed; "
    "unrelated prices retained"
)
