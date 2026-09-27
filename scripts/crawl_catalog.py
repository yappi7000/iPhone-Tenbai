"""Public, exact-product buyback quotes. No guessed prices; isolated from iPhone data."""
import concurrent.futures
import datetime as dt
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STORES = {
    'homura': ('買取ホムラ', 'https://kaitori-homura.com/products?q%5Bname_or_jan_code_cont%5D='),
    'rudeya': ('買取ルデヤ', 'https://kaitori-rudeya.com/search/index/'),
    'morimori': ('森森買取', 'https://www.morimori-kaitori.jp/search?sk='),
    'keitaispace': ('携帯空間', 'https://www.keitaispace.co.jp/product/?kw='),
    'kaitoriwiki': ('買取wiki', 'https://kaitori.wiki/search?keyword='),
    'kaitorishouten': ('買取商店', 'https://www.kaitorishouten-co.jp/products/list?q='),
    'ichome': ('買取一丁目', 'https://www.1-chome.com/searchResult'),
}
API_BASES = {
    'kaitorishouten': 'https://www.kaitorishouten-co.jp/api/v1/products?per_page=100&page=1&q=',
    'ichome': 'https://www.1-chome.com/api/index/findByKeyword?page=1&size=100&keyword=',
}
BAD_CONDITION = re.compile(r'中古|開封済|ジャンク|訳あり|シュリンク\s*(無し|なし|無)|バラパック|カートン')
SEALED = re.compile(r'シュリンク\s*(あり|有り|有|付き|付)')

class Node:
    def __init__(self, tag='', attrs=(), parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []
    def text(self):
        return ' '.join(c.text() if isinstance(c, Node) else c for c in self.children)
    def walk(self):
        yield self
        for c in self.children:
            if isinstance(c, Node):
                yield from c.walk()
    def has(self, cls):
        return cls in self.attrs.get('class', '').split()
    def find(self, cls):
        return next((n for n in self.walk() if n.has(cls)), None)

class Tree(HTMLParser):
    VOID = set('area base br col embed hr img input link meta param source track wbr'.split())
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = self.current = Node()
        self.feed(html)
    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.current)
        self.current.children.append(n)
        if tag not in self.VOID:
            self.current = n
    def handle_endtag(self, tag):
        p = self.current
        while p.parent:
            if p.tag == tag:
                self.current = p.parent
                return
            p = p.parent
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)
    def handle_data(self, text):
        if self.current.tag not in ('script', 'style') and text.strip():
            self.current.children.append(text.strip())

def exact_code(text, code):
    return re.search(r'(?<!\d)' + re.escape(code) + r'(?!\d)', text) is not None

def amount(text):
    m = re.fullmatch(r'\s*[¥￥]?\s*([0-9]+(?:,[0-9]{3})*)\s*円?\s*', text)
    if not m:
        return None
    n = int(m[1].replace(',', ''))
    return n if 0 < n <= 10000000 else None

def choose(matches):
    prices = {m['price'] for m in matches}
    if len(prices) != 1:
        return None, 'not_found' if not prices else 'ambiguous'
    return matches[0], 'ok'

def canonical_jan(value):
    """UPC-A and a leading-zero EAN-13 identify the same trade item."""
    code = str(value or '').strip()
    if not re.fullmatch(r'\d{12,13}', code):
        return None
    code = code.zfill(13)
    total = sum(int(n) * (1 if i % 2 == 0 else 3) for i, n in enumerate(code[:-1]))
    return code if (10 - total % 10) % 10 == int(code[-1]) else None

def ichome_android(item, product):
    if item.get('disp') is not True or item.get('kbName') != '新品':
        return []
    if item.get('hasLimit') and any(item.get(k) == 0 for k in ('kbCount', 'kbCountPerAppli')):
        return []
    name = str(item.get('title') or '')
    if not name or BAD_CONDITION.search(name):
        return []
    goods_id, kb_id = str(item.get('goodsId', '')), str(item.get('allGoodsKbId', ''))
    if not goods_id.isdigit() or not kb_id.isdigit():
        return []
    jan = canonical_jan(product['jan'])
    if not jan:
        return []
    memo = Tree(' '.join(str(item.get(k) or '') for k in ('description', 'kbDesc'))).root.text().strip()
    if item.get('hasLimit'):
        memo += ' ／ 数量制限あり（公式ページで確認）'
    matches = []
    for color in item.get('keitaiColorOptions') or []:
        if canonical_jan(color.get('jan')) != jan:
            continue
        for option in item.get('goodsKbDetails') or []:
            label, base = option.get('kbDetailName'), option.get('kbDetailPrice')
            if label not in ('新品', '新品未使用', '未使用', '未使用品', '未開封', '未開封品'):
                continue
            detail_id = option.get('allGoodsKbDetailId')
            if type(detail_id) is not int or type(base) is not int or base <= 0:
                continue
            for relation in color.get('keitaiKbDetailColorRels') or []:
                if relation.get('keitaiKbDetailId') != detail_id or 'varPrice' not in relation:
                    continue
                delta = relation['varPrice']
                delta = 0 if delta is None else delta
                if type(delta) is not int or not 0 < base + delta <= 10000000:
                    continue
                matched_name = name + ' ' + str(color.get('color') or '')
                note = ' ／ '.join(x for x in [label, '色別の通常買取価格（キャンペーン加算なし）', memo] if x)
                matches.append({'price': base + delta, 'matched_name': matched_name,
                    'product_url': '/productDetail/' + goods_id + '/' + kb_id, 'note': note})
    return matches

def extract_api(payload, store, product):
    """Read anonymous public search data; never use retail/campaign maximums."""
    if store == 'ichome':
        if payload.get('code') != 200 or not isinstance(payload.get('data'), dict):
            raise ValueError('Unexpected ichome response')
        data = payload['data']
        items, total = data.get('content'), data.get('totalElements')
    else:
        items, total = payload.get('items'), payload.get('total')
    if not isinstance(items, list) or not isinstance(total, int):
        raise ValueError('Unexpected product search schema')
    if total > len(items):
        return None, 'ambiguous'
    matches = []
    for item in items:
        if store == 'ichome' and item.get('isKeitaiItem') is True:
            if product.get('kind') == 'android' and product['condition'] == 'new':
                matches.extend(ichome_android(item, product))
            continue
        if str(item.get('jan', '')).strip() != product['jan']:
            continue
        name = str(item.get('title' if store == 'ichome' else 'name') or '')
        if not name or BAD_CONDITION.search(name):
            continue
        box = product['condition'] == 'sealed_box'
        if box and not re.search(r'BOX|ボックス', name, re.I):
            continue
        if store == 'ichome':
            if item.get('disp') is not True or item.get('isKeitaiItem') is not False or item.get('kbName') != '新品':
                continue
            if item.get('hasLimit') and any(item.get(k) == 0 for k in ('kbCount', 'kbCountPerAppli')):
                continue
            options = [(o.get('kbDetailName', ''), o.get('kbDetailPrice')) for o in item.get('goodsKbDetails', [])]
            memo = Tree(str(item.get('description') or '')).root.text().strip()
            if item.get('hasLimit'):
                memo += ' ／ 数量制限あり（公式ページで確認）'
            goods_id, kb_id = str(item.get('goodsId', '')), str(item.get('allGoodsKbId', ''))
            if not goods_id.isdigit() or not kb_id.isdigit():
                continue
            link = '/wineDetail/' + goods_id + '/' + kb_id
        else:
            if item.get('price_undecided') is not False:
                continue
            # Rank base is the ordinary price. Visit bonuses remain in the note.
            options = [(o.get('label', ''), o.get('base')) for o in item.get('rank_options', [])]
            memo = Tree(str(item.get('free_area') or '')).root.text().strip()
            if any(o.get(k) is not None for o in item.get('prices', []) for k in ('sale_limit', 'remaining_stock', 'max_quantity')):
                memo += ' ／ 数量制限あり（公式ページで確認）'
            item_id = str(item.get('id', ''))
            if not item_id.isdigit():
                continue
            link = '/products/detail/' + item_id
        for label, value in options:
            if not isinstance(label, str) or BAD_CONDITION.search(label):
                continue
            if box:
                if not SEALED.search(label) and not (store == 'kaitorishouten' and label == '新品' and SEALED.search(memo) and not BAD_CONDITION.search(memo)):
                    continue
            elif product['condition'] == 'sealed_set':
                if not re.search(r'未開封', label + ' ' + memo) or BAD_CONDITION.search(label + ' ' + memo):
                    continue
            elif label.strip() not in ('新品', '新品未使用', '未使用', '未使用品', '未開封', '未開封品'):
                continue
            if type(value) is not int or not 0 < value <= 10000000:
                continue
            note = ' ／ '.join(x for x in [label, memo] if x)
            if store == 'kaitorishouten':
                note = '通常の基準価格（来店加算を含まない） ／ ' + note
            matches.append({'price': value, 'matched_name': name, 'product_url': link, 'note': note})
    return choose(matches)

def extract(html, store, product):
    root = Tree(html).root
    candidates = []
    if store == 'homura':
        for button in root.walk():
            if 'data-product-price' not in button.attrs:
                continue
            p = button.parent
            while p and p.parent:
                # Scope to the smallest product card containing one unique product ID.
                ids = {n.attrs['data-product-id'] for n in p.walk() if 'data-product-id' in n.attrs}
                headings = [n for n in p.walk() if n.tag in ('h3', 'h4', 'h5')]
                if headings and len(ids) == 1:
                    break
                p = p.parent
            if p and p.parent:
                name = button.attrs.get('data-product-name', '')
                code = product.get('store_codes', {}).get(store, product['jan'])
                if exact_code(p.text(), code):
                    candidates.append((name, amount(button.attrs['data-product-price']), p, ''))
    elif store == 'keitaispace':
        # Use only grid cards, not the duplicate mobile/list presentation.
        for p in root.walk():
            if not p.has('product-card'):
                continue
            title, price_node = p.find('product-name'), p.find('price_pro_news')
            if not title or not exact_code(title.text(), product['jan']) or not price_node:
                continue
            label = price_node.text().strip()
            if not re.match(r'^(未開封品|未使用品?|新品)\s', label):
                continue
            value = re.sub(r'^(未開封品|未使用品?|新品)\s*', '', label)
            candidates.append((title.text(), amount(value), p, label.split()[0]))
    elif store == 'kaitoriwiki':
        for p in root.walk():
            if not p.has('pro_list'):
                continue
            title, price_node = p.find('sub-pro-career'), p.find('sub-pro-jia')
            if not title or not exact_code(title.text(), product['jan']) or not price_node:
                continue
            value = re.sub(r'^\s*買取価格\s*[:：]\s*', '', price_node.text())
            candidates.append((title.text(), amount(value), p, '新品基準。詳細条件は公式商品ページで確認'))
    elif store in ('rudeya', 'morimori'):
        cls = 'pgrid-card' if store == 'rudeya' else 'product-item'
        for p in root.walk():
            if not p.has(cls) or not exact_code(p.text(), product['jan']):
                continue
            title = p.find('product-card-name') if store == 'rudeya' else next((n for n in p.walk() if n.tag in ('h3','h4','h5')), None)
            name = title.text() if title else p.text().split('JAN')[0]
            price_node = p.find('product-card-price-value' if store == 'rudeya' else 'price-normal-number')
            if store == 'rudeya' and not p.find('is-new'):
                continue
            memo = p.find('product-card-memo')
            candidates.append((name, amount(price_node.text()) if price_node else None, p, memo.text() if memo else ''))
    matches = []
    for name, price, node, memo in candidates:
        if BAD_CONDITION.search(name):
            continue
        if product['condition'] == 'sealed_box' and not re.search(r'BOX|ボックス', name, re.I):
            continue
        if product['condition'] == 'sealed_box' and store in ('keitaispace', 'kaitoriwiki') and not SEALED.search(name + ' ' + memo):
            continue
        if product['condition'] == 'sealed_set' and (not re.search(r'未開封', name + ' ' + memo) or BAD_CONDITION.search(name + ' ' + memo)):
            continue
        if price is None:
            continue
        links = [n.attrs.get('href', '') for n in node.walk() if n.tag == 'a']
        link = next((x for x in links if re.search(r'/products?/+(?:item/)?\d+|/purchase/|[?&]pid=', x)), '')
        matches.append({'price': price, 'matched_name': name, 'product_url': link, 'note': memo})
    return choose(matches)

def fetch_quote(store, product):
    name, base = STORES[store]
    url = base + urllib.parse.quote(product['jan']) if store != 'ichome' else base
    query = product.get('store_queries', {}).get(store, product['jan'])
    request_url = API_BASES[store] + urllib.parse.quote(query) if store in API_BASES else url
    checked = dt.datetime.now(dt.timezone.utc).isoformat()
    row = {'store_id': store, 'store': name, 'url': url, 'checked_at': checked, 'observed_at': None, 'price': None, 'status': 'error'}
    if product.get('available_from') and dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date().isoformat() < product['available_from']:
        row['status'] = 'unreleased'
        return row
    try:
        request = urllib.request.Request(request_url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' if store in API_BASES else 'text/html'})
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise ValueError('HTTP ' + str(response.status))
            html = response.read(4_000_001)
            if len(html) > 4_000_000:
                raise ValueError('Response exceeds limit')
            body = html.decode('utf-8', errors='replace')
            quote, status = extract_api(json.loads(body), store, product) if store in API_BASES else extract(body, store, product)
        row['status'] = status
        if quote:
            row.update(quote)
            row['url'] = urllib.parse.urljoin(url, row.pop('product_url')) or url
            row['observed_at'] = checked
    except Exception as e:
        row['error'] = type(e).__name__ + ': ' + str(e)[:180]
    return row

def main():
    catalog = json.loads((ROOT / 'data/catalog.json').read_text())
    products = catalog['products']
    assert len({p['id'] for p in products}) == len(products), 'Duplicate product IDs'
    for p in products:
        assert re.fullmatch(r'\d{13}', p['jan']), 'Invalid JAN format'
        if p.get('kind') == 'android':
            assert canonical_jan(p['jan']), 'Invalid Android JAN check digit'
    def crawl_store(store):
        results = []
        for p in products:
            row = fetch_quote(store, p)
            results.append((p['id'], row))
            print(store, p['id'], row['status'], row['price'], flush=True)
            time.sleep(1)
        return results
    grouped = {p['id']: [] for p in products}
    # One serial worker per store; never send concurrent requests to one store.
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(STORES)) as pool:
        for results in pool.map(crawl_store, STORES):
            for product_id, row in results:
                grouped[product_id].append(row)
    # Never carry yesterday's price forward as a new observation.
    result = {'schema_version': 1, 'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'products': grouped}
    target = ROOT / 'data/catalog_prices.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    temp.replace(target)
    if __package__:
        from .pokemon_market import crawl
    else:
        from pokemon_market import crawl
    crawl()

if __name__ == '__main__':
    main()
