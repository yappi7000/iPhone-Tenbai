"""Public, exact-product buyback quotes. No guessed prices; isolated from iPhone data."""
import concurrent.futures
import datetime as dt
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import unicodedata
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

def _compact(text):
    """表記ゆれ吸収: 全角/半角(NFKC)・大文字小文字・空白・区切り記号を無視する。"""
    value = unicodedata.normalize('NFKC', str(text or '')).lower()
    return re.sub(r'[\s・･,、/／()（）\-]+', '', value)


def required_name_terms_match(product, text):
    """Require identifying words for products that share a JAN with another item.

    旧実装は r'[\\s　]+' と二重エスケープしていたため空白を除去できず、
    「9種 セット」のような半角スペース入りの掲載を取りこぼし、英字の s を消していた。
    """
    terms = product.get('required_name_terms') or []
    if not terms:
        return True

    value = _compact(text)

    return all(_compact(term) in value for term in terms)


def is_bundle(product):
    return product.get('kind') == 'card_bundle'


def bundle_composition_ok(product, text):
    """9種セット本体の掲載かどうか（単品セットの掲載を除外する）。

    - 「9種」を含むこと
    - 構成9種のうち1種の名前だけを含む掲載は単品セットとみなして除外
      （0種＝構成の記載なし、2種以上＝構成の列挙は許可）
    """
    value = _compact(text)
    if '9種' not in value:
        return False
    names = (product.get('bundle') or {}).get('component_names') or []
    hits = sum(1 for name in names if _compact(name) in value)
    return hits != 1


def is_bundle_listing_for_single(product, name):
    """単品カードセットの検索結果に混ざった「9種セット」の掲載か。

    店舗によっては9種セットの掲載に単品のJANが書かれているため、
    JAN一致だけでは単品と9種セットを区別できない。
    """
    return product.get('kind') == 'card_pack' and '9種' in _compact(name)


def identity_match(product, text, code=None):
    """店舗掲載が対象商品かどうか。

    通常商品: JAN（または店舗コード）の完全一致。
    9種セット: 専用JANが無いため、商品名の必須語と構成で判定する。
               単品セットのJANが同じ掲載に書かれていても、それだけでは一致としない。
    """
    if is_bundle(product):
        return required_name_terms_match(product, text) and bundle_composition_ok(product, text)
    return exact_code(text, code or product['jan'])


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
        name = str(item.get('title' if store == 'ichome' else 'name') or '')
        if is_bundle(product):
            if not identity_match(product, name):
                continue
        elif str(item.get('jan', '')).strip() != product['jan']:
            continue
        if not name or BAD_CONDITION.search(name):
            continue
        if not required_name_terms_match(product, name):
            continue
        if is_bundle_listing_for_single(product, name):
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
                if product.get('kind') == 'card_bundle':
                    if BAD_CONDITION.search(label + ' ' + memo):
                        continue
                elif not re.search(r'未開封', label + ' ' + memo) or BAD_CONDITION.search(label + ' ' + memo):
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
                code = product.get('store_codes', {}).get(store, product.get('jan'))

                # 9種セットは商品名の必須語＋構成で識別する（1商品カード内だけで判定）。
                # 通常商品は従来どおりJAN/店舗コード一致を必須とする。
                if is_bundle(product):
                    if identity_match(product, name + ' ' + p.text()):
                        candidates.append(
                            (
                                name,
                                amount(button.attrs['data-product-price']),
                                p,
                                ''
                            )
                        )
                elif exact_code(p.text(), code):
                    candidates.append(
                        (
                            name,
                            amount(button.attrs['data-product-price']),
                            p,
                            ''
                        )
                    )
    elif store == 'keitaispace':
        # Use only grid cards, not the duplicate mobile/list presentation.
        for p in root.walk():
            if not p.has('product-card'):
                continue
            title, price_node = p.find('product-name'), p.find('price_pro_news')
            if not title or not identity_match(product, title.text()) or not price_node:
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
            if not title or not identity_match(product, title.text()) or not price_node:
                continue
            value = re.sub(r'^\s*買取価格\s*[:：]\s*', '', price_node.text())
            candidates.append((title.text(), amount(value), p, '新品基準。詳細条件は公式商品ページで確認'))
    elif store in ('rudeya', 'morimori'):
        cls = 'pgrid-card' if store == 'rudeya' else 'product-item'
        for p in root.walk():
            if not p.has(cls) or not identity_match(product, p.text()):
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
        if not required_name_terms_match(product, name + ' ' + memo):
            continue
        # 9種セットは採用する商品名そのものでも構成を再確認する
        if is_bundle(product) and not bundle_composition_ok(product, name + ' ' + memo):
            continue
        # 逆方向の混同防止: 単品セットの検索で「9種セット」の掲載を拾わない
        if is_bundle_listing_for_single(product, name):
            continue
        if product['condition'] == 'sealed_box' and not re.search(r'BOX|ボックス', name, re.I):
            continue
        if product['condition'] == 'sealed_box' and store in ('keitaispace', 'kaitoriwiki') and not SEALED.search(name + ' ' + memo):
            continue
        if product['condition'] == 'sealed_set':
            if product.get('kind') == 'card_bundle':
                if BAD_CONDITION.search(name + ' ' + memo):
                    continue
            elif not re.search(r'未開封', name + ' ' + memo) or BAD_CONDITION.search(name + ' ' + memo):
                continue
        if price is None:
            continue
        links = [n.attrs.get('href', '') for n in node.walk() if n.tag == 'a']
        link = next((x for x in links if re.search(r'/products?/+(?:item/)?\d+|/purchase/|[?&]pid=', x)), '')
        matches.append({'price': price, 'matched_name': name, 'product_url': link, 'note': memo})
    return choose(matches)

def fetch_homura_nine_set(product):
    """ホムラの商品一覧ページから 9種セットの掲載を取得する。

    JAN検索では9種セットが出ないため一覧ページを読む。
    旧実装は価格ボタンから親要素へさかのぼり「JANと『9種セット』を含む要素」まで
    広げていたため、単品カードのボタンでも一覧全体まで遡れば一致してしまう恐れがあった。
    ここでは通常の抽出（1商品カード単位・商品名の必須語＋構成で判定）を使う。
    """
    store = 'homura'
    store_name = STORES[store][0]
    url = 'https://kaitori-homura.com/products'
    checked = dt.datetime.now(dt.timezone.utc).isoformat()
    row = {
        'store_id': store,
        'store': store_name,
        'url': url,
        'checked_at': checked,
        'observed_at': None,
        'price': None,
        'status': 'error'
    }
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'})
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise ValueError('HTTP ' + str(response.status))
            raw = response.read(4_000_001)
            if len(raw) > 4_000_000:
                raise ValueError('Response exceeds limit')
            body = raw.decode('utf-8', errors='replace')
        quote, status = extract(body, store, product)
        row['status'] = status
        if quote:
            row.update(quote)
            row['url'] = urllib.parse.urljoin(url, row.pop('product_url')) or url
            row['observed_at'] = checked
            row['note'] = 'ホムラ公開買取価格。9種セットの商品名と構成を照合。' + (' ／ ' + row['note'] if row.get('note') else '')
    except Exception as e:
        row['error'] = type(e).__name__ + ': ' + str(e)[:180]
    return row


def fetch_quote(store, product):
    if store == 'homura' and is_bundle(product):
        return fetch_homura_nine_set(product)

    name, base = STORES[store]
    query = product.get('store_queries', {}).get(store) or product.get('jan') or product['name']
    url = base + urllib.parse.quote(query) if store != 'ichome' else base
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

def validate_catalog(products):
    """カタログ定義の検査。9種セットは単品JANを流用せず、構成リストを持つこと。"""
    by_id = {p['id']: p for p in products}
    jans = [p['jan'] for p in products if not is_bundle(p)]
    assert len(set(jans)) == len(jans), 'Duplicate JAN between products'
    for p in products:
        if is_bundle(p):
            assert p.get('jan') is None, 'Bundle must not reuse a JAN: ' + p['id']
            bundle = p.get('bundle') or {}
            ids = bundle.get('component_ids') or []
            assert len(ids) == len(set(ids)) == len(bundle.get('component_jans') or []) == len(bundle.get('component_names') or []), 'Bundle component list mismatch: ' + p['id']
            for cid, cjan in zip(ids, bundle['component_jans']):
                assert cid in by_id and not is_bundle(by_id[cid]), 'Unknown bundle component: ' + cid
                assert by_id[cid]['jan'] == cjan, 'Bundle component JAN mismatch: ' + cid
            assert '9種セット' in p['name'] and len(ids) == 9, 'Bundle name/count mismatch: ' + p['id']
            continue
        assert re.fullmatch(r'\d{13}', p['jan']), 'Invalid JAN format'
        if p.get('kind') == 'android':
            assert canonical_jan(p['jan']), 'Invalid Android JAN check digit'


def guard_bundle_prices(products, grouped):
    """同じ店舗の単品セット価格以下の「9種セット価格」は単品の混入とみなして除外する。

    9種セットは単品9種を各1点含むので、どれか1種の単品価格以下になることはない。
    """
    for p in products:
        if not is_bundle(p):
            continue
        component_ids = (p.get('bundle') or {}).get('component_ids') or []
        for row in grouped.get(p['id'], []):
            if row.get('status') != 'ok' or not isinstance(row.get('price'), int):
                continue
            singles = [
                r['price'] for cid in component_ids for r in grouped.get(cid, [])
                if r.get('store_id') == row.get('store_id') and r.get('status') == 'ok' and isinstance(r.get('price'), int)
            ]
            if singles and row['price'] <= max(singles):
                row['rejected_price'] = row['price']
                row['price'] = None
                row['observed_at'] = None
                row['status'] = 'rejected'
                row['error'] = '同じ店舗の単品セット価格以下のため、9種セット価格として採用しません'


def main():
    catalog = json.loads((ROOT / 'data/catalog.json').read_text())
    products = catalog['products']
    assert len({p['id'] for p in products}) == len(products), 'Duplicate product IDs'
    validate_catalog(products)
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
    guard_bundle_prices(products, grouped)
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
