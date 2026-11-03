(function (root) {
  'use strict';

  /*
   * 店舗ごとの価格取得結果の分類（iPhone買取価格）
   *
   * crawler.js（診断・保存）、verify_prices.js（検証）、index.html（表示）が共通で使う。
   *
   * 分類（outcome）
   *   success           : 色別検証済みの価格を取得できた
   *   no_price          : ページは正常に取得できたが、対象商品の掲載が無かった
   *   connection_error  : 接続切断・名前解決失敗・HTTP 5xx など通信・サーバー側の失敗
   *   timeout           : タイムアウト
   *   blocked           : HTTP 403 / 429、WAF・CDN の遮断ページ（アクセス制限）
   *   extraction_failed : 商品は見つかったが価格を抽出・検証できなかった
   *   stopped           : 同一実行内でアクセス制限を検知したため、この店舗へのアクセスを止めた（未試行）
   *
   * stopped は「アクセスしていない」ので失敗には数えない。
   */

  const OUTCOMES = [
    'success',
    'no_price',
    'connection_error',
    'timeout',
    'blocked',
    'extraction_failed',
    'stopped'
  ];

  // 失敗として数える分類（no_price は掲載なし、stopped は未試行なので含めない）
  const FAILURE_OUTCOMES = ['connection_error', 'timeout', 'blocked', 'extraction_failed'];

  const OUTCOME_LABELS = {
    success: '取得成功',
    no_price: '掲載なし',
    connection_error: '接続エラー',
    timeout: 'タイムアウト',
    blocked: 'アクセス制限',
    extraction_failed: '抽出失敗',
    stopped: 'アクセス停止'
  };

  /*
   * 遮断ページと判断できるタイトル（明確なものだけ）。
   * CloudFront の「The request could not be satisfied」は 502/504 でも出るため、
   * タイトルだけでは判定せず HTTP 403 / 429 のときに限って遮断とみなす。
   */
  const BLOCK_PAGE_TITLE = /Webサイトファイアウォール|Attention Required! \| Cloudflare|Access Denied|Request Rejected|Just a moment\.\.\./i;

  const BLOCK_HTTP_STATUS = new Set([403, 429]);

  const TIMEOUT_ERROR = /timeout|timed out|タイムアウト|ETIMEDOUT/i;

  const CONNECTION_ERROR = /socket hang up|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|net::ERR_|ERR_CONNECTION|ERR_HTTP2|ERR_SSL|certificate/i;

  function errorText(row) {
    return (Array.isArray(row && row.errors) ? row.errors : []).join(' / ');
  }

  function httpStatus(row) {
    const status = row && row.http ? row.http.status : null;
    return Number.isInteger(status) ? status : null;
  }

  /*
   * WAF・CDN の遮断ページだと明確に分かるか（タイトルで判定）
   */
  function hasBlockPageSignature(row) {
    const title = row && row.page ? String(row.page.title || '') : '';
    return BLOCK_PAGE_TITLE.test(title);
  }

  /*
   * アクセス制限か（HTTP 403 / 429・遮断ページ）。再試行しない。
   * 同一実行内でアクセスを止めるかどうかは crawler.js の停止条件で別に判断する。
   */
  function isAccessBlocked(row) {
    const status = httpStatus(row);
    if (status !== null && BLOCK_HTTP_STATUS.has(status)) return true;
    return hasBlockPageSignature(row);
  }

  /*
   * 診断行1件を分類する。
   */
  function classifyFetchOutcome(row) {
    if (!row || typeof row !== 'object') return 'connection_error';
    if (row.outcome === 'stopped' || row.status === 'SKIPPED') return 'stopped';

    const price = row.price === null || row.price === undefined ? NaN : Number(row.price);
    if (row.status === 'OK' && Number.isFinite(price) && row.color_verified === true) {
      return 'success';
    }

    if (isAccessBlocked(row)) return 'blocked';

    const errors = errorText(row);
    if (TIMEOUT_ERROR.test(errors)) return 'timeout';

    const status = httpStatus(row);
    if (CONNECTION_ERROR.test(errors)) return 'connection_error';
    if (status !== null && (status < 200 || status >= 300)) return 'connection_error';

    // 応答も本文も得られていない（原因不明の通信失敗）
    const page = row.page || {};
    if (status === null && page.body_available !== true) return 'connection_error';

    const product = row.product || {};
    if (product.jan_found !== true && product.name_found !== true) return 'no_price';

    return 'extraction_failed';
  }

  /*
   * 店舗ごとの分類一覧から、SKU単位の件数を作る。
   *   target_stores = attempted + stopped
   *   attempted     = success + no_price + failed
   */
  function buildFetchSummary(storeOutcomes, checkedAt = null) {
    const rows = Array.isArray(storeOutcomes) ? storeOutcomes : [];
    const count = outcome => rows.filter(r => r.outcome === outcome).length;

    const failures = {};
    for (const outcome of FAILURE_OUTCOMES) failures[outcome] = count(outcome);
    const failed = FAILURE_OUTCOMES.reduce((sum, outcome) => sum + failures[outcome], 0);

    const stopped = count('stopped');
    const success = count('success');
    const noPrice = count('no_price');

    return {
      checked_at: checkedAt,
      target_stores: rows.length,
      attempted: rows.length - stopped,
      success,
      no_price: noPrice,
      failed,
      stopped,
      failures,
      stores: rows.map(r => ({ store: r.store, outcome: r.outcome }))
    };
  }

  /*
   * 件数の整合性チェック。問題があればエラー文の配列を返す。
   */
  function checkFetchSummary(summary) {
    const errors = [];
    if (!summary || typeof summary !== 'object') return ['fetch_summary がありません'];

    const stores = Array.isArray(summary.stores) ? summary.stores : null;
    if (!stores) return ['fetch_summary.stores が不正です'];

    for (const key of ['target_stores', 'attempted', 'success', 'no_price', 'failed', 'stopped']) {
      if (!Number.isInteger(summary[key]) || summary[key] < 0) errors.push(`fetch_summary.${key} が不正です`);
    }
    if (errors.length) return errors;

    const unknown = stores.filter(s => !OUTCOMES.includes(s && s.outcome));
    if (unknown.length) errors.push('fetch_summary に不明な分類があります');

    const recount = buildFetchSummary(stores, summary.checked_at);
    for (const key of ['target_stores', 'attempted', 'success', 'no_price', 'failed', 'stopped']) {
      if (summary[key] !== recount[key]) {
        errors.push(`fetch_summary.${key} が店舗別の結果と一致しません（${summary[key]} ≠ ${recount[key]}）`);
      }
    }
    if (summary.target_stores !== summary.attempted + summary.stopped) {
      errors.push('fetch_summary: 対象店舗数 ≠ アクセス数 + 停止数');
    }
    if (summary.attempted !== summary.success + summary.no_price + summary.failed) {
      errors.push('fetch_summary: アクセス数 ≠ 成功数 + 掲載なし + 失敗数');
    }

    const names = stores.map(s => s.store);
    if (new Set(names).size !== names.length) errors.push('fetch_summary に店舗の重複があります');

    return errors;
  }

  /*
   * 画面表示用の文言。fetch_summary が無い・不正な場合は null（何も表示しない）。
   */
  function describeFetchSummary(summary) {
    if (!summary || checkFetchSummary(summary).length) return null;

    const failureParts = FAILURE_OUTCOMES
      .filter(outcome => summary.failures && summary.failures[outcome] > 0)
      .map(outcome => `${OUTCOME_LABELS[outcome]}${summary.failures[outcome]}`);

    const parts = [];
    if (summary.no_price > 0) parts.push(`掲載なし${summary.no_price}`);
    if (summary.failed > 0) parts.push(`失敗${summary.failed}（${failureParts.join('・')}）`);
    if (summary.stopped > 0) parts.push(`アクセス停止${summary.stopped}`);

    const headline =
      `対象${summary.target_stores}店舗中 ${summary.success}店舗で価格を取得` +
      (parts.length ? `／${parts.join('／')}` : '');

    const details = summary.stores
      .filter(s => s.outcome !== 'success')
      .map(s => `${s.store}: ${OUTCOME_LABELS[s.outcome]}`);

    return { headline, details, short: `${summary.success}/${summary.target_stores}店舗` };
  }

  const api = {
    OUTCOMES,
    FAILURE_OUTCOMES,
    OUTCOME_LABELS,
    hasBlockPageSignature,
    isAccessBlocked,
    classifyFetchOutcome,
    buildFetchSummary,
    checkFetchSummary,
    describeFetchSummary
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FetchOutcome = api;
})(typeof window !== 'undefined' ? window : globalThis);
