"""Published single-card buyback offers, separate from estimates and auction sales."""
import datetime as dt
from html import unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import unicodedata
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUSH_URL = 'https://cardrush.media/pokemon/buying_prices'
MOETAKU = [
    ('101985', 'moetaku-101985', 'ポケモンイラストレーター [旧裏面] コロコロコミックイラストコンテスト', '旧裏面・プロモ', '未鑑定・美品基準'),
    ('92725', 'cardrush-7265', 'ブラッキー☆(未開封) [プレイヤーズけいけんち70000EXP] 026/PLAY', '026/PLAY', '未鑑定・未開封'),
    ('92724', 'cardrush-7692', 'ブラッキー☆ [プレイヤーズけいけんち70000EXP] 026/PLAY', '026/PLAY', '未鑑定・美品基準'),
    ('101528', 'moetaku-101528', 'リザードン LV.76(第1弾初版・かいりき) [旧裏面] No.006', '旧裏面・初版・No.006', '未鑑定・美品基準'),
    ('99645', 'moetaku-99645', 'リーリエ SR [GXバトルブースト] SM4+ 119/114', 'SM4+ 119/114', '未鑑定・美品基準'),
]

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'})
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read(4_000_001)
    if len(raw) > 4_000_000:
        raise ValueError('Response exceeds limit')
    return raw.decode('utf-8', errors='replace')

def card(product_id, name, model, condition, source):
    return {'id': product_id, 'category': 'cards', 'kind': 'single_card', 'name': name,
        'model': model, 'condition': 'single_card', 'condition_label': condition,
        'aliases': ['ポケモン', 'ポケカ', 'シングル'], 'identity_source': source, 'quotes': []}

def quote(store_id, store, price, url, checked, note, name):
    return {'store_id': store_id, 'store': store, 'price': price, 'url': url,
        'status': 'ok', 'checked_at': checked, 'observed_at': checked, 'note': note, 'matched_name': name}

def extract_rush(html, checked):
    m = re.search(r'<script\b[^>]*\bid=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise ValueError('Missing official price data')
    data = json.loads(m[1])['props']['pageProps']
    if data.get('cardTitle', {}).get('name') != 'pokemon':
        raise ValueError('Not a Pokemon buying list')
    rows = data.get('buyingPrices')
    if not isinstance(rows, list):
        raise ValueError('Unexpected buying list')
    products = {}
    for row in rows:
        value = row.get('amount')
        if row.get('product_category') != 'シングル' or type(value) is not int or not 0 < value <= 1000000000:
            continue
        name, model, variant = (str(row.get(k) or '').strip() for k in ('name', 'model_number', 'extra_difference'))
        if not name or not model or re.search(r'PSA|BGS|ARS|鑑定|状態[BCD]|傷|キズ', name + ' ' + variant, re.I):
            continue
        ident = row.get('pokemon_ocha_product_id')
        if type(ident) is not int or ident <= 0:
            continue
        product_id = 'cardrush-' + str(ident)
        display = ' '.join(x for x in [name, str(row.get('rarity') or '').replace('-', ''), model, variant] if x)
        url = RUSH_URL + '?name=' + urllib.parse.quote(name)
        condition = '未鑑定・未開封' if '未開封' in variant else '未鑑定・美品基準'
        p = card(product_id, display, model, condition, url)
        p['aliases'].extend(str(row.get('searchable_name') or '').split(','))
        p['aliases'].extend([str(row.get('pack_name') or ''), str(row.get('pack_code') or '')])
        note = '通常の公開買取価格。版・状態による査定あり。PSA等の鑑定価格・キャンペーン加算は含みません。'
        if row.get('updated_at'):
            p['source_updated_at'] = str(row['updated_at'])
        p['quotes'] = [quote('cardrush', 'カードラッシュ', value, url, checked, note, display)]
        if product_id in products:
            raise ValueError('Duplicate card identity in buying list')
        products[product_id] = p
    if not products:
        raise ValueError('No verified single-card prices')
    return list(products.values())

class Items(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.items = []
        self.feed(html)
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'data-item' in attrs:
            self.items.append(json.loads(attrs['data-item']))

def normalized_name(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', unescape(value)))

def extract_moetaku(html, code, expected_name):
    items = [x for x in Items(html).items if str(x.get('code')) == code]
    amounts = set()
    for item in items:
        if normalized_name(str(item.get('name') or '')) != normalized_name(expected_name):
            raise ValueError('Card edition does not match')
        value = item.get('price')
        if item.get('maker') != 'ポケモンカードゲーム' or item.get('genre') != 'トレカ' or type(value) is not int or not 0 < value <= 1000000000:
            raise ValueError('Invalid base buying price')
        amounts.add(value)
    if len(amounts) != 1:
        raise ValueError('Missing or conflicting card prices')
    return amounts.pop()

def crawl():
    products, errors = {}, []
    checked = dt.datetime.now(dt.timezone.utc).isoformat()
    try:
        products = {p['id']: p for p in extract_rush(fetch(RUSH_URL), checked)}
    except Exception as e:
        errors.append('カードラッシュ: ' + type(e).__name__ + ': ' + str(e)[:120])
    for code, product_id, name, model, condition in MOETAKU:
        url = 'https://www.netoff.co.jp/moetaku/detail/' + code
        existing = products.get(product_id)
        if existing and (existing['model'] != model or existing['condition_label'] != condition or 'ブラッキー☆' not in existing['name']):
            product_id = 'moetaku-' + code
        p = products.setdefault(product_id, card(product_id, name, model, condition, url))
        checked = dt.datetime.now(dt.timezone.utc).isoformat()
        try:
            value = extract_moetaku(fetch(url), code, name)
            p['quotes'].append(quote('moetaku', 'もえたく！', value, url, checked,
                '通常の公開買取価格。美品等の状態条件は公式で確認。まとめ売り・未開封加算・PSA加算は含みません。', name))
        except Exception as e:
            errors.append('もえたく！ ' + code + ': ' + type(e).__name__ + ': ' + str(e)[:120])
            p['quotes'].append({'store_id': 'moetaku', 'store': 'もえたく！', 'url': url,
                'status': 'error', 'price': None, 'observed_at': None, 'checked_at': checked})
        time.sleep(1)
    for number in (1, 3):
        product_id = 'trophy-pikachu-no' + str(number)
        p = card(product_id, 'トロフィーピカチュウ No.' + str(number), '配布年・大会・版の指定が必要',
            '公開買取価格未確認', 'https://torecamap.co.jp/column/pokemon-kougaku/')
        p.update(kind='card_reference', reference_note='同じ通称でも年・大会・鑑定ランクで別商品です。過去の落札額を現在の買取価格には使いません。')
        products[product_id] = p
    # BEGIN featured set single cards (M2/M6)
    # Missing official quotes must remain unavailable; never invent a buyback value.
    reference_file = ROOT / 'data/featured_single_cards.json'
    for entry in json.loads(reference_file.read_text(encoding='utf-8'))['cards']:
        code, number, rarity = entry['set_code'], entry['number'], entry['rarity']
        ident = 'set-' + code.lower() + '-' + number.split('/')[0]
        exact = next((p for p in products.values()
                      if p.get('kind') == 'single_card'
                      and p.get('model') == number
                      and code in p.get('aliases', [])
                      and rarity in p.get('name', '').split()), None)
        if exact:
            exact['aliases'].extend([entry['set_name'], code, number, rarity])
            continue
        if ident in products:
            raise ValueError('Featured identity conflicts with market card: ' + ident)
        p = card(ident, entry['name'] + ' ' + rarity + ' [' + entry['set_name'] + '] ' +
                 code + ' ' + number, number, '未鑑定・美品基準', entry['identity_source'])
        p.update(kind='card_reference', reference_note=(
            '公式収録カードとして登録。公開買取価格は未取得です。販売価格や推定額を買取価格として表示しません。'),
            aliases=p['aliases'] + [entry['set_name'], code, number, rarity])
        products[ident] = p
    # END featured set single cards (M2/M6)
    result = {'schema_version': 1, 'generated_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'scope': 'カードラッシュの公開買取一覧先頭100件と、もえたく！の登録5商品。版・状態別。市場全体の順位ではありません。',
        'products': list(products.values()), 'errors': errors}
    target = ROOT / 'data/pokemon_market.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    temp.replace(target)
    print('Pokemon single cards:', len(products), 'source errors:', len(errors), flush=True)
    return result

if __name__ == '__main__':
    crawl()
