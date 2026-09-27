import json
import unittest
from html import escape
from unittest.mock import patch
from scripts.pokemon_market import extract_rush, extract_moetaku
from scripts.crawl_catalog import extract, fetch_quote

CHECKED = '2026-09-27T12:00:00+00:00'

def rush(rows, title='pokemon'):
    data = {'props': {'pageProps': {'cardTitle': {'name': title}, 'buyingPrices': rows}}}
    return '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(data) + '</script>'

def row(**kwargs):
    return dict(dict(product_category='シングル', amount=13000000, name='ブラッキー☆',
        model_number='026/PLAY', extra_difference='未開封', pokemon_ocha_product_id=7265), **kwargs)

def moetaku(**kwargs):
    item = dict(dict(code='92725', name='ブラッキー☆(未開封) 026/PLAY', maker='ポケモンカードゲーム', genre='トレカ', price=13000000), **kwargs)
    return '<button data-item="' + escape(json.dumps(item), quote=True) + '"></button>'

class PokemonTests(unittest.TestCase):
    def test_published_amount_and_edition_not_retail_or_campaign(self):
        p = extract_rush(rush([row(selling_price=99999999)]), CHECKED)[0]
        self.assertEqual(p['quotes'][0]['price'], 13000000)
        self.assertEqual(p['condition_label'], '未鑑定・未開封')
        self.assertIn('026/PLAY', p['name'])

    def test_graded_and_invalid_quotes_are_excluded(self):
        rows = [row(), row(pokemon_ocha_product_id=2, extra_difference='PSA10'),
            row(pokemon_ocha_product_id=3, amount='13000000'), row(pokemon_ocha_product_id=4, amount=0),
            row(pokemon_ocha_product_id=5, extra_difference='状態B'), row(pokemon_ocha_product_id=6, product_category='BOX')]
        self.assertEqual(len(extract_rush(rush(rows), CHECKED)), 1)

    def test_changed_source_and_conflicting_identity_fail_closed(self):
        for html in ['<p>販売価格 13000000円</p>', rush([row()], 'yugioh'), rush([row(), row(amount=1)])]:
            with self.assertRaises(ValueError): extract_rush(html, CHECKED)

    def test_moetaku_base_and_mobile_duplicate(self):
        html = moetaku() * 2 + '<p>キャンペーン価格 20000000円</p>'
        self.assertEqual(extract_moetaku(html, '92725', 'ブラッキー☆(未開封) 026/PLAY'), 13000000)

    def test_moetaku_wrong_edition_missing_and_conflicting_prices(self):
        for html in [moetaku(name='ブラッキー☆ 026/PLAY'), moetaku(code='other'), moetaku(price=0), moetaku()+moetaku(price=1)]:
            with self.assertRaises(ValueError): extract_moetaku(html, '92725', 'ブラッキー☆(未開封) 026/PLAY')

    def test_unopened_set_requires_explicit_condition(self):
        p = {'jan':'4521329462189', 'condition':'sealed_set'}
        def html(memo):
            return '<article class="pgrid-card"><h3 class="product-card-name">プレミアムデッキ</h3><span class="is-new">新品</span><p>4521329462189</p><div class="product-card-memo">'+memo+'</div><span class="product-card-price-value">15000円</span></article>'
        self.assertEqual(extract(html('新品未開封'), 'rudeya', p)[0]['price'], 15000)
        self.assertIsNone(extract(html('新品'), 'rudeya', p)[0])
        self.assertIsNone(extract(html('未開封・訳あり'), 'rudeya', p)[0])

    def test_future_product_does_not_fetch_or_rank(self):
        with patch('scripts.crawl_catalog.urllib.request.urlopen') as request:
            q = fetch_quote('rudeya', {'jan':'4521329462189','condition':'sealed_set','available_from':'2999-10-16'})
            self.assertEqual(q['status'], 'unreleased')
            self.assertIsNone(q['price'])
            self.assertIsNone(q['observed_at'])
            request.assert_not_called()

if __name__ == '__main__':
    unittest.main()
