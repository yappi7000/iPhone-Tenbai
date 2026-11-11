import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from scripts.catalog_health import anomalies, evaluate, main, summarize

KNOWN = {'kaitorishouten': {'registered': '2026-11-11', 'cause': 'HTTP 403', 'last_success': '2026-10-30', 'evidence': 'x'}}


def row(store_id, status, price=None, error=None):
    return {'store_id': store_id, 'store': store_id.upper(), 'status': status, 'price': price,
            'observed_at': '2026-11-11T00:00:00+00:00' if status == 'ok' else None, 'error': error}


def payload(homura='error', rudeya='ok'):
    return {'generated_at': 'x', 'products': {
        'a': [row('rudeya', rudeya, 1000 if rudeya == 'ok' else None), row('homura', homura, 900 if homura == 'ok' else None, 'HTTPError: HTTP Error 403: Forbidden'),
              row('kaitorishouten', 'error', None, 'HTTPError: HTTP Error 403: Forbidden')],
        'b': [row('rudeya', 'not_found'), row('homura', 'unreleased'), row('kaitorishouten', 'stopped')]}}


class CatalogHealthTests(unittest.TestCase):
    def test_counts_success_and_skips_unreleased(self):
        stores = summarize(payload())
        self.assertEqual((stores['rudeya']['success'], stores['rudeya']['total']), (1, 2))
        self.assertEqual((stores['homura']['success'], stores['homura']['total']), (0, 1))
        self.assertEqual(stores['homura']['top_error'], 'HTTPError: HTTP Error 403: Forbidden')

    def test_ok_without_price_or_time_is_not_success(self):
        data = {'products': {'a': [dict(row('rudeya', 'ok', 1000), observed_at=None)], 'b': [row('rudeya', 'ok', '1000')]}}
        self.assertEqual(summarize(data)['rudeya']['success'], 0)

    def test_known_restriction_is_warning_and_active_store_zero_is_critical(self):
        gate = evaluate(summarize(payload()), KNOWN)
        self.assertEqual([sid for sid, _ in gate['known']], ['kaitorishouten'])
        self.assertEqual([sid for sid, _ in gate['critical']], ['homura'])
        self.assertTrue(gate['failed'])
        self.assertFalse(evaluate(summarize(payload(homura='ok')), KNOWN)['failed'])

    def test_all_zero_is_critical_even_if_known(self):
        gate = evaluate(summarize(payload(homura='error', rudeya='not_found')), dict(KNOWN, homura=KNOWN['kaitorishouten'], rudeya=KNOWN['kaitorishouten']))
        self.assertTrue(gate['all_zero'])
        self.assertTrue(gate['failed'])

    def test_recovered_known_store_is_reported(self):
        gate = evaluate(summarize(payload(homura='ok')), dict(KNOWN, rudeya=KNOWN['kaitorishouten']))
        self.assertEqual([sid for sid, _ in gate['recovered']], ['rudeya'])

    def run_main(self, data, known):
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump(data, f)
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as k:
            json.dump({'catalog': known}, k)
        out = io.StringIO()
        with redirect_stdout(out), patch.dict('os.environ', {}, clear=False) as env:
            env.pop('GITHUB_STEP_SUMMARY', None)
            code = main(['--prices', f.name, '--known', k.name])
        return code, out.getvalue()

    def test_exit_code_and_annotations(self):
        code, out = self.run_main(payload(), KNOWN)
        self.assertEqual(code, 1)
        self.assertIn('::error::HOMURA: 価格0/1件（新規の取得障害）', out)
        self.assertIn('::warning::KAITORISHOUTEN: 価格0/2件（既知のアクセス制限: HTTP 403）', out)
        self.assertIn('既知のアクセス制限で継続して取得できない店舗: 1店舗', out)
        code, out = self.run_main(payload(homura='ok'), KNOWN)
        self.assertEqual(code, 0)
        self.assertIn('::warning::KAITORISHOUTEN', out)

    def test_price_data_anomalies_are_critical_even_when_every_store_has_prices(self):
        base = {'generated_at': '2026-11-11T02:00:00+00:00', 'products': {
            'a': [row('rudeya', 'ok', 1000), row('homura', 'ok', 900)]}}
        self.assertEqual(anomalies(base), [])
        self.assertFalse(evaluate(summarize(base), {}, anomalies(base))['failed'])
        for bad, problem in [({'price': '1000'}, '価格が不正'), ({'price': 0}, '価格が不正'), ({'price': 10000001}, '価格が不正'),
                             ({'observed_at': None}, '取得時刻なし'), ({'observed_at': '2026-11-12T00:00:00+00:00'}, '未来'),
                             ({'observed_at': '2026-11-09T00:00:00+00:00'}, '36時間超')]:
            data = json.loads(json.dumps(base))
            data['products']['a'].append(dict(row('ichome', 'ok', 800), **bad))
            found = anomalies(data)
            self.assertEqual(len(found), 1, bad)
            self.assertIn(problem, found[0]['problem'])
            gate = evaluate(summarize(data), {}, found)
            self.assertTrue(gate['failed'], bad)
        code, out = self.run_main(dict(data, generated_at='2026-11-11T02:00:00+00:00'), {})
        self.assertEqual(code, 1)
        self.assertIn('::error::価格データの異常 a ／ ICHOME: 取得から36時間超', out)


if __name__ == '__main__': unittest.main()
