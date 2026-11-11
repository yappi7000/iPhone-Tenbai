"""カタログ（ゲーム・カメラ・家電・トレカ・Android）の店舗別取得状況と、取得障害の最終判定。

  python scripts/catalog_health.py [--prices data/catalog_prices.json] [--known scripts/known_store_restrictions.json]

- 店舗別・状態別の件数を Markdown で出力する（GITHUB_STEP_SUMMARY にも追記）。
- 重大（終了コード1・ワークフローを失敗表示）: 既知の制限に無い店舗の取得0件（新規の取得障害）、全店舗の取得0件、
  価格データの異常（取得成功なのに価格が正の整数でない・取得時刻が無い／生成時刻より未来／36時間超）。
- 警告（終了コード0）: 既知のアクセス制限による継続障害。毎回表示し、隠さない。
価格の保存・コミットの後に実行し、価格の更新は止めない。価格は扱わない（推測・補完はしない）。
"""
import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STALE_HOURS = 36
LABELS = {'ok': '成功', 'not_found': '掲載なし', 'condition_mismatch': '条件不一致', 'ambiguous': '特定できず',
          'error': '取得失敗', 'stopped': '停止', 'rejected': '除外', 'unreleased': '発売前'}


def summarize(payload):
    """店舗ごとの件数。発売前（unreleased）は対象数に含めない。"""
    stores = {}
    for rows in (payload.get('products') or {}).values():
        for row in rows:
            status = row.get('status')
            if status == 'unreleased':
                continue
            s = stores.setdefault(row.get('store_id') or row.get('store'), {'store': row.get('store'), 'total': 0, 'by_status': {}, 'errors': {}})
            s['total'] += 1
            ok = status == 'ok' and type(row.get('price')) is int and row.get('observed_at')
            key = 'ok' if ok else (status if status != 'ok' else 'error')
            s['by_status'][key] = s['by_status'].get(key, 0) + 1
            if not ok and row.get('error'):
                reason = ' '.join(str(row['error']).split())[:60]
                s['errors'][reason] = s['errors'].get(reason, 0) + 1
    for s in stores.values():
        s['success'] = s['by_status'].get('ok', 0)
        s['top_error'] = max(s['errors'].items(), key=lambda x: x[1])[0] if s['errors'] else None
        del s['errors']
    return stores


def _time(value):
    try:
        t = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return t if t.tzinfo else None
    except ValueError:
        return None


def anomalies(payload):
    """取得成功（status ok）なのに価格・取得時刻が不正な行。画面では順位に出ないが、データの異常として検知する。"""
    generated = _time(payload.get('generated_at'))
    found = []
    for pid, rows in (payload.get('products') or {}).items():
        for row in rows:
            if row.get('status') != 'ok':
                continue
            price, observed = row.get('price'), _time(row.get('observed_at'))
            if type(price) is not int or not 0 < price <= 10000000:
                problem = f'価格が不正（{price!r}）'
            elif observed is None:
                problem = '取得時刻なし'
            elif generated and observed > generated + dt.timedelta(minutes=5):
                problem = '取得時刻が生成時刻より未来'
            elif generated and generated - observed > dt.timedelta(hours=STALE_HOURS):
                problem = f'取得から{STALE_HOURS}時間超の価格を取得成功として保存'
            else:
                continue
            found.append({'product': pid, 'store': row.get('store'), 'problem': problem})
    return found


def evaluate(stores, known, data_anomalies=()):
    zero = [(sid, s) for sid, s in stores.items() if s['total'] > 0 and s['success'] == 0]
    attempted = [s for s in stores.values() if s['total'] > 0]
    all_zero = bool(attempted) and all(s['success'] == 0 for s in attempted)
    critical = [(sid, s) for sid, s in zero if sid not in known]
    return {'all_zero': all_zero, 'critical': critical, 'anomalies': list(data_anomalies),
            'known': [(sid, s) for sid, s in zero if sid in known],
            'recovered': [(sid, s) for sid, s in stores.items() if sid in known and s['success'] > 0],
            'failed': all_zero or bool(critical) or bool(data_anomalies)}


def report(stores, gate, known, generated_at):
    lines = [f'## カタログの店舗別取得状況（{generated_at}）', '',
             '| 店舗 | 成功 | ' + ' | '.join(LABELS[k] for k in LABELS if k not in ('ok', 'unreleased')) + ' | 主なエラー |',
             '|---|---|' + '---|' * (len(LABELS) - 2) + '---|']
    for sid, s in sorted(stores.items(), key=lambda x: x[1]['success'] / x[1]['total']):
        flag = ' ❗' if s['success'] == 0 else ''
        counts = ' | '.join(str(s['by_status'].get(k, 0)) for k in LABELS if k not in ('ok', 'unreleased'))
        lines.append(f"| {s['store']}{flag} | {s['success']}/{s['total']} | {counts} | {(s['top_error'] or '-').replace('|', '／')} |")
    lines.append('')
    if gate['all_zero']:
        lines.append('### ❌ 重大: 全店舗で価格を1件も取得できませんでした')
    if gate['critical']:
        lines.append(f"### ❌ 重大: 稼働中の店舗で価格0件（新規の取得障害）: {len(gate['critical'])}店舗")
        lines += [f"- {s['store']}: 0/{s['total']}（{s['top_error'] or '-'}）" for _, s in gate['critical']]
    if gate['anomalies']:
        lines.append(f"### ❌ 重大: 価格データの異常: {len(gate['anomalies'])}件")
        lines += [f"- {a['product']} ／ {a['store']}: {a['problem']}" for a in gate['anomalies'][:20]]
    if gate['known']:
        lines.append(f"### ⚠️ 既知のアクセス制限で継続して取得できない店舗: {len(gate['known'])}店舗（回避はしません）")
        lines += [f"- {s['store']}: 0/{s['total']}（{known[sid]['cause']}。登録 {known[sid]['registered']}・最終成功 {known[sid].get('last_success') or '記録なし'}）" for sid, s in gate['known']]
    if gate['recovered']:
        lines.append('### ℹ️ 既知の制限に登録されているが、今回は取得できた店舗（回復の可能性。確認して一覧から外してください）')
        lines += [f"- {s['store']}: {s['success']}/{s['total']}" for _, s in gate['recovered']]
    if not gate['failed']:
        lines.append('### ✅ 稼働中の店舗はすべて1件以上の価格を取得しました' if gate['known'] else '### ✅ 全店舗で1件以上の価格を取得しました')
    return '\n'.join(lines)


def annotations(gate, known):
    out = ['::error::全店舗で価格0件'] if gate['all_zero'] else []
    out += [f"::error::{s['store']}: 価格0/{s['total']}件（新規の取得障害）" for _, s in gate['critical']]
    out += [f"::error::価格データの異常 {a['product']} ／ {a['store']}: {a['problem']}" for a in gate['anomalies'][:20]]
    out += [f"::warning::{s['store']}: 価格0/{s['total']}件（既知のアクセス制限: {known[sid]['cause']}）" for sid, s in gate['known']]
    out += [f"::notice::{s['store']}: 既知の制限に登録済みだが {s['success']}件取得（回復の可能性）" for _, s in gate['recovered']]
    return out


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--prices', default=str(ROOT / 'data/catalog_prices.json'))
    parser.add_argument('--known', default=str(ROOT / 'scripts/known_store_restrictions.json'))
    args = parser.parse_args(argv)
    payload = json.loads(Path(args.prices).read_text())
    known = json.loads(Path(args.known).read_text()).get('catalog', {})
    stores = summarize(payload)
    gate = evaluate(stores, known, anomalies(payload))
    text = report(stores, gate, known, payload.get('generated_at'))
    print(text)
    for line in annotations(gate, known):
        print(line)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
            f.write(text + '\n')
    return 1 if gate['failed'] else 0


if __name__ == '__main__':
    sys.exit(main())
