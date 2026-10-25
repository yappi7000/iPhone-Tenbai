(function (root) {
  'use strict';

  /*
   * 価格データの鮮度判定（iPhone買取価格）
   *
   * 日時フィールドの意味
   *   SKU単位
   *     last_success_at : 最後に価格を「取得できた」日時（ISO 8601）
   *     last_checked_at : 最後に取得を「試みた（確認実行した）」日時（ISO 8601）
   *     last_update     : 旧形式。最終取得成功日時（日本時間の文字列）。互換のため残す
   *     fetch_status    : "ok"（今回取得できた）/ "no_price"（今回は取得できなかった）
   *   店舗単位
   *     observed_at     : その店舗の価格を取得した日時（ISO 8601）
   *     checked_at      : 旧形式。同上（日本時間の文字列）
   *
   * 古い価格・日時不明の価格を「最新」として扱わないことが目的。
   */

  const STALE_HOURS = 36;
  const HOUR_MS = 3600000;
  // サーバーと端末の時計ずれの許容（5分）
  const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

  /*
   * ISO 8601、または crawler.js の nowJST() 形式
   * （"2026/10/24 10:28:19" = 日本時間）を数値（ms）に変換する。
   * 解釈できない値は null（＝日時不明）。
   */
  function parseTimestamp(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;

    const jst = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (jst) {
      const [, y, mo, d, h, mi, s] = jst.map(Number);
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (s || 0) > 59) return null;
      // 日本時間 = UTC+9
      const ms = Date.UTC(y, mo - 1, d, h - 9, mi, s || 0);
      const check = new Date(ms + 9 * HOUR_MS);
      if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
      return ms;
    }

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
      const ms = Date.parse(text);
      return Number.isFinite(ms) ? ms : null;
    }

    return null;
  }

  function ageInfo(ms, now) {
    if (ms === null) return { state: 'unknown', ageHours: null };
    const age = now - ms;
    if (age < -FUTURE_TOLERANCE_MS) return { state: 'unknown', ageHours: null };
    const ageHours = Math.max(0, age) / HOUR_MS;
    return { state: ageHours > STALE_HOURS ? 'stale' : 'fresh', ageHours };
  }

  /*
   * 店舗1件の取得日時。
   * 店舗行に日時が無い旧データは、同じ保存処理で記録された
   * SKUの取得成功日時（last_success_at / last_update）を使う。
   * どちらも無ければ null（＝更新日時不明）。
   */
  function storeTime(row, item) {
    const own = parseTimestamp(row && (row.observed_at || row.checked_at));
    if (own !== null) return own;
    return parseTimestamp(item && (item.last_success_at || item.last_update));
  }

  /*
   * 店舗1件の鮮度
   */
  function classifyStore(row, now = Date.now(), item = null) {
    const ms = storeTime(row, item);
    return Object.assign({ observedAt: ms }, ageInfo(ms, now));
  }

  /*
   * SKU全体の状態
   *   no_data  : prices.json にSKU自体が無い
   *   no_price : 確認はしたが有効な価格が0件
   *   fresh    : 有効価格あり・36時間以内
   *   stale    : 有効価格あり・36時間超
   *   unknown  : 有効価格ありだが取得日時が不明
   */
  function classifyItem(item, now = Date.now()) {
    if (!item || typeof item !== 'object') {
      return { state: 'no_data', successAt: null, checkedAt: null, ageHours: null };
    }

    const stores = Array.isArray(item.stores) ? item.stores : [];
    const successAt = parseTimestamp(item.last_success_at || item.last_update);
    const checkedAt = parseTimestamp(item.last_checked_at);

    if (stores.length === 0) {
      return { state: 'no_price', successAt, checkedAt, ageHours: null };
    }

    // SKU日時と店舗日時のうち、最も古い価格を基準にする（新しく見せない）
    const storeTimes = stores.map(row => storeTime(row, item));
    const basis = storeTimes.some(ms => ms === null)
      ? null
      : Math.min(...storeTimes);

    return Object.assign({ successAt, checkedAt }, ageInfo(basis, now));
  }

  function formatJst(ms) {
    if (ms === null || ms === undefined) return '不明';
    const d = new Date(ms + 9 * HOUR_MS);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  const api = { STALE_HOURS, parseTimestamp, classifyStore, classifyItem, formatJst };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PriceFreshness = api;
})(typeof window !== 'undefined' ? window : globalThis);
