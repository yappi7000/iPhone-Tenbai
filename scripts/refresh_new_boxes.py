"""Fetch fresh official buyback quotes for two sealed Pokemon BOX products only."""
import datetime as dt
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.crawl_catalog import STORES, fetch_quote

IDS = ('pokemon-storm-emeralda-box', 'pokemon-inferno-x-box')

def main():
    catalog = json.loads((ROOT / 'data/catalog.json').read_text(encoding='utf-8'))
    products = {p['id']: p for p in catalog['products'] if p['id'] in IDS}
    if set(products) != set(IDS):
        raise SystemExit('ERROR: install new BOX products first')
    target = ROOT / 'data/catalog_prices.json'
    original = target.read_bytes()
    data = json.loads(original)
    rows = {}
    for product_id in IDS:
        product = products[product_id]
        rows[product_id] = []
        print('FETCH', product['name'], flush=True)
        for store in STORES:
            q = fetch_quote(store, product)
            rows[product_id].append(q)
            print(' ', store, q['status'], q['price'], flush=True)
            time.sleep(1)
    # Avoid replacing unrelated data if the scheduled crawler updated it meanwhile.
    if target.read_bytes() != original:
        raise SystemExit('ERROR: catalog_prices.json changed during fetch. Rerun after update finishes.')
    data['products'].update(rows)
    data['generated_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    temp.replace(target)
    for product_id in IDS:
        good = [q for q in rows[product_id] if q['status']=='ok' and type(q['price']) is int]
        print('RESULT', products[product_id]['name'], len(good), 'shops with published confirmed prices')
    print('PASS: only two BOX price entries updated; all existing product data retained')

if __name__ == '__main__':
    main()
