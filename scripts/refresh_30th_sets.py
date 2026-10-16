#!/usr/bin/env python3
from pathlib import Path
import json
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.crawl_catalog import STORES, fetch_quote

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

print("PASS: exactly 9 individual 30th card sets refreshed; unrelated prices retained")
