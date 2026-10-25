"""ポケモンカード30周年 9種セットの回帰テスト（第3段階）

- 単品JANを9種セットのJANとして流用しない
- 商品名照合の正規表現バグ（空白除去・英字 s 消失）の修正
- セット名と構成の一致
- 単品価格が9種セット価格として混入しない（その逆も）
- 比較サイトの価格は参考情報として区別し、順位に入れない
ネットワークには接続しない。
"""
import copy
import io
import json
import unittest
from pathlib import Path
from unittest import mock

from scripts import crawl_catalog as cc
from scripts.crawl_catalog import (
    extract, extract_api, required_name_terms_match, bundle_composition_ok,
    validate_catalog, guard_bundle_prices,
)

ROOT = Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT / 'data/catalog.json').read_text(encoding='utf-8'))['products']
BY_ID = {p['id']: p for p in CATALOG}
BUNDLE = BY_ID['pokemon-30th-celebration-cardset-9']
SINGLE = BY_ID['pokemon-30th-4521329462295']  # フシギダネ・ヒトカゲ・ゼニガメ
SINGLE_JAN = '4521329462295'


def rudeya_card(name, jan, price, memo=''):
    return (
        '<article class="pgrid-card"><h3 class="product-card-name"><span class="is-new">新品</span>'
        f'{name}</h3><p>JAN: {jan}</p><span class="product-card-price-value">{price}<span>円</span></span>'
        f'<p class="product-card-memo">{memo}</p><a href="/product/item/1">詳細</a></article>'
    )


def homura_card(pid, name, jan, price):
    return (
        f'<div class="card"><h3>{name}</h3><p>JAN {jan}</p>'
        f'<span data-product-id="{pid}"></span>'
        f'<button data-product-price="{price}" data-product-name="{name}">買取</button>'
        f'<a href="/products/{pid}">詳細</a></div>'
    )


NINE = 'ポケモンカードゲーム MEGA 30th CELEBRATION カードセット 9種セット 未開封'
ONE = 'ポケモンカードゲーム MEGA 30th CELEBRATION カードセット フシギダネ・ヒトカゲ・ゼニガメ 未開封'


class CatalogDefinitionTest(unittest.TestCase):
    def test_bundle_does_not_reuse_single_jan(self):
        self.assertIsNone(BUNDLE['jan'])
        self.assertEqual(SINGLE['jan'], SINGLE_JAN)
        validate_catalog(CATALOG)

    def test_bundle_has_nine_components_matching_catalog(self):
        b = BUNDLE['bundle']
        self.assertEqual(len(b['component_ids']), 9)
        for cid, jan in zip(b['component_ids'], b['component_jans']):
            self.assertEqual(BY_ID[cid]['jan'], jan)
            self.assertEqual(BY_ID[cid]['kind'], 'card_pack')

    def test_validation_rejects_reused_jan(self):
        products = copy.deepcopy(CATALOG)
        next(p for p in products if p['id'] == BUNDLE['id'])['jan'] = SINGLE_JAN
        with self.assertRaises(AssertionError):
            validate_catalog(products)

    def test_validation_rejects_component_mismatch(self):
        products = copy.deepcopy(CATALOG)
        b = next(p for p in products if p['id'] == BUNDLE['id'])
        b['bundle']['component_jans'][0] = '4521329462325'
        with self.assertRaises(AssertionError):
            validate_catalog(products)


class NameMatchTest(unittest.TestCase):
    def test_regex_bug_fixed_spaces_and_letter_s(self):
        p = {'required_name_terms': ['9種セット']}
        self.assertTrue(required_name_terms_match(p, 'カードセット 9種 セット'))
        self.assertTrue(required_name_terms_match(p, 'カードセット ９種　セット'))
        self.assertEqual(cc._compact('Sets'), 'sets')

    def test_composition_rejects_single_listing(self):
        self.assertTrue(bundle_composition_ok(BUNDLE, NINE))
        self.assertFalse(bundle_composition_ok(BUNDLE, ONE))
        # 「9種セットもあります」と書かれた単品の掲載（構成名が1種だけ）は除外
        self.assertFalse(bundle_composition_ok(BUNDLE, ONE + ' ※9種セットもあります'))
        # 構成を列挙した9種セットは許可
        listing = NINE + ' ' + ' '.join(BUNDLE['bundle']['component_names'])
        self.assertTrue(bundle_composition_ok(BUNDLE, listing))


class ExtractionTest(unittest.TestCase):
    def test_rudeya_bundle_matches_only_nine_set_card(self):
        html = rudeya_card(ONE, SINGLE_JAN, '2,000') + rudeya_card(NINE, SINGLE_JAN, '21,000')
        quote, status = extract(html, 'rudeya', BUNDLE)
        self.assertEqual(status, 'ok')
        self.assertEqual(quote['price'], 21000)

    def test_rudeya_single_never_returned_as_bundle(self):
        quote, status = extract(rudeya_card(ONE, SINGLE_JAN, '2,000'), 'rudeya', BUNDLE)
        self.assertIsNone(quote)
        self.assertEqual(status, 'not_found')

    def test_single_search_ignores_nine_set_listing_with_same_jan(self):
        html = rudeya_card(ONE, SINGLE_JAN, '2,000') + rudeya_card(NINE, SINGLE_JAN, '21,000')
        quote, status = extract(html, 'rudeya', SINGLE)
        self.assertEqual(status, 'ok')
        self.assertEqual(quote['price'], 2000)

    def test_homura_list_page_does_not_borrow_single_price(self):
        # 旧実装の不具合: 単品カードの価格ボタンから一覧全体まで遡り、
        # 一覧内の別カードの「9種セット」の文字で一致していた
        page = '<div class="list"><h2>30th 9種セット 特集</h2>' + homura_card(1, ONE, SINGLE_JAN, '2000') + '</div>'
        quote, status = extract(page, 'homura', BUNDLE)
        self.assertIsNone(quote)

        page = '<div class="list">' + homura_card(1, ONE, SINGLE_JAN, '2000') + homura_card(2, NINE, SINGLE_JAN, '21000') + '</div>'
        quote, status = extract(page, 'homura', BUNDLE)
        self.assertEqual(status, 'ok')
        self.assertEqual(quote['price'], 21000)

    def test_homura_nine_set_fetch_uses_card_scoped_matching(self):
        page = '<div class="list">' + homura_card(1, ONE, SINGLE_JAN, '2000') + homura_card(2, NINE, SINGLE_JAN, '21000') + '</div>'

        class Resp(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False

        with mock.patch.object(cc.urllib.request, 'urlopen', return_value=Resp(page.encode())):
            row = cc.fetch_quote('homura', BUNDLE)
        self.assertEqual(row['status'], 'ok')
        self.assertEqual(row['price'], 21000)
        self.assertTrue(row['url'].endswith('/products/2'))

    def test_api_bundle_by_name_and_single_excludes_bundle(self):
        def item(i, name, price):
            return {'id': i, 'jan': SINGLE_JAN, 'name': name, 'price_undecided': False,
                    'rank_options': [{'label': '未開封', 'base': price}], 'prices': [], 'free_area': ''}
        payload = {'total': 2, 'items': [item(1, ONE, 2000), item(2, NINE, 21000)]}
        quote, _ = extract_api(payload, 'kaitorishouten', BUNDLE)
        self.assertEqual(quote['price'], 21000)
        quote, _ = extract_api(payload, 'kaitorishouten', SINGLE)
        self.assertEqual(quote['price'], 2000)


class GuardTest(unittest.TestCase):
    def rows(self, store, price, status='ok'):
        return {'store_id': store, 'store': store, 'price': price, 'status': status, 'observed_at': '2026-10-25T00:00:00+00:00'}

    def test_bundle_price_not_above_single_is_rejected(self):
        grouped = {BUNDLE['id']: [self.rows('rudeya', 2000), self.rows('homura', 21000)],
                   SINGLE['id']: [self.rows('rudeya', 2000), self.rows('homura', 2500)]}
        for cid in BUNDLE['bundle']['component_ids'][1:]:
            grouped[cid] = []
        guard_bundle_prices(CATALOG, grouped)
        rudeya, homura = grouped[BUNDLE['id']]
        self.assertEqual(rudeya['status'], 'rejected')
        self.assertIsNone(rudeya['price'])
        self.assertEqual(rudeya['rejected_price'], 2000)
        self.assertEqual(homura['status'], 'ok')
        self.assertEqual(homura['price'], 21000)

    def test_guard_only_compares_same_store(self):
        grouped = {BUNDLE['id']: [self.rows('ichome', 3000)], SINGLE['id']: [self.rows('rudeya', 5000)]}
        guard_bundle_prices(CATALOG, grouped)
        self.assertEqual(grouped[BUNDLE['id']][0]['status'], 'ok')


class ComparisonSiteTest(unittest.TestCase):
    def test_comparison_site_prices_are_reference_only(self):
        from scripts import refresh_30th_sets as r
        html = ('<table><tr><td>買取ホムラ</td><td>¥21,000</td></tr>'
                '<tr><td>買取ルデヤ</td><td>取扱なし</td></tr></table>')

        class Resp(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False

        with mock.patch.object(r.urllib.request, 'urlopen', return_value=Resp(html.encode())):
            rows = r.fetch_nine_set_fallback()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row['status'], 'reference')
        self.assertEqual(row['source_type'], 'comparison_site')
        self.assertIsNone(row['price'])
        self.assertIsNone(row['observed_at'])
        self.assertEqual(row['reference_price'], 21000)


if __name__ == '__main__':
    unittest.main()
