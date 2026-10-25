"use strict";

/*
 * 自動価格更新（第1段階）の回帰テスト
 *
 * 2026/10/24 時点の実データのスナップショット（tests/fixtures/）と index.html を土台に、
 * crawler.js の保存処理 → verify_prices.js の検証 を通しで確認する。
 * ネットワーク・ブラウザは使わない。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { updatePricesJsonSafely } = require("../scripts/crawler.js");
const { verifyPrices, formatReport } = require("../scripts/verify_prices.js");
const { MODEL_RULES, extractTargets, validateTargets, isValidJan13, isPriceInRange, IPHONE_DUO_RETAIL } = require("../scripts/price_rules.js");

const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const BASE_PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/prices_2026-10-24.json"), "utf8"));
const BASE_DIAG = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/crawl_diagnostics_2026-10-24.json"), "utf8"));

const STARTED_ISO = "2026-10-25T01:28:19.000Z";
const FINISHED_ISO = "2026-10-25T01:31:28.000Z";

/*
 * iPhone Duo の診断行（テスト用フィクスチャ）。
 * 価格は 2026/10/25 時点の買取ルデヤ公開価格。テスト内でのみ使い、実データには書き込まない。
 */
const DUO_FIXTURE = [
  ["4549995732641", "iPhone Duo", "256GB", "スターホワイト", 410500],
  ["4549995732696", "iPhone Duo", "256GB", "ナイトスカイ", 410500],
  ["4549995732740", "iPhone Duo", "512GB", "スターホワイト", 450500],
  ["4549995732795", "iPhone Duo", "512GB", "ナイトスカイ", 450500],
  ["4549995732849", "iPhone Duo", "1TB", "スターホワイト", 505500],
  ["4549995732894", "iPhone Duo", "1TB", "ナイトスカイ", 505500],
  ["4549995732948", "iPhone Duo", "2TB", "スターホワイト", 590500],
  ["4549995732993", "iPhone Duo", "2TB", "ナイトスカイ", 590500]
];

function duoRow(jan, storeId, store, price) {
  return {
    store_id: storeId, store, jan, status: "OK", price, color_verified: true,
    checked_at: "2026/10/25 10:28:19", http: { status: 200, ok: true }, product: { jan_found: true, name_found: true },
    price_candidates: [price], errors: []
  };
}

/*
 * 実データの診断結果を「今回の実行」として使えるように時刻だけ付け替え、
 * iPhone Duo の対象・診断行を加える。mutate で店舗障害などを再現する。
 */
function makeDiagnostics(mutate = row => row) {
  const diag = JSON.parse(JSON.stringify(BASE_DIAG));
  diag.started_at = "2026/10/25 10:28:19";
  diag.finished_at = "2026/10/25 10:31:28";
  diag.started_at_iso = STARTED_ISO;
  diag.finished_at_iso = FINISHED_ISO;
  for (const [jan, model, storage, color, price] of DUO_FIXTURE) {
    diag.targets.push({ jan, name: `${model} ${storage} ${color}`, model, storage, color });
    diag.stores.push(duoRow(jan, "rudeya", "買取ルデヤ", price));
  }
  diag.target_count = diag.targets.length;
  diag.stores = diag.stores.map(row => mutate({ ...row }));
  delete diag.prices_update;
  return diag;
}

function failStore(storeId) {
  return row => (row.store_id === storeId ? { ...row, status: "ERROR", price: null, http: { status: 403 } } : row);
}

/*
 * 保存 → 検証を一時ディレクトリで実行
 */
function runPipeline(diag, { targetJan = "", previous = BASE_PRICES } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prices-"));
  const file = path.join(dir, "prices.json");
  fs.writeFileSync(file, JSON.stringify(previous));

  const saved = process.env.TARGET_JAN;
  if (targetJan) process.env.TARGET_JAN = targetJan;
  else delete process.env.TARGET_JAN;

  try {
    const update = updatePricesJsonSafely(diag, file);
    diag.prices_update = update;
    const prices = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = verifyPrices({ prices, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: previous, targetJan });
    return { update, prices, result };
  } finally {
    if (saved === undefined) delete process.env.TARGET_JAN;
    else process.env.TARGET_JAN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TARGETS = extractTargets(INDEX_HTML);
const DUO_JANS = DUO_FIXTURE.map(r => r[0]);
const RUDEYA_ONLY = ["4549995734645", "4549995734843", "4549995735048", "4549995734164", "4549995734201", "4549995734263", "4549995734287"];

test("対象SKU: iPhone 18 Pro / Pro Max の32SKUを維持し、全JANのチェックディジットが正しい", () => {
  const pro = TARGETS.filter(t => t.model === "iPhone 18 Pro");
  const max = TARGETS.filter(t => t.model === "iPhone 18 Pro Max");
  assert.strictEqual(pro.length, 16);
  assert.strictEqual(max.length, 16);
  const rules18 = MODEL_RULES.filter(r => r.model.startsWith("iPhone 18"));
  assert.deepStrictEqual(validateTargets(TARGETS.filter(t => t.model.startsWith("iPhone 18")), rules18), []);
  for (const t of TARGETS) assert.ok(isValidJan13(t.jan), t.jan);
});

test("iPhone Duo: 4容量×2カラーの8SKUが確認済みJANと完全一致する", () => {
  const duo = TARGETS.filter(t => t.model === "iPhone Duo");
  assert.strictEqual(duo.length, 8);
  assert.deepStrictEqual(
    duo.map(t => [t.jan, t.model, t.storage, t.color]).sort(),
    DUO_FIXTURE.map(r => r.slice(0, 4)).sort()
  );
  assert.deepStrictEqual(validateTargets(TARGETS), []);
});

test("整合性: JAN_DATABASE・商品マスター・Worker許可リストが同じJANを持つ", () => {
  const master = JSON.parse(fs.readFileSync(path.join(ROOT, "data/product_master.json"), "utf8"));
  for (const t of TARGETS) {
    assert.strictEqual(master[t.model]?.[t.storage]?.[t.color], t.jan, `${t.name}`);
  }
  const worker = fs.readFileSync(path.join(ROOT, "worker/index.js"), "utf8");
  const block = worker.match(/const ALLOWED_JANS = new Set\(\[([\s\S]*?)\]\);/)[1];
  const allowed = [...block.matchAll(/"(\d{13})"/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(allowed, TARGETS.map(t => t.jan).sort());
});

test("整合性: index.html の Apple 定価（Duo）が価格ルールと一致する", () => {
  for (const [storage, yen] of Object.entries(IPHONE_DUO_RETAIL)) {
    const m = INDEX_HTML.match(new RegExp(`"iPhone Duo_${storage}"\\s*:\\s*(\\d+)`));
    assert.ok(m, storage);
    assert.strictEqual(Number(m[1]), yen, storage);
  }
});

test("価格範囲: Duo は容量別（定価の0.5〜1.5倍）。50万円超の正常価格を受け付け、桁違いは拒否", () => {
  assert.strictEqual(isPriceInRange("iPhone Duo", 595000, undefined, "2TB"), true);
  assert.strictEqual(isPriceInRange("iPhone Duo", 505500, undefined, "1TB"), true);
  assert.strictEqual(isPriceInRange("iPhone Duo", 595000, undefined, "256GB"), false);
  assert.strictEqual(isPriceInRange("iPhone Duo", 41050, undefined, "256GB"), false);
  assert.strictEqual(isPriceInRange("iPhone Duo", 410500, undefined, null), false, "容量不明は拒否");
});

test("チェックディジット: 1桁違いのJANは不正と判定する", () => {
  assert.strictEqual(isValidJan13("4549995734546"), true);
  assert.strictEqual(isValidJan13("4549995734547"), false);
  assert.strictEqual(isValidJan13("454999573454"), false);
  assert.strictEqual(isValidJan13("APPLE-DUO-256"), false);
});

test("価格範囲: iPhone 18 は従来どおり5万〜50万円、モデル不明は拒否", () => {
  assert.strictEqual(isPriceInRange("iPhone 18 Pro", 50000), true);
  assert.strictEqual(isPriceInRange("iPhone 18 Pro", 500000), true);
  assert.strictEqual(isPriceInRange("iPhone 18 Pro", 500001), false);
  assert.strictEqual(isPriceInRange("iPhone 18 Pro", 49999), false);
  assert.strictEqual(isPriceInRange("未知のモデル", 200000), false);
});

test("通常時: 実データ（10/24診断）で保存・検証が通る", () => {
  const { update, prices, result } = runPipeline(makeDiagnostics());
  assert.strictEqual(update.updated, true, update.reason);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.report.fetchedSkuCount, 40);
  assert.strictEqual(prices["4549995732948"].stores[0].price, 590500, "Duo 2TB の50万円超の価格が保存される");
  for (const t of TARGETS) {
    const item = prices[t.jan];
    assert.strictEqual(item.fetch_status, "ok");
    assert.strictEqual(item.last_checked_at, FINISHED_ISO);
    assert.strictEqual(item.last_success_at, FINISHED_ISO);
    for (const row of item.stores) assert.strictEqual(row.observed_at, STARTED_ISO);
  }
});

test("Duo: JAN完全一致以外の店舗の価格・範囲外の価格は保存しない", () => {
  const diag = makeDiagnostics();
  diag.stores.push(duoRow("4549995732641", "rakuen", "買取楽園", 400000));
  diag.stores.push(duoRow("4549995732696", "morimori", "森森買取", 900000));
  const { prices, result } = runPipeline(diag);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(prices["4549995732641"].stores.map(s => s.store), ["買取ルデヤ"]);
  assert.deepStrictEqual(prices["4549995732696"].stores.map(s => s.store), ["買取ルデヤ"]);
});

test("Duo: 全SKU取得失敗でも iPhone 18 の更新は止めない（警告のみ）", () => {
  const diag = makeDiagnostics(row => (DUO_JANS.includes(String(row.jan)) ? { ...row, status: "ERROR", price: null } : row));
  const { update, prices, result } = runPipeline(diag);
  assert.strictEqual(update.updated, true, update.reason);
  assert.deepStrictEqual(result.errors, [], result.errors.join("\n"));
  assert.ok(result.warnings.some(w => w.includes("iPhone Duo: 価格を1件も取得できませんでした")));
  for (const jan of DUO_JANS) assert.strictEqual(prices[jan].fetch_status, "no_price");
  assert.strictEqual(prices[TARGETS.find(t => t.model === "iPhone 18 Pro").jan].fetch_status, "ok");
});

test("#56相当: 買取ルデヤ全滅でも全体は止まらず、ルデヤ単独SKUだけ「価格未取得」になる", () => {
  const { update, prices, result } = runPipeline(makeDiagnostics(failStore("rudeya")));
  assert.strictEqual(update.updated, true, update.reason);
  assert.deepStrictEqual(result.errors, [], result.errors.join("\n"));
  assert.strictEqual(result.report.fetchedSkuCount, 25);

  for (const jan of RUDEYA_ONLY) {
    const item = prices[jan];
    assert.strictEqual(item.stores.length, 0, jan);
    assert.strictEqual(item.fetch_status, "no_price");
    assert.strictEqual(item.last_checked_at, FINISHED_ISO, "確認実行日時は進む");
    assert.notStrictEqual(item.last_success_at, FINISHED_ISO, "取得成功日時は進めない");
    assert.strictEqual(item.last_update, BASE_PRICES[jan].last_update, "旧形式の更新日時も据え置き");
  }

  assert.ok(result.warnings.some(w => w.includes("買取ルデヤ") && w.includes("今回は0件")));
  assert.deepStrictEqual(result.report.noPriceSkus.map(t => t.jan).sort(), [...RUDEYA_ONLY, ...DUO_JANS].sort());
});

test("Actionsレポート: 価格0件SKUと取得失敗店舗（HTTP 403・タイムアウト）を一覧表示する", () => {
  const diag = makeDiagnostics(row => (row.store_id === "rudeya"
    ? { ...row, status: "ERROR", price: null, http: { status: null }, errors: ["page.goto: Timeout 15000ms exceeded"] }
    : row));
  const { result } = runPipeline(diag);
  const text = formatReport(result);
  assert.match(text, /### 価格0件のSKU（15件/);
  for (const jan of [...RUDEYA_ONLY, ...DUO_JANS]) assert.ok(text.includes(`| ${jan} |`), jan);
  assert.match(text, /### 取得失敗のある店舗/);
  assert.match(text, /\| 買取ルデヤ ❗全件失敗 \| 0 \| 0 \| 40 \| 0 \| タイムアウト（40件） \|/);
  assert.match(text, /\| モバステ ❗全件失敗 \| 0 \| \d+ \| 0 \| \d+ \| HTTP 403/);
  assert.match(text, /\| 買取wiki ❗全件失敗 \| 0 \| 32 \|/);
  assert.match(text, /\| iPhone買取価格表 ❗全件失敗 \| 0 \| 32 \|/);
});

test("旧検証では #56相当の状況で失敗していた（設計矛盾の再現）", () => {
  const { prices } = runPipeline(makeDiagnostics(failStore("rudeya")));
  const emptySkus = TARGETS.filter(t => (prices[t.jan].stores || []).length === 0);
  // 旧 Verify generated prices は「stores 0件のSKUがあれば失敗」だった
  assert.ok(emptySkus.length > 0);
});

test("全店舗の取得失敗は閾値未満として失敗する", () => {
  const diag = makeDiagnostics(row => ({ ...row, status: "ERROR", price: null }));
  const { result } = runPipeline(diag);
  assert.ok(result.errors.some(e => e.includes("全体取得率が閾値未満")), result.errors.join("\n"));
});

test("閾値割れで失敗しても、正常に取得できた価格は生成ファイルに残る（成果物として保存・公開はしない）", () => {
  const diag = makeDiagnostics(row => (row.store_id === "ichome" ? row : { ...row, status: "ERROR", price: null }));
  const { update, prices, result } = runPipeline(diag);
  assert.strictEqual(update.updated, true);
  assert.ok(result.errors.some(e => e.includes("全体取得率が閾値未満")));
  const kept = TARGETS.filter(t => prices[t.jan].stores.length > 0);
  assert.ok(kept.length > 0);
  for (const t of kept) {
    assert.deepStrictEqual(prices[t.jan].stores.map(s => s.store), ["買取一丁目"]);
    assert.strictEqual(prices[t.jan].fetch_status, "ok");
  }
  assert.strictEqual(result.report.fetchedSkuCount, kept.length);
});

test("片方のモデルだけ大きく取れない場合はモデル別閾値で失敗する", () => {
  const proMaxJans = new Set(TARGETS.filter(t => t.model === "iPhone 18 Pro Max").map(t => t.jan));
  const diag = makeDiagnostics(row => (proMaxJans.has(String(row.jan)) ? { ...row, status: "ERROR", price: null } : row));
  const { result } = runPipeline(diag);
  assert.ok(result.errors.some(e => e.includes("iPhone 18 Pro Max の取得率が閾値未満")), result.errors.join("\n"));
});

test("古い価格を今回取得として紛れ込ませると失敗する", () => {
  const { prices } = runPipeline(makeDiagnostics());
  const diag = makeDiagnostics();
  diag.prices_update = { updated: true };
  const jan = TARGETS[0].jan;
  prices[jan].stores[0].observed_at = "2026-10-20T00:00:00.000Z";
  const result = verifyPrices({ prices, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: BASE_PRICES });
  assert.ok(result.errors.some(e => e.includes("今回取得した価格ではありません")));
});

test("価格0件なのに取得成功日時を進めると失敗する", () => {
  const { prices } = runPipeline(makeDiagnostics(failStore("rudeya")));
  const diag = makeDiagnostics();
  diag.prices_update = { updated: true };
  prices[RUDEYA_ONLY[0]].last_success_at = FINISHED_ISO;
  const result = verifyPrices({ prices, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: BASE_PRICES });
  assert.ok(result.errors.some(e => e.includes("価格0件なのに取得成功日時")));
});

test("価格0件なのに last_update を書き換えると（前回比較で）失敗する", () => {
  const { prices } = runPipeline(makeDiagnostics(failStore("rudeya")));
  const diag = makeDiagnostics();
  diag.prices_update = { updated: true };
  prices[RUDEYA_ONLY[1]].last_update = "2026/10/25 10:31:28";
  const result = verifyPrices({ prices, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: BASE_PRICES });
  assert.ok(result.errors.some(e => e.includes("last_update が前回から変わっています")));
});

test("今回確認していないSKUがあると失敗する", () => {
  const { prices } = runPipeline(makeDiagnostics());
  const diag = makeDiagnostics();
  diag.prices_update = { updated: true };
  prices[TARGETS[3].jan].last_checked_at = "2026-10-21T01:00:00.000Z";
  const result = verifyPrices({ prices, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: BASE_PRICES });
  assert.ok(result.errors.some(e => e.includes("今回の実行で確認されていません")));
});

test("範囲外の価格・重複店舗は失敗する", () => {
  const { prices } = runPipeline(makeDiagnostics());
  const diag = makeDiagnostics();
  diag.prices_update = { updated: true };
  const item = prices[TARGETS[0].jan];
  item.stores.push({ ...item.stores[0] });
  prices[TARGETS[1].jan].stores[0].price = 900000;
  const result = verifyPrices({ prices, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: BASE_PRICES });
  assert.ok(result.errors.some(e => e.includes("店舗名重複")));
  assert.ok(result.errors.some(e => e.includes("モデル別範囲外")));
});

test("対象外SKU（iPhone 17）が書き換わると失敗する", () => {
  const { prices } = runPipeline(makeDiagnostics());
  const diag = makeDiagnostics();
  diag.prices_update = { updated: true };
  const targetSet = new Set(TARGETS.map(t => t.jan));
  const other = Object.keys(prices).find(jan => !targetSet.has(jan));
  prices[other] = { ...prices[other], last_update: "2026/10/25 10:00:00" };
  const result = verifyPrices({ prices, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: BASE_PRICES });
  assert.ok(result.errors.some(e => e.includes("今回の更新対象外なのに")));
});

test("crawler が更新を中止した場合は失敗する", () => {
  const diag = makeDiagnostics();
  diag.prices_update = { updated: false, reason: "診断が不足するJANが存在します" };
  const result = verifyPrices({ prices: BASE_PRICES, diagnostics: diag, indexHtml: INDEX_HTML, previousPrices: BASE_PRICES });
  assert.strictEqual(result.errors[0], "crawler が prices.json の更新を中止しました: 診断が不足するJANが存在します");
  assert.ok(result.errors.length <= 2, "中止理由がSKU単位のエラーに埋もれない");
  assert.match(formatReport(result), /SKU単位の検証は行っていません/);
});

test("オンデマンド: Duo の JAN も更新対象として受け付ける", () => {
  const jan = "4549995732849";
  const base = makeDiagnostics();
  base.target_count = 1;
  base.targets = base.targets.filter(t => t.jan === jan);
  base.stores = base.stores.filter(r => String(r.jan || "") === jan);
  const { update, prices, result } = runPipeline(base, { targetJan: jan });
  assert.strictEqual(update.updated, true, update.reason);
  assert.deepStrictEqual(result.errors, [], result.errors.join("\n"));
  assert.strictEqual(prices[jan].stores[0].price, 505500);
});

test("オンデマンド: 価格0件でも「価格未取得」として通り、他SKUは変更されない", () => {
  const jan = RUDEYA_ONLY[0];
  const base = makeDiagnostics(failStore("rudeya"));
  base.target_count = 1;
  base.targets = base.targets.filter(t => t.jan === jan);
  base.stores = base.stores.filter(r => String(r.jan || "") === jan);
  const { update, prices, result } = runPipeline(base, { targetJan: jan });
  assert.strictEqual(update.updated, true, update.reason);
  assert.deepStrictEqual(result.errors, [], result.errors.join("\n"));
  assert.strictEqual(prices[jan].fetch_status, "no_price");
  for (const other of Object.keys(BASE_PRICES)) {
    if (other !== jan) assert.deepStrictEqual(prices[other], BASE_PRICES[other]);
  }
});
