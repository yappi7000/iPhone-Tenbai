import unittest
from scripts.crawl_catalog import extract, extract_api, exact_code, fetch_quote, canonical_jan, fetch_homura_nine_set
from unittest.mock import patch
import json
P = {'jan':'4902370553024','condition':'new'}
def rudeya(jan='4902370553024',price='54,000',name='Switch 2',new=True):
    return f'<article class="pgrid-card"><h3 class="product-card-name"><span class="{"is-new" if new else "is-used"}">{"新品" if new else "中古"}</span>{name}</h3><p>JAN: {jan}</p><span class="product-card-price-value">{price}<span>円</span></span><a href="/product/item/1">詳細</a></article>'
def homura(code,name,price):
    return f'<div><h5>{name}</h5><span>{code}</span><button data-product-id="1" data-product-name="{name}" data-product-price="{price}"></button></div>'
class ExtractTests(unittest.TestCase):
    def test_exact_jan_does_not_match_prefix(self):
        self.assertFalse(exact_code('114521329362342','4521329362342'))
        self.assertIsNone(extract(rudeya(jan='14902370553024'),'rudeya',P)[0])
    def test_condition_and_price(self):
        q,status=extract(rudeya(),'rudeya',P)
        self.assertEqual((q['price'],status),(54000,'ok'))
        self.assertIsNone(extract(rudeya(new=False),'rudeya',P)[0])
        self.assertIsNone(extract(rudeya(price='～54,000'),'rudeya',P)[0])
    def test_ambiguous_prices_are_not_ranked(self):
        self.assertEqual(extract(rudeya()+rudeya(price='53,000'),'rudeya',P)[1],'ambiguous')
    def test_cross_product_price_leak(self):
        html=rudeya(price='ASK')+rudeya(jan='4902370553031',price='58,500')
        self.assertIsNone(extract(html,'rudeya',P)[0])
    def test_box_vs_shrinkless(self):
        p={'jan':'4521329362342','condition':'sealed_box','store_codes':{'homura':'114521329362342'}}
        html=homura('114521329362342','【BOX】テラスタルフェスex','15000')+homura('124521329362342','【シュリンク無しBOX】テラスタルフェスex','10000')
        self.assertEqual(extract(html,'homura',p)[0]['price'],15000)
        self.assertIsNone(extract(homura('124521329362342','【シュリンク無しBOX】テラスタルフェスex','10000'),'homura',p)[0])
    def test_homura_js_shell_is_error_not_not_found(self):
        # 2026-11-11に確認した公開ページの骨格（価格・商品カードなし、件数は「—」のまま）
        shell='<html><body><div id="root"><div>対象商品： — 件</div></div><script src="/_expo/static/js/web/entry-f77e0c.js" defer></script></body></html>'
        with self.assertRaisesRegex(ValueError,'JavaScript描画'):
            extract(shell,'homura',P)
        with patch('scripts.crawl_catalog.urllib.request.urlopen') as urlopen:
            response=urlopen.return_value.__enter__.return_value
            response.status=200
            response.read.return_value=shell.encode()
            row=fetch_homura_nine_set(dict(P,id='switch2-jp',name='Switch 2'))
        self.assertEqual((row['status'],row['price'],row['observed_at']),('error',None,None))
        self.assertIn('ページ構造の変更',row['error'])
        # 従来形式で該当商品がないページは引き続き「掲載なし」
        self.assertEqual(extract('<div><h5>別商品</h5></div>','homura',P),(None,'not_found'))
    def test_morimori_normal_not_deposit(self):
        html='<div class="product-item"><h3>新品 Switch 2</h3>JAN:4902370553024<span class="price-normal-number">54,000円</span><span>預かり買取価格 55,000円</span></div>'
        self.assertEqual(extract(html,'morimori',P)[0]['price'],54000)

def space(jan='4902370553024', price='52,300円', condition='未使用', name='Switch 2'):
    return f'<div class="product-card"><div class="product-name">{name} JAN:{jan}</div><div class="price_pro_news">{condition}<span>{price}</span></div><div class="price_pro_old">中古 60,000円</div><a href="./?pid=123">買取申込</a></div>'

def wiki(jan='4902370553024', price='53,500円', name='Switch 2'):
    return f'<div class="pro_list"><li class="sub-pro-career"><a href="https://gamekaitori.jp/purchase/switch2">{name} {jan}</a></li><li class="sub-pro-jia">買取価格:<span>{price}</span></li></div>'

def shoten():
    return {'total': 1, 'items': [{'id': 23170, 'jan': P['jan'], 'name': 'Switch 2', 'price_undecided': False,
        'free_area': '来店+200円', 'rank_options': [{'label': '新品', 'base': 53300, 'options': [{'name': '来店+200円', 'price_change': 200}]}],
        'prices': [{'label': '新品 来店+200円', 'amount': 53500}], 'price_old': {'amount': 25000}}]}

def ichome():
    return {'code': 200, 'data': {'totalElements': 1, 'content': [{'goodsId': 7048, 'allGoodsKbId': 7078, 'jan': P['jan'],
        'title': 'Switch 2', 'disp': True, 'isKeitaiItem': False, 'kbName': '新品', 'price': 49980,
        'goodsKbDetails': [{'kbDetailName': '新品未使用', 'kbDetailPrice': 53800, 'maxCamPrice': 60000}]}]}}

class MoreStoreTests(unittest.TestCase):
    def test_space_uses_new_price_and_product_link(self):
        q, status = extract(space(), 'keitaispace', P)
        self.assertEqual((q['price'], q['product_url'], status), (52300, './?pid=123', 'ok'))
        self.assertIsNone(extract(space(condition='中古'), 'keitaispace', P)[0])

    def test_space_does_not_mix_neighbor_or_prefix_jan(self):
        self.assertIsNone(extract(space(price='要問合せ') + space(jan='4902370553031'), 'keitaispace', P)[0])
        self.assertIsNone(extract(space(jan='14902370553024'), 'keitaispace', P)[0])

    def test_wiki_used_quotes_do_not_change_new_price(self):
        q, status = extract(wiki() + wiki(name='Switch 2 中古', price='25,000円'), 'kaitoriwiki', P)
        self.assertEqual((q['price'], status), (53500, 'ok'))
        self.assertEqual(q['product_url'], 'https://gamekaitori.jp/purchase/switch2')
        self.assertIsNone(extract(wiki(name='Switch 2 中古'), 'kaitoriwiki', P)[0])

    def test_html_conflicting_new_quotes_are_excluded(self):
        for store, html in [('keitaispace', space() + space(price='54,000円')), ('kaitoriwiki', wiki() + wiki(price='54,000円'))]:
            self.assertEqual(extract(html, store, P)[1], 'ambiguous')

    def test_shoten_base_excludes_visit_bonus(self):
        q, status = extract_api(shoten(), 'kaitorishouten', P)
        self.assertEqual((q['price'], status), (53300, 'ok'))
        self.assertIn('来店+200円', q['note'])
        self.assertEqual(q['product_url'], '/products/detail/23170')

    def test_ichome_ignores_retail_and_campaign_maximum(self):
        q, status = extract_api(ichome(), 'ichome', P)
        self.assertEqual((q['price'], status), (53800, 'ok'))

    def test_api_jan_must_equal_exactly(self):
        for store, payload, key in [('ichome', ichome(), 'content'), ('kaitorishouten', shoten(), 'items')]:
            item = payload['data'][key][0] if store == 'ichome' else payload[key][0]
            item['jan'] = '1' + P['jan']
            self.assertIsNone(extract_api(payload, store, P)[0])

    def test_api_rejects_undecided_hidden_used_and_zero(self):
        d = shoten(); d['items'][0]['price_undecided'] = True
        self.assertIsNone(extract_api(d, 'kaitorishouten', P)[0])
        for key, value in [('disp', False), ('kbName', '中古')]:
            d = ichome(); d['data']['content'][0][key] = value
            self.assertIsNone(extract_api(d, 'ichome', P)[0])
        for value in [0, -1, True, 53000.5, 'ASK']:
            d = ichome(); d['data']['content'][0]['goodsKbDetails'][0]['kbDetailPrice'] = value
            self.assertIsNone(extract_api(d, 'ichome', P)[0])

    def test_api_conflicts_and_truncated_results_are_excluded(self):
        d = ichome(); d['data']['content'][0]['goodsKbDetails'].append({'kbDetailName': '新品', 'kbDetailPrice': 54000})
        self.assertEqual(extract_api(d, 'ichome', P)[1], 'ambiguous')
        d = shoten(); d['total'] = 101
        self.assertEqual(extract_api(d, 'kaitorishouten', P)[1], 'ambiguous')

    def test_box_requires_shrink_confirmation(self):
        p = {**P, 'condition': 'sealed_box'}
        d = ichome(); item = d['data']['content'][0]; item['title'] = 'ポケモン BOX'
        item['goodsKbDetails'] = [{'kbDetailName': 'シュリンク無', 'kbDetailPrice': 10000}, {'kbDetailName': 'シュリンク有', 'kbDetailPrice': 15000}]
        self.assertEqual(extract_api(d, 'ichome', p)[0]['price'], 15000)
        item['goodsKbDetails'] = [{'kbDetailName': '新品', 'kbDetailPrice': 15000}]
        self.assertIsNone(extract_api(d, 'ichome', p)[0])
        self.assertIsNone(extract(space(name='ポケモン BOX', condition='未開封品'), 'keitaispace', p)[0])
        d = shoten(); d['items'][0]['name'] = 'ポケモン BOX'; d['items'][0]['free_area'] = 'シュリンク付き。購入証明原本が必要'
        q, _ = extract_api(d, 'kaitorishouten', p)
        self.assertIn('購入証明原本', q['note'])
        d['items'][0]['free_area'] = 'シュリンクなし'
        self.assertIsNone(extract_api(d, 'kaitorishouten', p)[0])

    def test_unexpected_api_response_is_an_error(self):
        with self.assertRaises(ValueError): extract_api({'code': 401}, 'ichome', P)
        with self.assertRaises(ValueError): extract_api({'items': None}, 'kaitorishouten', P)

    def test_failed_fetch_never_creates_a_price(self):
        with patch('scripts.crawl_catalog.urllib.request.urlopen', side_effect=TimeoutError('test timeout')):
            row = fetch_quote('ichome', P)
        self.assertEqual(row['status'], 'error')
        self.assertIsNone(row['price'])
        self.assertIsNone(row['observed_at'])

ANDROID = {'jan':'0840353922303', 'condition':'new', 'kind':'android'}
def phone_payload():
    return {'code':200,'data':{'totalElements':1,'content':[{
        'goodsId':1263,'allGoodsKbId':1654,'title':'Google Pixel 9a 128GB',
        'disp':True,'isKeitaiItem':True,'kbName':'新品','kbDesc':'△-7000',
        'hasLimit':True,'kbCount':8,'kbCountPerAppli':10,'price':79900,
        'goodsKbDetails':[
            {'allGoodsKbDetailId':2440,'kbDetailName':'未開封','kbDetailPrice':61500,'maxCamPrice':99999},
            {'allGoodsKbDetailId':3052,'kbDetailName':'開封','kbDetailPrice':70000}],
        'keitaiColorOptions':[
            {'jan':'840353922303','color':'Obsidian','publicPrice':79900,'keitaiKbDetailColorRels':[
                {'keitaiKbDetailId':2440,'varPrice':-1000},{'keitaiKbDetailId':3052,'varPrice':0}]},
            {'jan':'840353922358','color':'Porcelain','keitaiKbDetailColorRels':[
                {'keitaiKbDetailId':2440,'varPrice':2000}]}]
    }]}}

class AndroidTests(unittest.TestCase):
    def test_upc_and_jan_require_valid_exact_trade_item(self):
        self.assertEqual(canonical_jan('840353922303'),ANDROID['jan'])
        for code in ['1840353922303','00840353922303','84035392230','0840353922304','0840353922303rt',None]:
            self.assertIsNone(canonical_jan(code))

    def test_phone_uses_exact_color_and_condition_price(self):
        q,status=extract_api(phone_payload(),'ichome',ANDROID)
        self.assertEqual((q['price'],status),(60500,'ok'))
        self.assertIn('Obsidian',q['matched_name'])
        self.assertIn('△-7000',q['note'])
        self.assertEqual(q['product_url'],'/productDetail/1263/1654')

    def test_phone_does_not_borrow_other_color_or_guess_missing_jan(self):
        for jan in [None,'0840353922518','0840353922303rt']:
            d=phone_payload();d['data']['content'][0]['keitaiColorOptions'][0]['jan']=jan
            self.assertIsNone(extract_api(d,'ichome',ANDROID)[0])

    def test_phone_requires_explicit_condition_color_relation(self):
        for rels in [[],[{'keitaiKbDetailId':3052,'varPrice':0}],[{'keitaiKbDetailId':2440}]]:
            d=phone_payload();d['data']['content'][0]['keitaiColorOptions'][0]['keitaiKbDetailColorRels']=rels
            self.assertIsNone(extract_api(d,'ichome',ANDROID)[0])

    def test_phone_null_difference_is_zero_but_malformed_is_rejected(self):
        for delta,expected in [(None,61500),(0,61500),(-61500,None),(True,None),('1000',None)]:
            d=phone_payload();d['data']['content'][0]['keitaiColorOptions'][0]['keitaiKbDetailColorRels'][0]['varPrice']=delta
            q,_=extract_api(d,'ichome',ANDROID)
            self.assertEqual(q['price'] if q else None,expected)

    def test_phone_hidden_used_sold_out_and_conflicts_are_excluded(self):
        for key,value in [('disp',False),('kbName','中古'),('kbCount',0)]:
            d=phone_payload();d['data']['content'][0][key]=value
            self.assertIsNone(extract_api(d,'ichome',ANDROID)[0])
        d=phone_payload();d['data']['content'][0]['keitaiColorOptions'][0]['keitaiKbDetailColorRels'].append({'keitaiKbDetailId':2440,'varPrice':2000})
        self.assertEqual(extract_api(d,'ichome',ANDROID)[1],'ambiguous')

    def test_phone_never_applies_to_existing_non_android_products(self):
        self.assertIsNone(extract_api(phone_payload(),'ichome',{'jan':ANDROID['jan'],'condition':'new'})[0])



def homura_api(*items, total=None):
    return {'data': list(items), 'meta': {'total_count': len(items) if total is None else total, 'total_pages': 1, 'current_page': 1, 'per_page': 20}}

def homura_item(jan='4902370553024', price=52400, name='Nintendo Switch 2 日本国内専用版', notes='新品未使用品のみ', item_id=5148):
    return {'id': item_id, 'name': name, 'price': price, 'jan_code': jan, 'notes': notes, 'promoted': True}

class HomuraApiTests(unittest.TestCase):
    # 2026-11-11に keyword=4902370553024 で確認した公開応答の形（必要な項目のみ）
    SWITCH2 = dict(P, id='switch2-jp', name='Nintendo Switch 2 日本国内専用版')
    BOX = {'jan': '4521329362342', 'condition': 'sealed_box', 'store_codes': {'homura': '114521329362342'}}

    def test_exact_jan_new_condition_price(self):
        q, status = extract_api(homura_api(homura_item()), 'homura', self.SWITCH2)
        self.assertEqual((status, q['price'], q['product_url']), ('ok', 52400, 'https://kaitori-homura.com/products/5148'))
        self.assertIn('新品未使用品のみ', q['note'])

    def test_jan_prefix_or_other_product_is_not_used(self):
        self.assertEqual(extract_api(homura_api(homura_item(jan='14902370553024')), 'homura', self.SWITCH2), (None, 'not_found'))
        self.assertEqual(extract_api(homura_api(homura_item(jan='4902370553031', price=58000)), 'homura', self.SWITCH2), (None, 'not_found'))

    def test_unclear_or_used_condition_is_not_used(self):
        for notes, reason in [('', '新品・未使用の明記なし'), ('※状態により減額', '新品・未使用の明記なし'),
                              ('中古品のみ', '除外語「中古」を含む'), ('開封済も可', '除外語「開封済」を含む')]:
            quote, status = extract_api(homura_api(homura_item(notes=notes)), 'homura', self.SWITCH2)
            self.assertEqual((status, quote), ('condition_mismatch', {'reason': reason}), notes)

    def test_invalid_price_is_not_used(self):
        for price in [None, 0, -1, '52400', 52400.5, 10000001]:
            self.assertEqual(extract_api(homura_api(homura_item(price=price)), 'homura', self.SWITCH2), ({'reason': '価格が正の整数でない'}, 'condition_mismatch'), price)

    def test_multiple_candidates(self):
        same = homura_api(homura_item(), homura_item(item_id=5149))
        self.assertEqual(extract_api(same, 'homura', self.SWITCH2)[0]['price'], 52400)
        diff = homura_api(homura_item(), homura_item(price=50000, item_id=5149))
        self.assertEqual(extract_api(diff, 'homura', self.SWITCH2), (None, 'ambiguous'))
        # 結果が1ページに収まらない場合は一部だけで判断しない
        self.assertEqual(extract_api(homura_api(homura_item(), total=21), 'homura', self.SWITCH2), (None, 'ambiguous'))

    def test_box_uses_store_code_and_sealed_condition(self):
        shrink = homura_item(jan='114521329362342', price=15000, name='【BOX】テラスタルフェスex', notes='シュリンク付き未開封のみ')
        no_shrink = homura_item(jan='124521329362342', price=10000, name='【シュリンク無しBOX】テラスタルフェスex', notes='未開封のみ')
        self.assertEqual(extract_api(homura_api(shrink, no_shrink), 'homura', self.BOX)[0]['price'], 15000)
        unclear = dict(shrink, notes='')
        self.assertEqual(extract_api(homura_api(unclear), 'homura', self.BOX), ({'reason': 'BOX・未開封の明記なし'}, 'condition_mismatch'))
        # 検索結果に該当コードがなければ「掲載なし」（条件不一致と区別）
        self.assertEqual(extract_api(homura_api(no_shrink), 'homura', self.BOX), (None, 'not_found'))
        self.assertEqual(extract_api(homura_api(), 'homura', self.BOX), (None, 'not_found'))

    def test_condition_mismatch_row_keeps_reason_without_price(self):
        with patch('scripts.crawl_catalog.urllib.request.urlopen') as urlopen:
            response = urlopen.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = json.dumps(homura_api(homura_item(notes='開封済も可'))).encode()
            row = fetch_quote('homura', self.SWITCH2)
        self.assertEqual((row['status'], row['price'], row['observed_at'], row['reason']), ('condition_mismatch', None, None, '除外語「開封済」を含む'))
        self.assertNotIn('note', row)

    def test_unexpected_schema_is_error(self):
        with self.assertRaises(ValueError):
            extract_api({'items': []}, 'homura', self.SWITCH2)
        with patch('scripts.crawl_catalog.urllib.request.urlopen') as urlopen:
            response = urlopen.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'<html><div id="root"></div></html>'
            row = fetch_quote('homura', self.SWITCH2)
        self.assertEqual((row['status'], row['price'], row['observed_at']), ('error', None, None))

    def test_fetch_quote_uses_keyword_api_once(self):
        with patch('scripts.crawl_catalog.urllib.request.urlopen') as urlopen:
            response = urlopen.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = json.dumps(homura_api(homura_item()), ensure_ascii=False).encode()
            row = fetch_quote('homura', self.SWITCH2)
        self.assertEqual(urlopen.call_count, 1)
        request = urlopen.call_args[0][0]
        self.assertEqual(request.full_url, 'https://api.kaitori-homura.com/api/v1/products?keyword=4902370553024')
        self.assertEqual(request.get_header('Accept'), 'application/json')
        self.assertEqual((row['status'], row['price'], row['url']), ('ok', 52400, 'https://kaitori-homura.com/products/5148'))
        self.assertEqual(row['observed_at'], row['checked_at'])

    def test_http_error_is_error_without_retry(self):
        import urllib.error
        with patch('scripts.crawl_catalog.urllib.request.urlopen', side_effect=urllib.error.HTTPError('u', 429, 'Too Many Requests', {}, None)) as urlopen:
            row = fetch_quote('homura', self.SWITCH2)
        self.assertEqual(urlopen.call_count, 1)
        self.assertEqual((row['status'], row['price']), ('error', None))
        self.assertIn('429', row['error'])

class StoreHaltTests(unittest.TestCase):
    PRODUCTS = [dict(P, id='p%d' % i, name='Switch 2', jan='490237055302%d' % i) for i in range(4)]

    def run_store(self, store, effects):
        import scripts.crawl_catalog as cc
        sleeps = []
        responses = iter(effects)
        def fake_urlopen(request, timeout):
            effect = next(responses)
            if isinstance(effect, BaseException):
                raise effect
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.status = 200
            response.__enter__.return_value.read.return_value = effect
            return response
        with patch('scripts.crawl_catalog.urllib.request.urlopen', side_effect=fake_urlopen) as urlopen:
            results = cc.crawl_store(store, self.PRODUCTS, sleep=sleeps.append)
        return [row for _, row in results], urlopen.call_count, sleeps

    def ok_body(self, i):
        return json.dumps(homura_api(homura_item(jan=self.PRODUCTS[i]['jan']))).encode()

    def test_homura_waits_five_seconds_between_sequential_requests(self):
        rows, calls, sleeps = self.run_store('homura', [self.ok_body(i) for i in range(4)])
        self.assertEqual([r['status'] for r in rows], ['ok'] * 4)
        self.assertEqual((calls, sleeps), (4, [5, 5, 5]))

    def test_homura_halts_for_the_day_without_retry(self):
        import urllib.error
        triggers = [urllib.error.HTTPError('u', code, 'x', {}, None) for code in (403, 429, 503)]
        triggers += [TimeoutError('timed out'), urllib.error.URLError(TimeoutError('timed out')), ConnectionResetError('reset'),
                     b'<html></html>', json.dumps({'items': []}).encode()]
        for trigger in triggers:
            rows, calls, _ = self.run_store('homura', [self.ok_body(0), trigger])
            self.assertEqual(calls, 2, trigger)  # 停止後は送らず、再試行もしない
            self.assertEqual([r['status'] for r in rows], ['ok', 'error', 'stopped', 'stopped'], trigger)
            self.assertTrue(all(r['price'] is None and r['observed_at'] is None for r in rows[1:]))
            self.assertIn('リクエストを送信していません', rows[2]['error'])
            self.assertNotIn('_halt', rows[1])

    def test_homura_continues_after_non_blocking_error(self):
        import urllib.error
        rows, calls, _ = self.run_store('homura', [urllib.error.HTTPError('u', 404, 'x', {}, None)] + [self.ok_body(i) for i in range(1, 4)])
        self.assertEqual(calls, 4)
        self.assertEqual([r['status'] for r in rows], ['error', 'ok', 'ok', 'ok'])

    def test_other_stores_are_not_halted(self):
        import urllib.error
        blocked = urllib.error.HTTPError('u', 403, 'x', {}, None)
        rows, calls, sleeps = self.run_store('rudeya', [blocked, blocked, rudeya(jan=self.PRODUCTS[2]['jan']).encode(), blocked])
        self.assertEqual((calls, sleeps), (4, [1, 1, 1]))
        self.assertEqual([r['status'] for r in rows], ['error', 'error', 'ok', 'error'])


if __name__ == '__main__': unittest.main()
