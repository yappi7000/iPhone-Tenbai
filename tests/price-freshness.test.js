"use strict";

const test = require("node:test");
const assert = require("node:assert");
const F = require("../assets/price-freshness.js");

const NOW = Date.parse("2026-10-25T03:00:00Z"); // 日本時間 10/25 12:00

test("日時の解釈: ISO と crawler の日本時間文字列（1桁月日も）を同じ時刻として扱う", () => {
  assert.strictEqual(F.parseTimestamp("2026/10/24 10:28:19"), Date.parse("2026-10-24T01:28:19Z"));
  assert.strictEqual(F.parseTimestamp("2026/9/25 9:05:00"), Date.parse("2026-09-25T00:05:00Z"));
  assert.strictEqual(F.parseTimestamp("2026-10-24T01:28:19.000Z"), Date.parse("2026-10-24T01:28:19Z"));
});

test("日時の解釈: 不正・空・あいまいな値は「不明」(null)", () => {
  for (const v of [null, undefined, "", "昨日", "2026/13/01 10:00:00", "2026/2/30 10:00:00", "2026-10-24", "1700000000"]) {
    assert.strictEqual(F.parseTimestamp(v), null, String(v));
  }
});

test("36時間以内は fresh、36時間超は stale", () => {
  const fresh = { stores: [{ store: "A", price: 1, observed_at: "2026-10-24T03:00:01Z" }], last_success_at: "2026-10-24T03:00:01Z" };
  const stale = { stores: [{ store: "A", price: 1, observed_at: "2026-10-23T14:59:59Z" }] };
  assert.strictEqual(F.classifyItem(fresh, NOW).state, "fresh");
  assert.strictEqual(F.classifyItem(stale, NOW).state, "stale");
});

test("旧データ（checked_at・last_update のみ、日本時間）も鮮度判定できる", () => {
  const old = { stores: [{ store: "A", price: 1, checked_at: "2026/9/25 10:21:53" }], last_update: "2026/9/25 10:21:53" };
  const info = F.classifyItem(old, NOW);
  assert.strictEqual(info.state, "stale");
  assert.ok(info.ageHours > 700);
});

test("店舗行に日時が無い旧データは SKU の取得成功日時で判定する", () => {
  const item = { last_update: "2026/9/25 21:42:00", stores: [{ store: "A", price: 1 }] };
  assert.strictEqual(F.classifyItem(item, NOW).state, "stale");
  assert.strictEqual(F.classifyStore(item.stores[0], NOW, item).state, "stale");
});

test("店舗にもSKUにも日時が無い価格が1件でもあれば SKU 全体を「更新日時不明」にする", () => {
  const item = { stores: [
    { store: "A", price: 1, observed_at: "2026-10-25T02:00:00Z" },
    { store: "B", price: 1 }
  ] };
  assert.strictEqual(F.classifyItem(item, NOW).state, "unknown");
});

test("一番古い店舗の価格を基準にする（新しく見せない）", () => {
  const item = { stores: [
    { store: "A", price: 1, observed_at: "2026-10-25T02:00:00Z" },
    { store: "B", price: 1, observed_at: "2026-10-22T00:00:00Z" }
  ] };
  assert.strictEqual(F.classifyItem(item, NOW).state, "stale");
});

test("未来日時は不明扱い（時計ずれ5分までは許容）", () => {
  const ok = { stores: [{ store: "A", price: 1, observed_at: "2026-10-25T03:04:00Z" }] };
  const ng = { stores: [{ store: "A", price: 1, observed_at: "2026-10-26T03:00:00Z" }] };
  assert.strictEqual(F.classifyItem(ok, NOW).state, "fresh");
  assert.strictEqual(F.classifyItem(ng, NOW).state, "unknown");
});

test("価格0件は no_price、確認日時と最終成功日時を区別して返す", () => {
  const item = { stores: [], fetch_status: "no_price", last_checked_at: "2026-10-25T01:31:28Z", last_success_at: "2026-10-24T01:31:28Z" };
  const info = F.classifyItem(item, NOW);
  assert.strictEqual(info.state, "no_price");
  assert.strictEqual(info.checkedAt, Date.parse("2026-10-25T01:31:28Z"));
  assert.strictEqual(info.successAt, Date.parse("2026-10-24T01:31:28Z"));
});

test("SKU自体が無ければ no_data", () => {
  assert.strictEqual(F.classifyItem(undefined, NOW).state, "no_data");
});

test("表示用の日本時間整形", () => {
  assert.strictEqual(F.formatJst(Date.parse("2026-10-24T01:28:19Z")), "2026/10/24 10:28");
  assert.strictEqual(F.formatJst(null), "不明");
});
