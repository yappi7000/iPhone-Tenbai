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
  shouldCacheStaticPage,
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

// Duo・iPhone 18 のどちらかの対象店舗（買取楽園は iPhone 18 のみ）
const findStore = storeId =>
  storesForItem(DUO_ITEM).find(s => s.id === storeId) ||
  storesForItem(PRO_ITEM).find(s => s.id === storeId);

/*
 * 1店舗を3SKU順番に調べ、各SKUの分類とアクセス回数を返す
 */
async function runThreeSkus(storeId, responses) {
  const state = createStoreRunState();
  const inspect = fakeInspect({ [storeId]: responses });
  const store = findStore(storeId);
  const outcomes = [];
  for (const item of [DUO_ITEM, DUO_ITEM_2, DUO_ITEM_3]) {
    outcomes.push((await inspectStoreWithPolicy(inspect, store, item, state, noWait)).outcome);
  }
  return { outcomes, calls: inspect.calls.length, state };
}

const unavailable503 = (s, i) => row(s, i, { http: 503, title: "503 Service Unavailable", body: 200, errors: ["HTTP status 503"] });
const noPrice200 = (s, i) => row(s, i, { http: 200, title: "検索結果", errors: ["JAN完全一致の商品が見つかりません"] });
const waf200 = (s, i) => row(s, i, { http: 200, title: "Webサイトファイアウォール", body: 230 });

test("停止条件: HTTP 403・429・503 は1回で停止し、その店舗の残りSKUにはアクセスしない（再試行なし）", async () => {
  for (const [name, response, reason] of [
    ["403", plain403, "HTTP 403"],
    ["403(CloudFront)", cloudFront403, "HTTP 403"],
    ["429", tooMany, "HTTP 429"],
    ["503", unavailable503, "HTTP 503"]
  ]) {
    const { outcomes, calls, state } = await runThreeSkus("rudeya", [response, ok]);
    assert.deepStrictEqual(outcomes.slice(1), ["stopped", "stopped"], name);
    assert.strictEqual(calls, 1, `${name}: 再試行も残りSKUへのアクセスもしない`);
    assert.strictEqual(state.blocked.get("rudeya").reason, reason, name);
    assert.strictEqual(state.blocked.get("rudeya").jan, DUO_ITEM.jan, "停止を決めたSKUを記録する");
  }
});

test("停止条件: WAF の遮断ページは HTTP 200 でも1回で停止する", async () => {
  for (const response of [forbidden, waf200]) {
    const { outcomes, calls, state } = await runThreeSkus("kaitoriwiki", [response, ok]);
    assert.deepStrictEqual(outcomes, ["blocked", "stopped", "stopped"]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(state.blocked.get("kaitoriwiki").reason, "WAF・遮断ページ");
  }
});

test("停止条件: 掲載なし（HTTP 200）では止めない", async () => {
  const { outcomes, calls, state } = await runThreeSkus("rudeya", [noPrice200, ok, noPrice200]);
  assert.deepStrictEqual(outcomes, ["no_price", "success", "no_price"]);
  assert.strictEqual(calls, 3);
  assert.strictEqual(state.blocked.size, 0);
});

test("停止条件: 接続エラーの再試行で 503 が返ったら、その時点で停止する", async () => {
  const { outcomes, calls, state } = await runThreeSkus("morimori", [hangUp, unavailable503, ok]);
  assert.deepStrictEqual(outcomes, ["connection_error", "stopped", "stopped"]);
  assert.strictEqual(calls, 2, "最初の接続エラー + 再試行の1回だけ");
  assert.strictEqual(state.blocked.get("morimori").reason, "HTTP 503");
});

/*
 * 定時実行と同じく3SKUを並列に調べ、続けて4SKU目を調べる。plan は JAN → [応答までのms, 応答]。
 */
async function runParallelSkus(storeId, plan) {
  const state = createStoreRunState();
  const calls = [];
  const store = findStore(storeId);
  const inspect = async (s, item) => {
    calls.push(item.jan);
    const [delay, response] = plan[item.jan] || [1, ok];
    await new Promise(r => setTimeout(r, delay));
    return response(s, item);
  };
  const batch = await Promise.all([DUO_ITEM, DUO_ITEM_2, DUO_ITEM_3].map(item => inspectStoresForItem(inspect, item, state, { stores: [store], ...noWait })));
  const next = await inspectStoresForItem(inspect, { ...DUO_ITEM, jan: "4549995732894" }, state, { stores: [store], ...noWait });
  return { outcomes: batch.map(r => r[0].outcome), next: next[0].outcome, calls: calls.length, state };
}

test("3SKU並列: 最初に返った 403 で停止し、実行中の他SKUの正常応答では停止を取り消さない", async () => {
  const { outcomes, next, calls, state } = await runParallelSkus("rudeya", {
    [DUO_ITEM.jan]: [5, plain403], [DUO_ITEM_2.jan]: [15, noPrice200], [DUO_ITEM_3.jan]: [25, ok]
  });
  assert.deepStrictEqual(outcomes, ["blocked", "no_price", "success"]);
  assert.strictEqual(state.blocked.get("rudeya").reason, "HTTP 403");
  assert.strictEqual(next, "stopped");
  assert.strictEqual(calls, 3, "停止後の4SKU目にはアクセスしない");
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

/* ---------- HTTP 200 のアクセス確認ページ（2026/11/3 買取楽園） ---------- */

const RAKUEN = { id: "rakuen", name: "買取楽園" };
const RAKUEN_URL = "https://www.keitairakuen.com/product-category/keitai/iphone/";

/*
 * 11/3: HTTP 200・タイトル「One moment, please...」・本文51文字（32SKUすべて no_price と誤判定）
 */
function rakuenAccessCheck(s, i) {
  return {
    ...row(s, i, { http: 200, title: "One moment, please...", body: 51, errors: ["SIM FREE未開封商品が見つかりません"] }),
    http: { status: 200, ok: true, final_url: RAKUEN_URL }
  };
}

/*
 * 11/2: HTTP 200・通常の商品ページ（本文4190文字）。色別検証済みの価格あり
 */
function rakuenNormal(s, i) {
  return {
    ...row(s, i, { status: "OK", http: 200, title: "iPhone(アイフォン)の高額買取 – 買取楽園", body: 4190, price: 221500 }),
    product: { jan_found: false, name_found: true },
    extraction_color_verified: true
  };
}

// 通常の商品ページだが、そのSKUの掲載が無い（正常な HTTP 200 の掲載なし）
function rakuenNormalNoListing(s, i) {
  return row(s, i, { http: 200, title: "iPhone(アイフォン)の高額買取 – 買取楽園", body: 4190, errors: ["SIM FREE未開封商品が見つかりません"] });
}

test("アクセス確認ページ: 11/3 の買取楽園（HTTP 200・One moment, please...）は掲載なしではなくアクセス制限", () => {
  const r = rakuenAccessCheck(RAKUEN, PRO_ITEM);
  assert.strictEqual(classifyFetchOutcome(r), "blocked");
  assert.strictEqual(isAccessBlocked(r), true);
});

test("アクセス確認ページ: 11/2 の通常ページは従来どおり成功、掲載なしは掲載なしのまま", () => {
  assert.strictEqual(classifyFetchOutcome(rakuenNormal(RAKUEN, PRO_ITEM)), "success");
  const noListing = rakuenNormalNoListing(RAKUEN, PRO_ITEM);
  assert.strictEqual(classifyFetchOutcome(noListing), "no_price");
  assert.strictEqual(isAccessBlocked(noListing), false);
});

test("アクセス確認ページ: 1回で同一実行内の後続アクセスを停止する（HTTP 200 でも）", async () => {
  const { outcomes, calls, state } = await runThreeSkus("rakuen", [rakuenAccessCheck]);
  assert.deepStrictEqual(outcomes, ["blocked", "stopped", "stopped"]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(state.blocked.get("rakuen").reason, "WAF・遮断ページ");
});

test("アクセス確認ページ: 通常ページの掲載なしでは停止しない", async () => {
  const { outcomes, calls, state } = await runThreeSkus("rakuen", [rakuenNormalNoListing, rakuenNormal]);
  assert.deepStrictEqual(outcomes, ["no_price", "success", "success"]);
  assert.strictEqual(calls, 3);
  assert.strictEqual(state.blocked.size, 0);
});

test("アクセス確認ページ: 3SKU並列でも確認ページが返った時点で停止し、次のSKUにはアクセスしない", async () => {
  const { outcomes, next, calls } = await runParallelSkus("rakuen", {
    [DUO_ITEM.jan]: [5, rakuenAccessCheck], [DUO_ITEM_2.jan]: [10, rakuenAccessCheck], [DUO_ITEM_3.jan]: [15, rakuenAccessCheck]
  });
  assert.deepStrictEqual(outcomes, ["blocked", "blocked", "blocked"], "実行中だった3件は確認ページとして記録");
  assert.strictEqual(next, "stopped");
  assert.strictEqual(calls, 3);
});

test("キャッシュ: アクセス確認ページは価格表として使い回さない（11/3 は29SKUで使い回されていた）", () => {
  const okResponse = { ok: () => true };
  const page = title => ({ page: { title } });
  assert.strictEqual(shouldCacheStaticPage(RAKUEN, okResponse, "x".repeat(4190), page("iPhone(アイフォン)の高額買取 – 買取楽園")), true);
  assert.strictEqual(shouldCacheStaticPage(RAKUEN, okResponse, "x".repeat(51), page("One moment, please...")), false);
  assert.strictEqual(shouldCacheStaticPage(RAKUEN, okResponse, "x".repeat(230), page("Webサイトファイアウォール")), false);
  assert.strictEqual(shouldCacheStaticPage(RAKUEN, { ok: () => false }, "x".repeat(500), page("403 Forbidden")), false);
  assert.strictEqual(shouldCacheStaticPage(RAKUEN, okResponse, "", page("iPhone(アイフォン)の高額買取 – 買取楽園")), false);
  assert.strictEqual(shouldCacheStaticPage({ id: "rudeya", name: "買取ルデヤ" }, okResponse, "x".repeat(4190), page("検索結果")), false, "キャッシュ対象外の店舗");
});

/* ---------- 通し: 一部店舗の停止と価格更新 ---------- */

test("通し: 403・429・503 で停止した店舗があっても、他店舗の取得と prices.json の更新・公開前検証は続く", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { extractTargets } = require("../scripts/price_rules.js");
  const { updatePricesJsonSafely } = require("../scripts/crawler.js");
  const { verifyPrices } = require("../scripts/verify_prices.js");
  const indexHtml = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const targets = extractTargets(indexHtml);
  assert.strictEqual(targets.length, 40, "定時実行と同じ40SKU");

  // 3店舗はそれぞれ最初の応答で 403・429・503。他の店舗は正常に価格を返す
  const restricted = { ichome: 403, mobilemix: 429, kaitorishouten: 503 };
  const calls = {};
  const priceFor = (store, item) => (item.model === "iPhone Duo" ? 410000 : 200000) + (store.id === "rudeya" ? 1000 : 0);
  const inspect = async (store, item) => {
    calls[store.id] = (calls[store.id] || 0) + 1;
    const code = restricted[store.id];
    const r = code ? row(store, item, { http: code, errors: [`HTTP status ${code}`] }) : ok(store, item, priceFor(store, item));
    return { ...r, checked_at: "2026/11/11 10:00:00" };
  };
  const state = createStoreRunState();
  const rows = [];
  for (const item of targets) rows.push(...await inspectStoresForItem(inspect, item, state, noWait));

  // 制限した店舗は1回だけアクセスして停止（再試行なし）、残りSKUは stopped
  for (const [id, code] of Object.entries(restricted)) {
    assert.strictEqual(calls[id], 1, `${id}: 1回だけ`);
    assert.strictEqual(state.blocked.get(id).reason, `HTTP ${code}`);
    const mine = rows.filter(r => r.store_id === id);
    assert.ok(mine.length > 1 && mine.slice(1).every(r => r.outcome === "stopped" && r.price === null), id);
  }
  // 他の店舗は全SKUで取得を続ける
  for (const id of ["rudeya", "rakuen", "mobileichiban", "morimori"]) {
    const mine = rows.filter(r => r.store_id === id);
    assert.ok(mine.length >= 32 && mine.every(r => r.outcome === "success"), `${id}: ${mine.map(r => r.outcome)}`);
  }

  const diagnostics = {
    started_at: "2026/11/11 10:00:00", finished_at: "2026/11/11 10:05:00",
    started_at_iso: "2026-11-11T01:00:00.000Z", finished_at_iso: "2026-11-11T01:05:00.000Z",
    targets, target_count: targets.length, stores: rows
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prices-"));
  const file = path.join(dir, "prices.json");
  fs.writeFileSync(file, "{}");
  const saved = process.env.TARGET_JAN;
  delete process.env.TARGET_JAN;
  try {
    const update = updatePricesJsonSafely(diagnostics, file);
    diagnostics.prices_update = update;
    assert.strictEqual(update.updated, true, JSON.stringify(update));
    const prices = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const t of targets) {
      const stores = prices[t.jan].stores.map(s => s.store);
      assert.ok(stores.includes("買取ルデヤ"), t.name);
      assert.ok(!stores.some(s => ["買取一丁目", "モバイルMIX", "買取商店"].includes(s)), `${t.name}: 停止した店舗の価格を出さない`);
    }
    const result = verifyPrices({ prices, diagnostics, indexHtml, previousPrices: null });
    assert.deepStrictEqual(result.errors, [], "公開前検証に通る（価格の更新は止まらない）");
  } finally {
    if (saved !== undefined) process.env.TARGET_JAN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- iPhone Duo の掲載調査（価格には使わない） ---------- */

test("Duo掲載調査: 既に開いたページから Duo の記載・JAN完全一致・容量・色・新品条件を記録する（価格は出さない）", () => {
  const { probeDuoListing, recordDuoProbe, DUO_PROBE_RESULTS } = require("../scripts/crawler.js");
  const { isStoreAllowedForModel } = require("../scripts/price_rules.js");
  const duo = [
    { jan: "4549995732740", model: "iPhone Duo", storage: "512GB", color: "スターホワイト" },
    { jan: "4549995732795", model: "iPhone Duo", storage: "512GB", color: "ナイトスカイ" }
  ];
  // 隣の商品（iPhone 18 Pro 256GB・ナイトスカイ表記を含む iPhone 17）の容量・色は Duo の判定に混ぜない
  const page = "iPhone 18 Pro 256GB 未開封 ¥190,000\niPhone Duo 512GB スターホワイト 新品未開封 JAN:4549995732740 ¥420,000\niPhone 17 1TB ナイトスカイ 中古 14549995732795";
  const probe = probeDuoListing(page, duo);
  assert.strictEqual(probe.mentions, 1);
  assert.deepStrictEqual(probe.jan_found, ["4549995732740"], "前後に数字が続くJANは一致としない");
  assert.deepStrictEqual(probe.storages_found, ["512GB"]);
  assert.deepStrictEqual(probe.colors_found, ["スターホワイト"]);
  assert.strictEqual(probe.new_condition_found, true);
  assert.ok(!("price" in probe), "価格は抽出しない");
  assert.deepStrictEqual(probeDuoListing("iPhone 18 Pro 256GB ¥190,000", duo),
    { mentions: 0, jan_found: [], storages_found: [], colors_found: [], new_condition_found: false, snippets: [] });
  const many = Array.from({ length: 20 }, (_, i) => `iPhone Duo 枠${i}`).join(" ");
  assert.strictEqual(probeDuoListing(many, duo).snippets.length, 8, "抜粋は最大8件");

  // 正常なページだけ、店舗ごとに1回だけ記録する。対象外の店舗・遮断ページは記録しない
  DUO_PROBE_RESULTS.clear();
  const diag = (status, title = "買取価格表") => ({ http: { status, final_url: "https://example.test/list" }, page: { title, body_length: 300 }, checked_at: "2026/11/12 11:00:00" });
  recordDuoProbe({ id: "rudeya", name: "買取ルデヤ" }, diag(200), page);
  recordDuoProbe({ id: "ichome", name: "買取一丁目" }, diag(403, "403 Forbidden"), page);
  recordDuoProbe({ id: "mobilemix", name: "モバイルMIX" }, diag(200, "Webサイトファイアウォール"), page);
  recordDuoProbe({ id: "rakuen", name: "買取楽園" }, diag(200), page);
  recordDuoProbe({ id: "rakuen", name: "買取楽園" }, diag(200), "iPhone Duo 2TB");
  assert.deepStrictEqual([...DUO_PROBE_RESULTS.keys()], ["rakuen"]);
  assert.strictEqual(DUO_PROBE_RESULTS.get("rakuen").mentions, 1, "最初の正常ページだけ");
  DUO_PROBE_RESULTS.clear();

  // 調査だけで、Duo の価格取得対象は変えない
  for (const id of ["rakuen", "ichome", "mobilemix", "mobileichiban"]) {
    assert.strictEqual(isStoreAllowedForModel("iPhone Duo", id), false, id);
  }
});
