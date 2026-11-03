"use strict";

/*
 * 店舗取得の信頼性（分類・アクセス停止・再試行・対象店舗の絞り込み・キャッシュ）の回帰テスト
 *
 *   node --test tests/store-reliability.test.js
 *
 * ネットワーク・ブラウザは使わない（inspectStore の代わりに偽の関数を渡す）。
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  classifyFetchOutcome,
  isAccessBlocked,
  buildFetchSummary,
  checkFetchSummary,
  describeFetchSummary
} = require("../assets/fetch-outcome.js");
const {
  storesForItem,
  createStoreRunState,
  inspectStoreWithPolicy,
  inspectStoresForItem,
  makeStoppedDiagnostic,
  STATIC_CACHE_STORE_IDS,
  extractIphoneKaitoriPrice
} = require("../scripts/crawler.js");

const DUO_ITEM = { jan: "4549995732795", name: "iPhone Duo 512GB ナイトスカイ", model: "iPhone Duo", storage: "512GB", color: "ナイトスカイ" };
const DUO_ITEM_2 = { jan: "4549995732740", name: "iPhone Duo 512GB スターホワイト", model: "iPhone Duo", storage: "512GB", color: "スターホワイト" };
const PRO_ITEM = { jan: "4549995734546", name: "iPhone 18 Pro Max 256GB ブラック", model: "iPhone 18 Pro Max", storage: "256GB", color: "ブラック" };

/*
 * crawler.js の診断行と同じ形の行を作る
 */
function row(store, item, { status = "ERROR", http = null, title = null, body = 1000, errors = [], price = null, found = false } = {}) {
  return {
    store_id: store.id,
    store: store.name,
    jan: item.jan,
    product_name: item.name,
    status,
    http: { status: http, ok: http !== null && http >= 200 && http < 300, final_url: null },
    page: { title, body_length: body, body_available: body > 0 },
    product: { jan_found: found, name_found: found },
    price,
    color_verified: status === "OK" && price !== null,
    price_candidates: price !== null ? [{ price }] : [],
    errors
  };
}

const ok = (s, i, price = 415500) => row(s, i, { status: "OK", http: 200, price, found: true });
const forbidden = (s, i) => row(s, i, { http: 403, title: "Webサイトファイアウォール", body: 230, errors: ["HTTP status 403"] });
const timeout = (s, i) => row(s, i, { body: 0, errors: ["page.goto: Timeout 15000ms exceeded."] });
const hangUp = (s, i) => row(s, i, { body: 0, errors: ["socket hang up"] });

const noWait = { wait: async () => {}, random: () => 0 };

/*
 * 店舗ごとの応答を順番に返す偽の inspectStore。呼び出し回数を記録する。
 */
function fakeInspect(responses) {
  const calls = [];
  const fn = async (store, item) => {
    calls.push(`${store.id}:${item.jan}`);
    const queue = responses[store.id];
    const next = Array.isArray(queue) ? (queue.length > 1 ? queue.shift() : queue[0]) : queue;
    return next(store, item);
  };
  fn.calls = calls;
  return fn;
}

/* ---------- 分類 ---------- */

test("分類: 11/3 の Duo 診断（森森・ルデヤ・iPhone買取価格表・買取wiki・買取商店）を正しく分類する", () => {
  const S = id => ({ id, name: id });
  assert.strictEqual(classifyFetchOutcome(hangUp(S("morimori"), DUO_ITEM)), "connection_error");
  assert.strictEqual(classifyFetchOutcome(ok(S("rudeya"), DUO_ITEM)), "success");
  assert.strictEqual(classifyFetchOutcome(timeout(S("iphonekaitori"), DUO_ITEM)), "timeout");
  assert.strictEqual(classifyFetchOutcome(row(S("森森"), DUO_ITEM, { body: 0, errors: ["森森買取 HTTP timeout"] })), "timeout");
  assert.strictEqual(
    classifyFetchOutcome(row(S("kaitorishouten"), DUO_ITEM, {
      http: 403, title: "ERROR: The request could not be satisfied", body: 513,
      errors: ["JAN完全一致の新品価格を取得できません", "HTTP status 403"]
    })),
    "blocked"
  );
});

test("分類: アクセス制限は HTTP 403 / 429 と明確な WAF ページだけ。CloudFront の 502 は接続エラー", () => {
  const S = { id: "x", name: "x" };
  assert.strictEqual(classifyFetchOutcome(row(S, DUO_ITEM, { http: 429 })), "blocked");
  assert.strictEqual(classifyFetchOutcome(row(S, DUO_ITEM, { http: 200, title: "Webサイトファイアウォール" })), "blocked");
  assert.strictEqual(classifyFetchOutcome(row(S, DUO_ITEM, { http: 502, title: "ERROR: The request could not be satisfied", errors: ["HTTP status 502"] })), "connection_error");
  assert.strictEqual(isAccessBlocked(row(S, DUO_ITEM, { http: 502, title: "ERROR: The request could not be satisfied" })), false);
  assert.strictEqual(classifyFetchOutcome(row(S, DUO_ITEM, { http: 404 })), "connection_error");
  assert.strictEqual(classifyFetchOutcome(row(S, DUO_ITEM, { body: 0, errors: ["page.goto: net::ERR_NAME_NOT_RESOLVED"] })), "connection_error");
});

test("分類: 掲載なし・抽出失敗・色未検証・アクセス停止を区別する", () => {
  const S = { id: "x", name: "x" };
  assert.strictEqual(classifyFetchOutcome(row(S, DUO_ITEM, { http: 200, errors: ["JAN完全一致の商品が見つかりません"] })), "no_price");
  assert.strictEqual(classifyFetchOutcome(row(S, DUO_ITEM, { http: 200, found: true, errors: ["通常買取価格を取得できません"] })), "extraction_failed");
  const unverified = { ...ok(S, DUO_ITEM), color_verified: false };
  assert.strictEqual(classifyFetchOutcome(unverified), "extraction_failed");
  assert.strictEqual(classifyFetchOutcome(makeStoppedDiagnostic(S, DUO_ITEM, { reason: "HTTP 403", jan: "1" })), "stopped");
});

/* ---------- SKU単位の件数 ---------- */

test("件数: 対象 = アクセス + 停止、アクセス = 成功 + 掲載なし + 失敗。停止は失敗に数えない", () => {
  const summary = buildFetchSummary([
    { store: "A", outcome: "success" },
    { store: "B", outcome: "timeout" },
    { store: "C", outcome: "blocked" },
    { store: "D", outcome: "no_price" },
    { store: "E", outcome: "stopped" }
  ], "2026-11-03T00:00:00.000Z");
  assert.deepStrictEqual(
    { t: summary.target_stores, a: summary.attempted, s: summary.success, n: summary.no_price, f: summary.failed, st: summary.stopped },
    { t: 5, a: 4, s: 1, n: 1, f: 2, st: 1 }
  );
  assert.deepStrictEqual(summary.failures, { connection_error: 0, timeout: 1, blocked: 1, extraction_failed: 0 });
  assert.deepStrictEqual(checkFetchSummary(summary), []);

  assert.ok(checkFetchSummary({ ...summary, failed: 3 }).length > 0, "件数の改ざんを検出する");
  assert.ok(checkFetchSummary({ ...summary, stores: [...summary.stores, { store: "A", outcome: "success" }] }).length > 0, "店舗の重複を検出する");
  assert.ok(checkFetchSummary({ ...summary, stores: [{ store: "A", outcome: "weird" }] }).length > 0);
  assert.ok(checkFetchSummary(undefined).length > 0);
});

test("表示文言: 成功数・失敗内訳・アクセス停止を示し、取得できなかった店舗を列挙する", () => {
  const summary = buildFetchSummary([
    { store: "森森買取", outcome: "connection_error" },
    { store: "買取ルデヤ", outcome: "success" },
    { store: "iPhone買取価格表", outcome: "timeout" },
    { store: "買取wiki", outcome: "stopped" },
    { store: "買取商店", outcome: "blocked" }
  ], "2026-11-03T00:00:00.000Z");
  const d = describeFetchSummary(summary);
  assert.strictEqual(d.headline, "対象5店舗中 1店舗で価格を取得／失敗3（接続エラー1・タイムアウト1・アクセス制限1）／アクセス停止1");
  assert.deepStrictEqual(d.details, ["森森買取: 接続エラー", "iPhone買取価格表: タイムアウト", "買取wiki: アクセス停止", "買取商店: アクセス制限"]);
  assert.strictEqual(d.short, "1/5店舗");
  assert.strictEqual(describeFetchSummary({ ...summary, success: 5 }), null, "不整合な集計は表示しない");
});

/* ---------- 対象店舗の絞り込み ---------- */

test("対象店舗: Duo は JAN完全一致の5店舗だけ。オンデマンド（6並列）なら1バッチで終わる", () => {
  const ids = storesForItem(DUO_ITEM).map(s => s.id).sort();
  assert.deepStrictEqual(ids, ["iphonekaitori", "kaitorishouten", "kaitoriwiki", "morimori", "rudeya"]);
  assert.ok(ids.length <= 6);
});

test("対象店舗: iPhone 18 は従来どおり色別検証できる店舗（保留・18専用一括処理の店舗を除く）", () => {
  const ids = storesForItem(PRO_ITEM).map(s => s.id);
  assert.ok(ids.includes("mobasute") && ids.includes("rudeya") && ids.includes("rakuen"));
  assert.ok(!ids.includes("amemoba") && !ids.includes("iosys") && !ids.includes("janpara"));
  assert.strictEqual(new Set(ids).size, ids.length);
});

/* ---------- アクセス停止 ---------- */

test("アクセス停止: 403/WAF を検知した店舗には同一実行内で以降アクセスせず、停止の診断行を残す", async () => {
  const state = createStoreRunState();
  const inspect = fakeInspect({ morimori: forbidden, rudeya: ok });
  const stores = storesForItem(DUO_ITEM).filter(s => ["morimori", "rudeya"].includes(s.id));

  const first = await inspectStoresForItem(inspect, DUO_ITEM, state, { stores, ...noWait });
  const second = await inspectStoresForItem(inspect, DUO_ITEM_2, state, { stores, ...noWait });

  assert.deepStrictEqual(first.map(r => r.outcome), ["blocked", "success"]);
  assert.deepStrictEqual(second.map(r => r.outcome), ["stopped", "success"]);
  assert.deepStrictEqual(inspect.calls, [
    `morimori:${DUO_ITEM.jan}`, `rudeya:${DUO_ITEM.jan}`, `rudeya:${DUO_ITEM_2.jan}`
  ], "403 の店舗は 1回だけアクセスし、再試行もしない");

  const stopped = second[0];
  assert.strictEqual(stopped.jan, DUO_ITEM_2.jan);
  assert.strictEqual(stopped.status, "SKIPPED");
  assert.strictEqual(stopped.attempts, 0);
  assert.strictEqual(stopped.price, null);
  assert.deepStrictEqual(stopped.errors, [], "未試行を失敗扱いしない");
  assert.match(stopped.skip_reason, /WAF・遮断ページ/, "WAF ページ付きの 403 は遮断ページとして1回で停止");
  assert.strictEqual(state.blocked.get("morimori").jan, DUO_ITEM.jan);
});

const DUO_ITEM_3 = { jan: "4549995732849", name: "iPhone Duo 1TB スターホワイト", model: "iPhone Duo", storage: "1TB", color: "スターホワイト" };
const plain403 = (s, i) => row(s, i, { http: 403, title: "403 Forbidden", body: 300, errors: ["HTTP status 403"] });
const cloudFront403 = (s, i) => row(s, i, { http: 403, title: "ERROR: The request could not be satisfied", body: 513, errors: ["HTTP status 403"] });
const tooMany = (s, i) => row(s, i, { http: 429, body: 100, errors: ["HTTP status 429"] });

/*
 * 1店舗を3SKU順番に調べ、各SKUの分類とアクセス回数を返す
 */
async function runThreeSkus(storeId, responses) {
  const state = createStoreRunState();
  const inspect = fakeInspect({ [storeId]: responses });
  const store = storesForItem(DUO_ITEM).find(s => s.id === storeId);
  const outcomes = [];
  for (const item of [DUO_ITEM, DUO_ITEM_2, DUO_ITEM_3]) {
    outcomes.push((await inspectStoreWithPolicy(inspect, store, item, state, noWait)).outcome);
  }
  return { outcomes, calls: inspect.calls.length, state };
}

test("停止条件: 遮断ページの特徴が無い 403 が1回だけなら止めない（ルデヤの一時的な 403 で残りSKUを失わない）", async () => {
  const { outcomes, calls, state } = await runThreeSkus("rudeya", [plain403, ok]);
  assert.deepStrictEqual(outcomes, ["blocked", "success", "success"]);
  assert.strictEqual(calls, 3);
  assert.strictEqual(state.blocked.size, 0);
});

test("停止条件: 遮断ページの特徴が無い 403 が2回連続したら、3SKU目からアクセス停止", async () => {
  const { outcomes, calls, state } = await runThreeSkus("rudeya", [plain403]);
  assert.deepStrictEqual(outcomes, ["blocked", "blocked", "stopped"]);
  assert.strictEqual(calls, 2, "停止後はアクセスしない");
  assert.strictEqual(state.blocked.get("rudeya").reason, "HTTP 403（2回連続）");
  assert.strictEqual(state.blocked.get("rudeya").jan, DUO_ITEM_2.jan, "停止を決めたSKUを記録する");
});

test("停止条件: 403 の間に成功があれば連続回数を0に戻す", async () => {
  const { outcomes, calls, state } = await runThreeSkus("rudeya", [plain403, ok, plain403]);
  assert.deepStrictEqual(outcomes, ["blocked", "success", "blocked"]);
  assert.strictEqual(calls, 3);
  assert.strictEqual(state.blocked.size, 0);
  assert.strictEqual(state.blockStrikes.get("rudeya"), 1);
});

test("停止条件: CloudFront の 403（502 等でも出るタイトル）は遮断ページ扱いせず、2回連続で停止", async () => {
  const { outcomes, calls } = await runThreeSkus("kaitorishouten", [cloudFront403]);
  assert.deepStrictEqual(outcomes, ["blocked", "blocked", "stopped"]);
  assert.strictEqual(calls, 2);
});

test("停止条件: WAF の遮断ページは1回で停止する", async () => {
  const { outcomes, calls, state } = await runThreeSkus("kaitoriwiki", [forbidden]);
  assert.deepStrictEqual(outcomes, ["blocked", "stopped", "stopped"]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(state.blocked.get("kaitoriwiki").reason, "WAF・遮断ページ");
});

test("停止条件: HTTP 429 は再試行も停止もしない（アクセス制限として記録だけする）", async () => {
  const { outcomes, calls, state } = await runThreeSkus("rudeya", [tooMany]);
  assert.deepStrictEqual(outcomes, ["blocked", "blocked", "blocked"]);
  assert.strictEqual(calls, 3, "SKUごとに1回だけ（再試行なし）");
  assert.strictEqual(state.blocked.size, 0);
});

test("アクセス停止: タイムアウト・接続エラーでは止めない（明確な制限だけ）", async () => {
  const state = createStoreRunState();
  const inspect = fakeInspect({ iphonekaitori: timeout, morimori: hangUp });
  const stores = storesForItem(DUO_ITEM).filter(s => ["iphonekaitori", "morimori"].includes(s.id));
  await inspectStoresForItem(inspect, DUO_ITEM, state, { stores, ...noWait });
  const second = await inspectStoresForItem(inspect, DUO_ITEM_2, state, { stores, ...noWait });
  assert.strictEqual(state.blocked.size, 0);
  assert.deepStrictEqual(
    Object.fromEntries(second.map(r => [r.store_id, r.outcome])),
    { iphonekaitori: "timeout", morimori: "connection_error" }
  );
});

/* ---------- 再試行 ---------- */

test("再試行: 接続エラーは待機後に1回だけ再試行し、回復すれば成功として記録する", async () => {
  const state = createStoreRunState();
  const waits = [];
  const inspect = fakeInspect({ morimori: [hangUp, ok] });
  const store = storesForItem(DUO_ITEM).find(s => s.id === "morimori");
  const result = await inspectStoreWithPolicy(inspect, store, DUO_ITEM, state, { wait: async ms => waits.push(ms), random: () => 0.5 });
  assert.strictEqual(result.outcome, "success");
  assert.strictEqual(result.attempts, 2);
  assert.deepStrictEqual(result.first_attempt_errors, ["socket hang up"]);
  assert.strictEqual(inspect.calls.length, 2);
  assert.strictEqual(waits.length, 1);
  assert.ok(waits[0] >= 2000 && waits[0] <= 4000, `待機 ${waits[0]}ms`);
});

test("再試行: 再試行しても接続エラーなら、その店舗は同一実行内で再試行しない", async () => {
  const state = createStoreRunState();
  const inspect = fakeInspect({ morimori: hangUp });
  const store = storesForItem(DUO_ITEM).find(s => s.id === "morimori");
  const r1 = await inspectStoreWithPolicy(inspect, store, DUO_ITEM, state, noWait);
  const r2 = await inspectStoreWithPolicy(inspect, store, DUO_ITEM_2, state, noWait);
  assert.strictEqual(r1.attempts, 2);
  assert.strictEqual(r2.attempts, 1);
  assert.strictEqual(r2.outcome, "connection_error");
  assert.strictEqual(inspect.calls.length, 3, "継続障害でもアクセスは SKU数 + 1回まで");
});

test("再試行: タイムアウト・403/WAF・掲載なしは再試行しない", async () => {
  for (const [name, response] of [
    ["timeout", timeout],
    ["blocked", forbidden],
    ["no_price", (s, i) => row(s, i, { http: 200, errors: ["JAN完全一致の商品が見つかりません"] })]
  ]) {
    const state = createStoreRunState();
    const inspect = fakeInspect({ kaitoriwiki: response });
    const store = storesForItem(DUO_ITEM).find(s => s.id === "kaitoriwiki");
    const result = await inspectStoreWithPolicy(inspect, store, DUO_ITEM, state, noWait);
    assert.strictEqual(result.outcome, name);
    assert.strictEqual(inspect.calls.length, 1, name);
  }
});

test("再試行: HTTP 5xx は接続エラーとして1回だけ再試行する", async () => {
  const state = createStoreRunState();
  const inspect = fakeInspect({ kaitoriwiki: [(s, i) => row(s, i, { http: 502, errors: ["HTTP status 502"] }), ok] });
  const store = storesForItem(DUO_ITEM).find(s => s.id === "kaitoriwiki");
  const result = await inspectStoreWithPolicy(inspect, store, DUO_ITEM, state, noWait);
  assert.strictEqual(result.outcome, "success");
  assert.strictEqual(inspect.calls.length, 2);
});

test("再試行: 待機中に別SKUでアクセス制限が判明したら再試行しない", async () => {
  const state = createStoreRunState();
  const inspect = fakeInspect({ morimori: hangUp });
  const store = storesForItem(DUO_ITEM).find(s => s.id === "morimori");
  const result = await inspectStoreWithPolicy(inspect, store, DUO_ITEM, state, {
    wait: async () => { state.blocked.set("morimori", { reason: "HTTP 403", jan: DUO_ITEM_2.jan }); },
    random: () => 0
  });
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(inspect.calls.length, 1);
});

/* ---------- 静的価格表キャッシュ ---------- */

test("キャッシュ: iPhone買取価格表は同じ本文から JAN完全一致で各SKUの価格を取り違えずに抽出できる", () => {
  assert.ok(STATIC_CACHE_STORE_IDS.has("iphonekaitori"));
  const body = [
    "iPhone Duo 512GB スターホワイト",
    "JANコード：4549995732740 452,000円",
    "iPhone Duo 512GB ナイトスカイ",
    "JANコード：4549995732795",
    "450,500円",
    "iPhone 18 Pro Max 256GB ブラック",
    "JANコード：4549995734546 301,000円"
  ].join("\n");
  assert.strictEqual(extractIphoneKaitoriPrice(body, "4549995732740").price, 452000);
  assert.strictEqual(extractIphoneKaitoriPrice(body, "4549995732795").price, 450500);
  assert.strictEqual(extractIphoneKaitoriPrice(body, "4549995734546").price, 301000);
  // 掲載の無いJANは別SKUの価格を拾わない
  const missing = extractIphoneKaitoriPrice(body, "4549995732849");
  assert.strictEqual(missing.found, false);
  assert.strictEqual(missing.price, null);
  // 1桁違いのJANにも一致しない
  assert.strictEqual(extractIphoneKaitoriPrice(body, "4549995732741").found, false);
});

test("キャッシュ: page 操作で抽出する店舗（モバステ・モバイルMIX）と検索URL型の店舗はキャッシュしない", () => {
  for (const id of ["mobasute", "mobilemix", "morimori", "rudeya", "kaitoriwiki"]) {
    assert.strictEqual(STATIC_CACHE_STORE_IDS.has(id), false, id);
  }
});
