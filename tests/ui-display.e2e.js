"use strict";

/*
 * 画面表示の回帰テスト（ブラウザ使用）
 *
 *   node --test tests/ui-display.e2e.js
 *
 * index.html をローカル配信し、data/prices.json だけ差し替えて
 * 「最新／価格未取得／古い情報／更新日時不明／データ無し」の表示を確認する。
 * 外部CDN（Tailwind・Turnstile等）への通信は遮断する（テスト中に外部へアクセスしない）。
 */

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const BASE_PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/prices_2026-10-24.json"), "utf8"));
const JAN = "4549995734546"; // iPhone 18 Pro Max 256GB ブラック
const IPHONE17_JAN = Object.keys(BASE_PRICES).find(jan => !jan.startsWith("454999573"));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const file = path.join(ROOT, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function iso(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600000).toISOString();
}

function withItem(item) {
  return { ...BASE_PRICES, [JAN]: item };
}

const freshStores = BASE_PRICES[JAN].stores.map(s => ({ ...s, observed_at: iso(2) }));

let server, browser, baseUrl;

test.before(async () => {
  server = await startServer();
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch(
    fs.existsSync("/opt/google/chrome/chrome") ? { executablePath: "/opt/google/chrome/chrome" } : {}
  );
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

async function openWith(prices, { select = ["iPhone 18 Pro Max", "256GB", "ブラック"], expectJan = JAN, onRequest = null, catalogPrices = null, viewport = null } = {}) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // Turnstile（外部CDN）の代わりに、即座にトークンを返すスタブを置く
  await page.addInitScript(() => {
    window.turnstile = {
      render(el, opts) { setTimeout(() => opts.callback("test-token"), 0); return "w1"; },
      remove() {}, reset() {}, execute() {}
    };
  });
  await page.route("**/*", route => {
    const url = route.request().url();
    if (onRequest && onRequest(route)) return undefined;
    if (!url.startsWith(baseUrl)) return route.abort();
    if (catalogPrices && new URL(url).pathname.endsWith("/data/catalog_prices.json")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(catalogPrices) });
    }
    if (new URL(url).pathname.endsWith("/data/prices.json")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(prices) });
    }
    return route.continue();
  });
  await page.goto(baseUrl);
  // loadCrawlData() 完了（成功／失敗メッセージ）まで待つ
  await page.waitForFunction(() => {
    const s = document.getElementById("statusAlert");
    return s && /読み込みました|失敗しました/.test(s.textContent);
  });
  // 初期選択はセレクト先頭のモデルなので、検証対象SKUを明示的に選ぶ
  await page.selectOption("#modelSelect", select[0]);
  await page.selectOption("#storageSelect", select[1]);
  await page.selectOption("#colorSelect", select[2]);
  assert.strictEqual((await page.textContent("#currentJan")).trim(), expectJan);
  return { page, errors };
}

test("最新価格: 警告なし・ランキング表示・店舗ごとに「自動巡回取得済」", async () => {
  const { page, errors } = await openWith(withItem({
    stores: freshStores, fetch_status: "ok", last_checked_at: iso(2), last_success_at: iso(2), last_update: "x"
  }));
  assert.strictEqual(await page.isVisible("#priceFreshnessNotice"), false);
  const rows = await page.locator("#rankingTableBody tr").count();
  assert.strictEqual(rows, freshStores.length);
  assert.strictEqual(await page.locator("#rankingTableBody .data-badge.is-fresh").count(), freshStores.length);
  assert.match(await page.textContent("#lastUpdateBadge"), /最終取得成功: .* ／ 最終確認: /);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("価格未取得: 古い価格を出さず「価格未取得」と最終確認・最終成功日時を表示", async () => {
  const { page, errors } = await openWith(withItem({
    stores: [], fetch_status: "no_price", last_checked_at: iso(1), last_success_at: iso(30), last_update: "2026/10/21 10:26:22"
  }));
  const notice = await page.textContent("#priceFreshnessNotice");
  assert.match(notice, /価格未取得/);
  assert.match(notice, /最後に取得できたのは/);
  assert.match(await page.getAttribute("#priceFreshnessNotice", "class"), /is-no-price/);
  assert.match(await page.textContent("#rankingTableBody"), /価格未取得/);
  assert.doesNotMatch(await page.textContent("#rankingTableBody"), /¥/);
  assert.strictEqual(await page.textContent("#maxPriceCard"), "--");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("古い情報: 36時間超の価格は警告と「古い情報」バッジを表示", async () => {
  const stale = freshStores.map(s => ({ ...s, observed_at: iso(40) }));
  const { page, errors } = await openWith(withItem({
    stores: stale, fetch_status: "ok", last_checked_at: iso(40), last_success_at: iso(40)
  }));
  assert.match(await page.textContent("#priceFreshnessNotice"), /古い情報/);
  assert.match(await page.getAttribute("#priceFreshnessNotice", "class"), /is-stale/);
  assert.strictEqual(await page.locator("#rankingTableBody .data-badge.is-stale").count(), stale.length);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("更新日時不明: 取得日時の無い価格は「更新日時不明」と表示", async () => {
  const unknown = freshStores.map(({ checked_at, observed_at, ...rest }) => rest);
  const { page, errors } = await openWith(withItem({ stores: unknown }));
  assert.match(await page.textContent("#priceFreshnessNotice"), /更新日時不明/);
  assert.strictEqual(await page.locator("#rankingTableBody .data-badge.is-unknown").count(), unknown.length);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("データ無し: 今日の日付を「最終取得日」として出さない", async () => {
  const { page, errors } = await openWith({});
  const badge = await page.textContent("#lastUpdateBadge");
  assert.strictEqual(badge, "データ最終取得日: 未取得");
  assert.doesNotMatch(badge, new RegExp(new Date().getFullYear() + "/"));
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("Present検索: 更新が止まっている iPhone 17 の価格は「古い情報」と警告される", async () => {
  assert.ok(IPHONE17_JAN, "iPhone 17 のSKUが prices.json にありません");
  const { page, errors } = await openWith(BASE_PRICES);
  await page.fill("#presentSearchInput", IPHONE17_JAN);
  await page.click("#presentSearchBtn");
  await page.waitForSelector("#presentRanking .freshness-notice");
  assert.match(await page.textContent("#presentRanking"), /古い情報/);
  assert.ok(await page.locator("#presentRanking .data-badge.is-stale").count() > 0);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

const DUO_JAN = "4549995732993"; // iPhone Duo 2TB ナイトスカイ

test("iPhone Duo: JAN・Apple定価・50万円超の買取価格を表示する", async () => {
  const prices = { ...BASE_PRICES, [DUO_JAN]: {
    stores: [{ store: "買取ルデヤ", price: 590500, url: "https://example.invalid/", condition: "unopened", color_verified: true, observed_at: iso(1) }],
    fetch_status: "ok", last_checked_at: iso(1), last_success_at: iso(1)
  } };
  const { page, errors } = await openWith(prices, { select: ["iPhone Duo", "2TB", "ナイトスカイ"], expectJan: DUO_JAN });
  assert.strictEqual((await page.textContent("#applePriceCard")).trim(), "¥574,800");
  assert.strictEqual((await page.textContent("#maxPriceCard")).trim(), "¥590,500");
  assert.doesNotMatch(await page.innerText("body"), /JAN未登録|Apple公開待ち|JAN確認中/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("iPhone Duo: 「最新価格を取得」は登録済みの13桁JANを送る（Invalid JAN を出さない）", async () => {
  let sent = null;
  const { page, errors } = await openWith(BASE_PRICES, {
    select: ["iPhone Duo", "256GB", "スターホワイト"],
    expectJan: "4549995732641",
    onRequest(route) {
      const req = route.request();
      if (req.url().startsWith("https://iphone-tenbai-refresh.thank-you-8p.workers.dev") && req.method() === "POST") {
        sent = JSON.parse(req.postData());
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return true;
      }
      return false;
    }
  });
  await page.click("#liveRefreshBtn");
  await page.waitForFunction(() => document.getElementById("statusAlert").textContent.includes("GitHub"), null, { timeout: 15000 });
  assert.ok(sent, "Worker へのリクエストが送られていません");
  assert.strictEqual(sent.jan, "4549995732641");
  assert.strictEqual(sent.turnstileToken, "test-token");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("Present検索: Duo を JAN で検索すると実JANを表示する", async () => {
  const { page, errors } = await openWith(BASE_PRICES);
  await page.fill("#presentSearchInput", DUO_JAN);
  await page.click("#presentSearchBtn");
  await page.waitForSelector("#presentSearchResult", { state: "visible" });
  assert.strictEqual((await page.textContent("#presentJan")).trim(), DUO_JAN);
  assert.strictEqual((await page.textContent("#presentApplePrice")).trim(), "¥574,800");
  assert.match(await page.textContent("#presentProductName"), /iPhone\s*Duo/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("ポケカ9種セット: 単品JANを表示せず、比較サイト価格は参考情報として順位外に表示", async () => {
  const BUNDLE_ID = "pokemon-30th-celebration-cardset-9";
  const SINGLE_ID = "pokemon-30th-4521329462295";
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "data/catalog_prices.json"), "utf8"));
  const now = new Date().toISOString();
  base.products[BUNDLE_ID] = [
    { store_id: "rudeya", store: "買取ルデヤ", url: "https://kaitori-rudeya.com/", checked_at: now, observed_at: null, price: null, status: "rejected", rejected_price: 2000 },
    { store_id: "homura", store: "買取ホムラ", url: "https://pokeca-box-hikaku.com/box/30th-celebration-cardset.html", checked_at: now, observed_at: null, price: null,
      status: "reference", source_type: "comparison_site", reference_price: 21000, reference_observed_at: now }
  ];
  base.products[SINGLE_ID] = [
    { store_id: "rudeya", store: "買取ルデヤ", url: "https://kaitori-rudeya.com/product/item/7376", checked_at: now, observed_at: now, price: 2000, status: "ok" }
  ];
  const { page, errors } = await openWith(BASE_PRICES, { catalogPrices: base });
  await page.click('[data-catalog-category="cards"]');
  await page.fill("#catalogQuery", "9種セット");
  await page.click(`[data-product="${BUNDLE_ID}"]`);
  const meta = await page.textContent("#catalogDetailMeta");
  assert.match(meta, /セット専用JANなし/);
  assert.doesNotMatch(meta, /4521329462295/);
  const ranking = await page.innerText("#catalogRanking");
  assert.match(ranking, /現在、比較できる価格を取得できていません/, "参考価格・除外価格は順位に入らない");
  assert.match(ranking, /参考情報（比較サイト掲載・店舗公式で未確認）/);
  assert.match(ranking, /掲載額 ¥21,000/);
  assert.match(ranking, /単品価格の混入の疑いで除外/);
  assert.match(await page.textContent("#catalogBest"), /取得できた価格だけを順位に反映します/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("ポケカ単品: フシギダネ・ヒトカゲ・ゼニガメの単品は従来どおり JAN と価格を表示", async () => {
  const SINGLE_ID = "pokemon-30th-4521329462295";
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "data/catalog_prices.json"), "utf8"));
  const now = new Date().toISOString();
  base.products[SINGLE_ID] = [
    { store_id: "rudeya", store: "買取ルデヤ", url: "https://kaitori-rudeya.com/product/item/7376", checked_at: now, observed_at: now, price: 2000, status: "ok" }
  ];
  const { page, errors } = await openWith(BASE_PRICES, { catalogPrices: base });
  await page.click('[data-catalog-category="cards"]');
  await page.fill("#catalogQuery", "4521329462295");
  assert.strictEqual(await page.locator("[data-product]").count(), 1, "JAN検索で9種セットが一緒に出ない");
  await page.click(`[data-product="${SINGLE_ID}"]`);
  assert.match(await page.textContent("#catalogDetailMeta"), /JAN 4521329462295/);
  assert.match(await page.textContent("#catalogBest"), /¥2,000/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("既存カテゴリ: ゲーム機・トレカ・カメラ・家電・Android・iPhone の一覧が表示され、JSエラーが無い", async () => {
  const { page, errors } = await openWith(BASE_PRICES);
  for (const category of ["games", "cards", "cameras", "appliances", "other"]) {
    await page.click(`[data-catalog-category="${category}"]`);
    if (category === "cards") await page.click('[data-card-view="all"]');
    await page.waitForFunction(() => !document.getElementById("catalogProducts").textContent.includes("読み込み中"));
    const count = await page.locator("#catalogProducts [data-product]").count();
    assert.ok(count > 0, `${category}: 商品が表示されません`);
    await page.locator("#catalogProducts [data-product]").first().click();
    assert.strictEqual(await page.isVisible("#catalogDetail"), true, `${category}: 詳細が開きません`);
    await page.click("#catalogBack");
  }
  await page.click('[data-catalog-category="iphone"]');
  assert.strictEqual(await page.isVisible("#iphonePanel"), true);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("Worker未反映（旧Worker）: Duo の即時更新は分かりやすい文言で止まり、誤データを出さない", async () => {
  const { page, errors } = await openWith(BASE_PRICES, {
    select: ["iPhone Duo", "1TB", "ナイトスカイ"],
    expectJan: "4549995732894",
    onRequest(route) {
      const req = route.request();
      if (req.url().startsWith("https://iphone-tenbai-refresh.thank-you-8p.workers.dev") && req.method() === "POST") {
        route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Invalid JAN" }) });
        return true;
      }
      return false;
    }
  });
  await page.click("#liveRefreshBtn");
  await page.waitForFunction(() => document.getElementById("statusAlert").textContent.includes("即時更新はまだ有効になっていません"), null, { timeout: 15000 });
  assert.strictEqual(await page.isEnabled("#liveRefreshBtn"), true);
  assert.strictEqual((await page.textContent("#maxPriceCard")).trim(), "--");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

/* ---------- 店舗別の取得状況（fetch_summary） ---------- */

const { buildFetchSummary } = require("../assets/fetch-outcome.js");
const DUO_512_JAN = "4549995732795"; // iPhone Duo 512GB ナイトスカイ

// 2026/11/3 のオンデマンド結果と同じ内訳（成功1・接続1・タイムアウト2・制限1）
function nov3Summary(checkedAt, { success = true } = {}) {
  return buildFetchSummary([
    { store: "森森買取", outcome: "connection_error" },
    { store: "買取ルデヤ", outcome: success ? "success" : "blocked" },
    { store: "iPhone買取価格表", outcome: "timeout" },
    { store: "買取wiki", outcome: "timeout" },
    { store: "買取商店", outcome: "blocked" }
  ], checkedAt);
}

const rudeyaRow = observedAt => ({ store: "買取ルデヤ", price: 415500, url: "", condition: "unopened", scope: "jan", color_verified: true, checked_at: "x", observed_at: observedAt });

test("取得状況: 最終確認時点の「対象5店舗中1店舗」と失敗内訳・取得できなかった店舗を表示する", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: [rudeyaRow(at)], fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x",
    fetch_summary: nov3Summary(at)
  }));
  assert.strictEqual(await page.isVisible("#fetchSummaryNotice"), true);
  const text = await page.textContent("#fetchSummaryNotice");
  assert.match(text, /取得状況（\d{4}\/\d+\/\d+ \d{2}:\d{2} の確認）: 対象5店舗中 1店舗で価格を取得／失敗4（接続エラー1・タイムアウト2・アクセス制限1）/);
  assert.match(text, /森森買取: 接続エラー/);
  assert.match(text, /買取商店: アクセス制限/);
  assert.doesNotMatch(text, /買取ルデヤ:/, "成功した店舗は失敗一覧に出さない");
  assert.strictEqual(await page.locator("#rankingTableBody tr").count(), 1);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("取得状況: 成功0店舗でも件数を表示し、古い価格は出さない（価格未取得）", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: [], fetch_status: "no_price", last_checked_at: at, last_success_at: iso(40), last_update: "2026/10/21 10:26:22",
    fetch_summary: nov3Summary(at, { success: false })
  }));
  assert.match(await page.textContent("#fetchSummaryNotice"), /対象5店舗中 0店舗で価格を取得／失敗5/);
  assert.match(await page.textContent("#priceFreshnessNotice"), /価格未取得/);
  assert.doesNotMatch(await page.textContent("#rankingTableBody"), /¥/);
  assert.strictEqual(await page.textContent("#maxPriceCard"), "--");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("取得状況: 旧データ（fetch_summary 無し）・別実行の集計・件数が矛盾する集計は表示しない", async () => {
  const at = iso(2);
  const base = { stores: freshStores, fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x" };
  const broken = nov3Summary(at);
  broken.success = 3;
  for (const item of [
    base,
    { ...base, fetch_summary: nov3Summary(iso(30)) },
    { ...base, fetch_summary: broken }
  ]) {
    const { page, errors } = await openWith(withItem(item));
    assert.strictEqual(await page.isVisible("#fetchSummaryNotice"), false);
    assert.strictEqual(await page.locator("#rankingTableBody tr").count(), freshStores.length, "価格表示は従来どおり");
    assert.deepStrictEqual(errors, []);
    await page.close();
  }
});

/*
 * オンデマンド: Worker への POST 成功後、GitHub Pages の prices.json を差し替えて完了表示を確認する。
 */
async function runOnDemand(updatedItem) {
  const { page, errors } = await openWith(BASE_PRICES, {
    select: ["iPhone Duo", "512GB", "ナイトスカイ"],
    expectJan: DUO_512_JAN,
    onRequest(route) {
      const req = route.request();
      if (req.url().startsWith("https://iphone-tenbai-refresh.thank-you-8p.workers.dev") && req.method() === "POST") {
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return true;
      }
      if (req.url().startsWith("https://yappi7000.github.io/iPhone-Tenbai/data/prices.json")) {
        route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...BASE_PRICES, [DUO_512_JAN]: updatedItem }) });
        return true;
      }
      return false;
    }
  });
  await page.click("#liveRefreshBtn");
  await page.waitForFunction(
    () => /取得完了|価格未取得）/.test(document.getElementById("statusAlert").textContent),
    null,
    { timeout: 30000 }
  );
  return { page, errors, status: await page.textContent("#statusAlert") };
}

test("オンデマンド完了: 取得完了と「対象5店舗中1店舗」の内訳を表示する", async () => {
  const at = new Date().toISOString();
  const { page, errors, status } = await runOnDemand({
    stores: [rudeyaRow(at)], fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x",
    fetch_summary: nov3Summary(at)
  });
  assert.match(status, /✅ 取得完了・最新データを読み込みました/);
  assert.match(status, /対象5店舗中 1店舗で価格を取得／失敗4（接続エラー1・タイムアウト2・アクセス制限1）/);
  assert.match(await page.textContent("#maxPriceCard"), /415,500/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("オンデマンド完了: 成功0店舗なら「価格未取得」と内訳を表示し、価格を出さない", async () => {
  const at = new Date().toISOString();
  const { page, errors, status } = await runOnDemand({
    stores: [], fetch_status: "no_price", last_checked_at: at, last_success_at: null, last_update: null,
    fetch_summary: nov3Summary(at, { success: false })
  });
  assert.match(status, /有効な買取価格を取得できませんでした（価格未取得）/);
  assert.match(status, /対象5店舗中 0店舗で価格を取得／失敗5/);
  assert.strictEqual((await page.textContent("#maxPriceCard")).trim(), "--");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("オンデマンド完了: 旧形式（fetch_summary 無し）の応答でも従来どおりの完了表示になる", async () => {
  const at = new Date().toISOString();
  const { page, errors, status } = await runOnDemand({
    stores: [rudeyaRow(at)], fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  });
  assert.match(status, /✅ 取得完了・最新データを読み込みました/);
  assert.doesNotMatch(status, /店舗中/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

/* ---------- 公開品質: 利益の符号・順位と計算に使う価格・参考値の注意・スマホ表示 ---------- */

const APPLE_PRO_MAX_256 = 239800; // index.html の APPLE_PRICES（iPhone 18 Pro Max 256GB）
const verifiedRow = (store, price, observedAt) => ({ store, price, url: "https://example.invalid/", condition: "unopened", scope: "jan", color_verified: true, checked_at: "x", observed_at: observedAt });

test("利益の符号: 赤字は「-¥」で表示し、「+¥-」と表示しない（KPI・差額・シミュレーション）", async () => {
  const at = iso(1);
  const best = 224500; // 2026/11/3 の実データ（定価 239,800円を下回る）
  const { page, errors } = await openWith(withItem({
    stores: [verifiedRow("買取ルデヤ", best, at), verifiedRow("買取楽園", 220000, at)],
    fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  const expected = best - APPLE_PRO_MAX_256 + Math.round(APPLE_PRO_MAX_256 * 0.01);
  assert.ok(expected < 0);
  const profit = (await page.textContent("#finalProfitCard")).trim();
  assert.strictEqual(profit, `-¥${Math.abs(expected).toLocaleString()}`);
  assert.doesNotMatch(profit, /\+¥-/);
  assert.strictEqual((await page.textContent("#diffPriceCard")).trim(), `-¥${(APPLE_PRO_MAX_256 - best).toLocaleString()}`);
  assert.strictEqual((await page.textContent("#simProfit")).trim(), `-¥${Math.abs(expected).toLocaleString()}`);
  assert.match(await page.getAttribute("#finalProfitCard", "style"), /rgb\(201, 42, 42\)|#c92a2a/i, "赤字は赤色");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("利益の符号: 黒字は従来どおり「+¥」で表示する（Duo 2TB）", async () => {
  const at = iso(1);
  const { page, errors } = await openWith({ ...BASE_PRICES, ["4549995732993"]: {
    stores: [verifiedRow("買取ルデヤ", 595000, at)], fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  } }, { select: ["iPhone Duo", "2TB", "ナイトスカイ"], expectJan: "4549995732993" });
  assert.match((await page.textContent("#finalProfitCard")).trim(), /^\+¥\d/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("順位と計算: 古い価格だけのSKUは最高価格・利益を出さず、表では「—」と除外理由付きで参考表示する", async () => {
  const stale = freshStores.map(s => ({ ...s, observed_at: iso(40) }));
  const { page, errors } = await openWith(withItem({
    stores: stale, fetch_status: "ok", last_checked_at: iso(40), last_success_at: iso(40)
  }));
  assert.strictEqual((await page.textContent("#maxPriceCard")).trim(), "--");
  assert.strictEqual((await page.textContent("#finalProfitCard")).trim(), "--");
  assert.match(await page.textContent("#bestStoreName"), /最新の買取価格なし/);
  assert.strictEqual(await page.inputValue("#simBestPrice"), "", "シミュレーションに古い価格を自動入力しない");
  const body = await page.textContent("#rankingTableBody");
  assert.doesNotMatch(body, /1位/);
  assert.strictEqual((body.match(/価格が古いため順位から除外/g) || []).length, stale.length);
  assert.strictEqual(await page.locator("#rankingTableBody .data-badge.is-stale").count(), stale.length);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("順位と計算: 最新価格と古い価格が混在しても、最高価格・順位は最新の色別検証済み価格だけで決める", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: [
      verifiedRow("買取ルデヤ", 224500, at),
      { ...verifiedRow("買取楽園", 260000, iso(40)) },          // 古い（高いが除外）
      { ...verifiedRow("モバイルMIX", 250000, at), color_verified: false } // 色未検証（除外）
    ],
    fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  assert.strictEqual((await page.textContent("#maxPriceCard")).trim(), "¥224,500");
  assert.strictEqual((await page.textContent("#bestStoreName")).trim(), "買取ルデヤ");
  assert.strictEqual(await page.inputValue("#simBestPrice"), "224500");
  const rows = await page.locator("#rankingTableBody tr").allTextContents();
  assert.strictEqual(rows.length, 3);
  assert.match(rows[0], /1位[\s\S]*買取ルデヤ/);
  assert.ok(rows.some(r => /買取楽園[\s\S]*価格が古いため順位から除外/.test(r)));
  assert.ok(rows.some(r => /モバイルMIX[\s\S]*色別の価格根拠が未確認のため順位から除外/.test(r)));
  assert.ok(!rows.some(r => /2位|3位/.test(r)));
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("参考価格: 対象色の記載がない店舗の基準価格は参考表示だけで、順位・最高価格・利益計算に使わない（XSS対策・古い参考価格は非表示）", async () => {
  const at = iso(1);
  const reference = (store, price, observedAt, reason) => ({ store, reference_price: price, reason, url: "https://example.invalid/ref", checked_at: "x", observed_at: observedAt });
  const { page, errors } = await openWith(withItem({
    stores: [verifiedRow("買取ルデヤ", 224500, at)],
    reference_stores: [
      reference("買取一丁目", 270000, at, "ブラックの記載なし<img src=x onerror=alert(1)>"),
      reference("モバイル一番", 280000, iso(40), "古い参考価格")
    ],
    fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  assert.strictEqual((await page.textContent("#maxPriceCard")).trim(), "¥224,500", "参考価格（高い）を最高価格にしない");
  assert.strictEqual((await page.textContent("#bestStoreName")).trim(), "買取ルデヤ");
  assert.strictEqual(await page.inputValue("#simBestPrice"), "224500", "利益計算は正式価格だけ");
  const rows = await page.locator("#rankingTableBody tr").allTextContents();
  assert.strictEqual(rows.length, 2, "36時間超の参考価格は表示しない");
  assert.match(rows[0], /1位[\s\S]*買取ルデヤ/);
  assert.match(rows[1], /買取一丁目[\s\S]*¥270,000[\s\S]*参考価格[\s\S]*順位・最高価格・利益計算に含めません/);
  assert.ok(!/2位/.test(rows.join("")));
  assert.strictEqual(await page.locator("#rankingTableBody img").count(), 0, "理由の文字列はエスケープする");
  assert.deepStrictEqual(errors, []);
  await page.close();

  // 正式価格が無く参考価格だけの場合も、最高価格は出さない
  const only = await openWith(withItem({
    stores: [], reference_stores: [reference("買取一丁目", 270000, at, "バーガンディの記載なし")],
    fetch_status: "no_price", last_checked_at: at, last_success_at: null, last_update: null
  }));
  assert.strictEqual((await only.page.textContent("#maxPriceCard")).trim(), "--");
  const onlyRows = await only.page.locator("#rankingTableBody tr").allTextContents();
  assert.match(onlyRows[0], /価格未取得/);
  assert.match(onlyRows[1], /買取一丁目[\s\S]*参考価格/);
  assert.deepStrictEqual(only.errors, []);
  await only.page.close();
});

test("Present検索: 古い iPhone 17 の価格に順位・利益計算を付けず、前に検索した商品の結果も残さない", async () => {
  const at = iso(1);
  const prices = withItem({ stores: [verifiedRow("買取ルデヤ", 224500, at)], fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x" });
  const { page, errors } = await openWith(prices);
  // 1件目: 最新価格のある iPhone 18 → 利益計算ボタンが有効
  await page.fill("#presentSearchInput", JAN);
  await page.click("#presentSearchBtn");
  await page.waitForFunction(() => /1位/.test(document.getElementById("presentRanking").textContent));
  assert.strictEqual(await page.isEnabled("#presentUsePriceBtn"), true);
  // 2件目: 古い iPhone 17 → 順位なし・ボタン無効
  await page.fill("#presentSearchInput", IPHONE17_JAN);
  await page.click("#presentSearchBtn");
  await page.waitForFunction(() => /順位をつけられる最新の買取価格はありません/.test(document.getElementById("presentRanking").textContent));
  const text = await page.textContent("#presentRanking");
  assert.doesNotMatch(text, /\d+位/);
  assert.match(text, /価格が古いため順位から除外/);
  assert.match(text, /古い情報/);
  assert.strictEqual((await page.textContent("#presentBestPrice")).trim(), "--");
  assert.strictEqual(await page.isEnabled("#presentUsePriceBtn"), false);
  assert.match(await page.textContent("#presentUsePriceBtn"), /最新の買取価格がないため利益計算できません/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("参考値の注意: iPhoneランキング・Present検索・カテゴリ詳細に「参考値／店舗の公式サイトで確認」を表示する", async () => {
  const { page, errors } = await openWith(BASE_PRICES);
  assert.strictEqual(await page.isVisible("#priceDisclaimer"), true);
  assert.match(await page.textContent("#priceDisclaimer"), /参考値[\s\S]*各店舗の公式サイトで確認/);
  await page.fill("#presentSearchInput", IPHONE17_JAN);
  await page.click("#presentSearchBtn");
  await page.waitForSelector("#presentRanking .price-disclaimer");
  assert.match(await page.textContent("#presentRanking .price-disclaimer"), /参考値[\s\S]*公式サイトで確認/);
  assert.match(await page.locator("#catalogDetail .price-disclaimer").textContent(), /参考値[\s\S]*公式サイトで確認/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("スマホ（375px）: ページの横はみ出しが無く、Present検索の店舗名・リンクが画面内に収まる", async () => {
  const { page, errors } = await openWith(BASE_PRICES, { viewport: { width: 375, height: 812 } });
  await page.fill("#presentSearchInput", IPHONE17_JAN);
  await page.click("#presentSearchBtn");
  await page.waitForSelector("#presentRanking .visit");
  const layout = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const links = [...document.querySelectorAll("#presentRanking a.visit")].map(a => a.getBoundingClientRect());
    const badges = [...document.querySelectorAll("#presentRanking .data-badge")].map(b => b.getBoundingClientRect());
    return {
      width,
      scrollWidth: document.documentElement.scrollWidth,
      linksOutside: links.filter(r => r.right > width || r.left < 0).length,
      badgesOutside: badges.filter(r => r.right > width).length,
      links: links.length
    };
  });
  assert.strictEqual(layout.scrollWidth, layout.width, "ページ全体が横にはみ出さない");
  assert.ok(layout.links > 0);
  assert.strictEqual(layout.linksOutside, 0, "「公式確認」リンクが画面外に切れない");
  assert.strictEqual(layout.badgesOutside, 0, "取得日時バッジが画面外に切れない");
  // モデル・容量・カラー選択がスマホ幅でも操作できる
  await page.selectOption("#modelSelect", "iPhone Duo");
  await page.selectOption("#storageSelect", "1TB");
  await page.selectOption("#colorSelect", "スターホワイト");
  assert.strictEqual((await page.textContent("#currentJan")).trim(), "4549995732849");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

/* ---------- セキュリティ: 取得データの HTML 挿入・リンクURLの検証 ---------- */

// 悪意のある店舗名（HTMLタグ・イベント属性・引用符）。実行されたら window.__xss が立つ
const XSS_NAME = `<img src=x onerror="window.__xss=1">"'><script>window.__xss=2</script>買取`;

const URL_CASES = [
  // [URL, リンクにしてよいか, 期待する href]
  ["https://kaitori-rudeya.com/search/index/4549995734546", true, "https://kaitori-rudeya.com/search/index/4549995734546"],
  ["http://example.com/path?q=1", true, "http://example.com/path?q=1"],
  ['https://example.com/?q="><script>window.__xss=3</script>', true, null],
  ["javascript:window.__xss=4", false],
  ["JavaScript:window.__xss=5", false],
  [" javascript:window.__xss=6", false],
  ["java\tscript:window.__xss=7", false],
  ["data:text/html,<script>window.__xss=8</script>", false],
  ["https://example.com/\u0000evil", false],
  ["https://exa mple.com/", false],
  ["//evil.example.com/", false],
  ["/relative/path", false],
  ["https://user:pass@evil.example.com/", false],
  ["ftp://example.com/", false],
  ["not a url", false],
  ["", false]
];

function freshRowsFor(cases, observedAt) {
  return cases.map(([url], i) => verifiedRow(`店舗${i}`, 300000 - i * 100, observedAt) && { ...verifiedRow(`店舗${i}`, 300000 - i * 100, observedAt), url });
}

async function linkByStore(page, scope, storeName, rowSelector) {
  return page.evaluate(({ scope, storeName, rowSelector }) => {
    const row = [...document.querySelectorAll(`${scope} ${rowSelector}`)].find(r => r.textContent.includes(storeName + " ") || r.textContent.includes(storeName + "¥") || r.textContent.trim().split(/\s+/).includes(storeName));
    if (!row) return { found: false };
    const a = row.querySelector("a.visit");
    return { found: true, href: a ? a.getAttribute("href") : null, target: a ? a.target : null, rel: a ? a.rel : null };
  }, { scope, storeName, rowSelector });
}

test("XSS: メインランキングの悪意ある店舗名は文字として表示し、タグ・スクリプトを実行しない", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: [
      { ...verifiedRow(XSS_NAME, 230000, at), url: "javascript:window.__xss=9" },
      verifiedRow("買取ルデヤ", 224500, at)
    ],
    fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  const result = await page.evaluate(() => ({
    xss: window.__xss || 0,
    imgs: document.querySelectorAll("#rankingTableBody img, #rankingTableBody script").length,
    text: document.getElementById("rankingTableBody").textContent,
    links: [...document.querySelectorAll("#rankingTableBody a")].map(a => a.getAttribute("href"))
  }));
  assert.strictEqual(result.xss, 0);
  assert.strictEqual(result.imgs, 0, "店舗名から img / script 要素が作られない");
  assert.ok(result.text.includes(`<img src=x onerror="window.__xss=1">`), "店舗名はそのままの文字で表示");
  assert.deepStrictEqual(result.links, ["https://example.invalid/"], "javascript: URL はリンクにしない");
  assert.strictEqual((await page.textContent("#bestStoreName")).trim(), XSS_NAME, "最高価格の店舗名も文字として表示");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("XSS: 参考価格行（順位から除外）の悪意ある店舗名・data: URL も無害化する", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: [
      verifiedRow("買取ルデヤ", 224500, at),
      { ...verifiedRow(XSS_NAME, 260000, iso(40)), url: "data:text/html,<script>window.__xss=10</script>" }
    ],
    fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  const result = await page.evaluate(() => {
    const row = document.querySelector("#rankingTableBody tr.excluded-row");
    return {
      xss: window.__xss || 0,
      elements: row.querySelectorAll("img, script").length,
      text: row.textContent,
      link: row.querySelector("a") ? row.querySelector("a").getAttribute("href") : null
    };
  });
  assert.strictEqual(result.xss, 0);
  assert.strictEqual(result.elements, 0);
  assert.ok(result.text.includes("<script>window.__xss=2</script>"));
  assert.match(result.text, /価格が古いため順位から除外/);
  assert.strictEqual(result.link, null, "data: URL はリンクにしない");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("URL検証: http/https の絶対URLだけをリンク化し、javascript:・data:・制御文字・空白・相対・認証情報付き・不正URLはリンクにしない", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: freshRowsFor(URL_CASES, at), fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  const rows = await page.evaluate(() => [...document.querySelectorAll("#rankingTableBody tr")].map(tr => {
    const a = tr.querySelector("a.visit");
    return { store: tr.children[1].textContent.trim(), href: a ? a.getAttribute("href") : null, target: a && a.target, rel: a && a.rel };
  }));
  for (const [i, [url, allowed, expected]] of URL_CASES.entries()) {
    const row = rows.find(r => r.store === `店舗${i}`);
    assert.ok(row, `店舗${i} の行がありません`);
    if (allowed) {
      assert.ok(row.href, `リンクになるべき: ${JSON.stringify(url)}`);
      if (expected) assert.strictEqual(row.href, expected);
      assert.strictEqual(row.target, "_blank");
      assert.match(row.rel, /noopener/);
      assert.match(row.rel, /noreferrer/);
    } else {
      assert.strictEqual(row.href, null, `リンクにしてはいけない: ${JSON.stringify(url)}`);
    }
  }
  // 引用符・タグを含む https URL はリンクにするが、属性から抜け出さない
  const quoted = rows.find(r => r.store === "店舗2");
  assert.ok(quoted.href.startsWith("https://example.com/?q="));
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll("#rankingTableBody script").length), 0);
  assert.strictEqual(await page.evaluate(() => window.__xss || 0), 0);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("XSS: Present検索のランキング・参考行の店舗名とURLを無害化し、正当な日本語店舗名とhttps URLはそのまま使う", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: [
      verifiedRow("買取ルデヤ", 224500, at),
      { ...verifiedRow(XSS_NAME, 223000, at), url: "javascript:window.__xss=11" },
      { ...verifiedRow(`"'><b>森</b>`, 260000, iso(40)), url: "data:text/html,x" }
    ],
    fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  await page.fill("#presentSearchInput", JAN);
  await page.click("#presentSearchBtn");
  await page.waitForFunction(() => /1位/.test(document.getElementById("presentRanking").textContent));
  const result = await page.evaluate(() => {
    const root = document.getElementById("presentRanking");
    return {
      xss: window.__xss || 0,
      elements: root.querySelectorAll("img, script, b").length,
      text: root.textContent,
      links: [...root.querySelectorAll("a.visit")].map(a => a.getAttribute("href"))
    };
  });
  assert.strictEqual(result.xss, 0);
  assert.strictEqual(result.elements, 0, "店舗名から要素が作られない");
  assert.ok(result.text.includes(XSS_NAME.slice(0, 20)));
  assert.ok(result.text.includes(`"'><b>森</b>`));
  assert.match(result.text, /1位\s*買取ルデヤ/);
  assert.deepStrictEqual(result.links, ["https://example.invalid/"], "正当な https URL だけリンク化");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("XSS: 商品マスター由来の商品名・JAN（Present検索の候補・商品名・選択メッセージ）を無害化する", async () => {
  // 商品キーは「モデル_容量_色」を "_" で区切って表示するため、ペイロードには "_" を含めない
  const evilModel = `<img src=x onerror="window.xssMaster=12">悪意`;
  const master = { [evilModel]: { "256GB": { "ブラック": "4549995734546", "シルバー": `"><img src=x onerror=window.xssMaster=13>` } } };
  const { page, errors } = await openWith(BASE_PRICES, {
    onRequest(route) {
      if (new URL(route.request().url()).pathname.endsWith("/data/product_master.json")) {
        route.fulfill({ contentType: "application/json", body: JSON.stringify(master) });
        return true;
      }
      return false;
    }
  });
  await page.waitForFunction(() => true);
  await page.fill("#presentSearchInput", "悪意");
  await page.click("#presentSearchBtn");
  await page.waitForSelector("#presentSearchMessage .present-candidate");
  const candidates = await page.evaluate(() => {
    const root = document.getElementById("presentSearchMessage");
    return {
      elements: root.querySelectorAll("img, script").length,
      texts: [...root.querySelectorAll(".present-candidate")].map(b => b.textContent.trim()),
      jans: [...root.querySelectorAll(".present-candidate")].map(b => b.dataset.jan)
    };
  });
  assert.strictEqual(candidates.elements, 0);
  assert.ok(candidates.texts.every(t => t.includes(evilModel)));
  assert.ok(candidates.jans.includes(`"><img src=x onerror=window.xssMaster=13>`), "data-jan 属性から抜け出さない");
  // 正当なJANの候補を選ぶ → 商品名・選択メッセージも文字として表示
  await page.click('#presentSearchMessage .present-candidate[data-jan="4549995734546"]');
  await page.waitForFunction(() => /悪意/.test(document.getElementById("presentProductName").textContent));
  const selected = await page.evaluate(() => ({
    elements: document.querySelectorAll("#presentProductName img, #presentSearchMessage img, #presentRanking img").length,
    name: document.getElementById("presentProductName").textContent,
    xss: window.xssMaster || window.__xss || 0
  }));
  assert.strictEqual(selected.elements, 0);
  assert.ok(selected.name.includes(evilModel));
  assert.strictEqual(selected.xss, 0);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("XSS: Apple Store在庫の店舗名・地域・状態・商品名を無害化する（状態は既知の値だけ class に使う）", async () => {
  const { page, errors } = await openWith(BASE_PRICES);
  const result = await page.evaluate(() => {
    APPLE_PRODUCTS = { products: { X: { part_number: "P1/A", jan: "4549995734546", model: `<img src=x onerror="window.__xss=14">`, storage: "256GB", color: "<b>黒</b>", apple_price: 239800 } } };
    APPLE_INVENTORY = { products: { "P1/A": { overall_status: "ok", available_store_count: 1, stores: [
      { store_name: `<script>window.__xss=15</script>銀座`, state: `<img src=x onerror="window.__xss=16">東京都`, status: "available" },
      { store_name: "渋谷", state: "東京都", status: `x" onclick="window.__xss=17` }
    ] } } };
    const box = document.createElement("div");
    document.body.appendChild(box);
    window.renderAppleInventory("4549995734546", box);
    return {
      elements: box.querySelectorAll("img, script, b").length,
      text: box.textContent,
      statusClasses: [...box.querySelectorAll(".apple-store-status")].map(e => e.className),
      onclick: [...box.querySelectorAll("[onclick]")].length,
      xss: window.__xss || 0
    };
  });
  assert.strictEqual(result.elements, 0);
  assert.ok(result.text.includes("<script>window.__xss=15</script>銀座"));
  assert.ok(result.text.includes("<b>黒</b>"));
  assert.strictEqual(result.onclick, 0, "状態の値から属性を作らない");
  assert.ok(result.statusClasses.includes("apple-store-status available"));
  assert.ok(result.statusClasses.includes("apple-store-status unknown"));
  assert.strictEqual(result.xss, 0);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("既存機能: 森森買取の紹介コード・コピー、通常の日本語店舗名、https の公式リンク、利益計算は従来どおり", async () => {
  const at = iso(1);
  const { page, errors } = await openWith(withItem({
    stores: [
      { ...verifiedRow("森森買取", 226000, at), url: "https://www.morimori-kaitori.jp/search?sk=4549995734546" },
      { ...verifiedRow("買取ルデヤ", 224500, at), url: "https://kaitori-rudeya.com/search/index/4549995734546" }
    ],
    fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x"
  }));
  const rows = await page.evaluate(() => [...document.querySelectorAll("#rankingTableBody tr")].map(tr => ({
    text: tr.textContent.replace(/\s+/g, " "),
    href: tr.querySelector("a.visit") && tr.querySelector("a.visit").getAttribute("href"),
    coupon: tr.querySelector(".copy-coupon") && tr.querySelector(".copy-coupon").dataset.code
  })));
  assert.match(rows[0].text, /1位 森森買取 紹介コードあり/);
  assert.strictEqual(rows[0].href, "https://www.morimori-kaitori.jp/search?sk=4549995734546");
  assert.strictEqual(rows[0].coupon, "InfA00172");
  assert.match(rows[1].text, /2位 買取ルデヤ/);
  assert.strictEqual(rows[1].href, "https://kaitori-rudeya.com/search/index/4549995734546");
  assert.strictEqual((await page.textContent("#maxPriceCard")).trim(), "¥226,000");
  assert.match((await page.textContent("#finalProfitCard")).trim(), /^-¥/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

/* ---------- カテゴリー（Android・ゲーム・トレカ・カメラ・家電）のランキング表示の再現 ---------- */

const catalogCore = require("../assets/catalog-core.js");
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "data/catalog.json"), "utf8"));
const REAL_CATALOG_PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, "data/catalog_prices.json"), "utf8"));

/*
 * 実データの catalog_prices.json を「生成から1時間後」として扱えるよう、日時だけをずらす。
 * 価格・店舗・状態は変えない（テスト実行日によって全件が古い価格にならないように）。
 */
function shiftedCatalogPrices(hoursSinceGenerated = 1) {
  const shift = Date.now() - hoursSinceGenerated * 3600000 - Date.parse(REAL_CATALOG_PRICES.generated_at);
  const move = v => (v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v) + shift).toISOString() : v);
  const products = {};
  for (const [id, rows] of Object.entries(REAL_CATALOG_PRICES.products)) {
    products[id] = rows.map(r => ({ ...r, observed_at: move(r.observed_at), checked_at: move(r.checked_at) }));
  }
  return { ...REAL_CATALOG_PRICES, generated_at: move(REAL_CATALOG_PRICES.generated_at), products };
}

async function rankedStoresInDetail(page) {
  return page.$$eval("#catalogRanking .catalog-store", rows => rows
    .filter(r => r.querySelector(".catalog-rank"))
    .map(r => ({
      store: r.querySelector(".catalog-store-name").textContent.trim(),
      price: r.querySelector(".catalog-store-price").firstChild.textContent.trim(),
      href: r.querySelector("a") && r.querySelector("a").getAttribute("href")
    })));
}

test("カテゴリー再現: 実データの全商品で、画面のランキングが有効な価格（36時間以内・取得成功）の店舗・順序・価格と一致し、複数店舗の商品は複数店舗を表示する", async () => {
  const catalogPrices = shiftedCatalogPrices(1);
  const { page, errors } = await openWith(BASE_PRICES, { catalogPrices });
  const summary = {};
  for (const category of ["other", "games", "cameras", "appliances", "cards"]) {
    await page.click(`[data-catalog-category="${category}"]`);
    if (category === "cards") await page.click('[data-card-view="packs"]');
    const ids = await page.$$eval("#catalogProducts [data-product]", bs => bs.map(b => b.dataset.product));
    const catalogIds = new Set(CATALOG.products.filter(p => p.category === category).map(p => p.id));
    const s = summary[category] = { products: 0, multi: 0 };
    for (const id of ids.filter(x => catalogIds.has(x))) {
      const expected = catalogCore.ranking(catalogPrices.products[id] || []);
      await page.click(`#catalogProducts [data-product="${id}"]`);
      await page.waitForSelector("#catalogDetail:not([hidden])");
      const shown = await rankedStoresInDetail(page);
      assert.deepStrictEqual(shown.map(r => r.store), expected.map(q => q.store), `${category}/${id} の順位`);
      assert.deepStrictEqual(shown.map(r => r.price), expected.map(q => `¥${q.price.toLocaleString("ja-JP")}`), `${category}/${id} の価格`);
      for (const r of shown) assert.match(r.href, /^https:\/\//, `${category}/${id} ${r.store} の公式リンク`);
      s.products++;
      if (expected.length >= 2) {
        s.multi++;
        assert.ok(shown.length >= 2, `${category}/${id}: 複数店舗の有効価格があるのに ${shown.length} 店舗しか表示されない`);
      }
      await page.click("#catalogBack");
      await page.waitForSelector("#catalogList:not([hidden])");
    }
  }
  // 実データ（2026-11-10）で複数店舗の有効価格がある商品が、どのカテゴリーにも存在すること
  assert.ok(summary.other.products === 40 && summary.other.multi >= 1, JSON.stringify(summary));
  for (const c of ["games", "cameras", "appliances", "cards"]) assert.ok(summary[c].multi >= 1, `${c}: ${JSON.stringify(summary[c])}`);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("カテゴリー再現: Android（Pixel 10a）で買取一丁目と買取ルデヤを価格順に表示し、一覧カードにも比較可能店舗数を出す", async () => {
  const catalogPrices = shiftedCatalogPrices(1);
  const id = "android-0840353950054"; // Google Pixel 10a 256GB fog
  const expected = catalogCore.ranking(catalogPrices.products[id]);
  assert.ok(expected.length >= 2, "実データの前提: 複数店舗の有効価格がある");
  const { page, errors } = await openWith(BASE_PRICES, { catalogPrices, viewport: { width: 375, height: 812 } });
  await page.click('[data-catalog-category="other"]');
  const card = (await page.textContent(`#catalogProducts [data-product="${id}"]`)).replace(/\s+/g, " ");
  assert.ok(card.includes(`${expected[0].store} ／ 比較可能 ${expected.length}店`), card);
  await page.click(`#catalogProducts [data-product="${id}"]`);
  await page.waitForSelector("#catalogDetail:not([hidden])");
  const shown = await rankedStoresInDetail(page);
  assert.deepStrictEqual(shown.map(r => r.store), expected.map(q => q.store));
  const best = (await page.textContent("#catalogBest")).replace(/\s+/g, " ");
  assert.ok(best.includes(`最高買取 ¥${expected[0].price.toLocaleString("ja-JP")} ／ ${expected[0].store}`), best);
  // 取得失敗・掲載なしの店舗は順位外として、データの状態どおりの理由付きで表示（価格を出さない）
  const excluded = await page.$$eval("#catalogRanking .catalog-store", rows => rows.filter(r => !r.querySelector(".catalog-rank")).map(r => r.textContent.replace(/\s+/g, " ")));
  const reasons = { not_found: "対象条件の価格なし", condition_mismatch: "条件不一致", error: "取得失敗", stopped: "本日の取得を停止" };
  for (const store of ["買取ホムラ", "買取商店"]) {
    const row = catalogPrices.products[id].find(r => r.store === store);
    assert.ok(row && reasons[row.status], `実データの前提: ${store}は${Object.keys(reasons).join("/")}`);
    assert.ok(excluded.some(t => t.includes(store) && t.includes(reasons[row.status])), store);
  }
  assert.ok(excluded.every(t => !/¥/.test(t)), "順位外の店舗に価格を出さない");
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("カテゴリー再現: 買取一丁目の価格が36時間を超えて古い場合は順位から外し、ルデヤだけを順位表示する（古い価格を最新扱いしない）", async () => {
  const catalogPrices = shiftedCatalogPrices(1);
  const id = "android-0840353950054"; // Google Pixel 10a 256GB fog
  catalogPrices.products[id] = catalogPrices.products[id].map(r => (r.store === "買取一丁目"
    ? { ...r, observed_at: new Date(Date.now() - 40 * 3600000).toISOString() }
    : r));
  const { page, errors } = await openWith(BASE_PRICES, { catalogPrices });
  await page.click('[data-catalog-category="other"]');
  await page.click(`#catalogProducts [data-product="${id}"]`);
  await page.waitForSelector("#catalogDetail:not([hidden])");
  assert.deepStrictEqual((await rankedStoresInDetail(page)).map(r => r.store), ["買取ルデヤ"]);
  const excluded = await page.$$eval("#catalogRanking .catalog-store", rows => rows.filter(r => !r.querySelector(".catalog-rank")).map(r => r.textContent.replace(/\s+/g, " ")));
  assert.ok(excluded.some(t => /買取一丁目.*価格が古いため順位から除外/.test(t)));
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("カテゴリー再現: ホムラの条件不一致・本日停止は理由付きで順位外に表示し、価格を出さない", async () => {
  const catalogPrices = shiftedCatalogPrices(1);
  const ids = ["switch2-jp", "switch2-mario"];
  const statuses = { "switch2-jp": "condition_mismatch", "switch2-mario": "stopped" };
  for (const id of ids) {
    catalogPrices.products[id] = catalogPrices.products[id].map(r => (r.store_id === "homura"
      ? { ...r, status: statuses[id], price: null, observed_at: null, reason: "除外語「開封済」を含む" }
      : r));
  }
  const { page, errors } = await openWith(BASE_PRICES, { catalogPrices });
  await page.click('[data-catalog-category="games"]');
  for (const [id, label] of [["switch2-jp", "条件不一致"], ["switch2-mario", "本日の取得を停止"]]) {
    await page.click(`#catalogProducts [data-product="${id}"]`);
    await page.waitForSelector("#catalogDetail:not([hidden])");
    const shown = await rankedStoresInDetail(page);
    assert.ok(!shown.some(r => r.store === "買取ホムラ"), id);
    const row = await page.$$eval("#catalogRanking .catalog-store", rows => rows.filter(r => !r.querySelector(".catalog-rank") && r.textContent.includes("買取ホムラ")).map(r => r.textContent.replace(/\s+/g, " ")));
    assert.strictEqual(row.length, 1, id);
    assert.ok(row[0].includes(label) && !/¥/.test(row[0]), row[0]);
    await page.click("#catalogBack");
  }
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("初期表示: ページを開いた直後は iPhone Duo 256GB スターホワイトが選ばれ、データどおりの店舗だけを表示する（報告の「ルデヤだけ」の再現条件）", async () => {
  const at = iso(1);
  const duo = "4549995732641";
  const prices = { ...BASE_PRICES, [duo]: { stores: [verifiedRow("買取ルデヤ", 367000, at)], fetch_status: "ok", last_checked_at: at, last_success_at: at, last_update: "x" } };
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { window.turnstile = { render() { return "w"; }, remove() {}, reset() {}, execute() {} }; });
  await page.route("**/*", route => {
    const url = route.request().url();
    if (!url.startsWith(baseUrl)) return route.abort();
    if (new URL(url).pathname.endsWith("/data/prices.json")) return route.fulfill({ contentType: "application/json", body: JSON.stringify(prices) });
    return route.continue();
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => /読み込みました|失敗しました/.test(document.getElementById("statusAlert").textContent));
  assert.strictEqual(await page.inputValue("#modelSelect"), "iPhone Duo");
  assert.strictEqual((await page.textContent("#currentJan")).trim(), duo);
  const rows = await page.locator("#rankingTableBody tr").allTextContents();
  assert.strictEqual(rows.length, 1);
  assert.match(rows[0], /1位[\s\S]*買取ルデヤ/);
  assert.deepStrictEqual(errors, []);
  await page.close();
});

test("利用者保護: カタログの一覧と詳細に、比較可能店舗数・取得対象店舗数・最高値の取得日時を出す（古い価格は数に含めない）", async () => {
  const catalogPrices = shiftedCatalogPrices(1);
  const id = "android-0840353950054"; // Google Pixel 10a 256GB fog
  const rows = catalogPrices.products[id];
  const expected = catalogCore.ranking(rows);
  assert.ok(expected.length >= 2 && rows.length > expected.length, "実データの前提: 複数店舗の有効価格と順位外の店舗がある");
  const jst = value => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " JST";
  const { page, errors } = await openWith(BASE_PRICES, { catalogPrices, viewport: { width: 375, height: 812 } });
  await page.click('[data-catalog-category="other"]');
  const card = (await page.textContent(`#catalogProducts [data-product="${id}"]`)).replace(/\s+/g, " ");
  assert.ok(card.includes(`比較可能 ${expected.length}店（対象${rows.length}店）`), card);
  await page.click(`#catalogProducts [data-product="${id}"]`);
  await page.waitForSelector("#catalogDetail:not([hidden])");
  const best = (await page.textContent("#catalogBest")).replace(/\s+/g, " ");
  assert.ok(best.includes(`（取得 ${jst(expected[0].observed_at)}）`), best);
  assert.ok(best.includes(`比較可能 ${expected.length}店 ／ 取得対象 ${rows.length}店（順位外 ${rows.length - expected.length}店）`), best);
  await page.close();

  // 2位の店舗の価格が36時間を超えて古い場合は、比較可能の数から外す
  const stale = shiftedCatalogPrices(1);
  stale.products[id] = stale.products[id].map(r => (r.store === expected[1].store ? { ...r, observed_at: new Date(Date.now() - 40 * 3600000).toISOString() } : r));
  const second = await openWith(BASE_PRICES, { catalogPrices: stale });
  await second.page.click('[data-catalog-category="other"]');
  const staleCard = (await second.page.textContent(`#catalogProducts [data-product="${id}"]`)).replace(/\s+/g, " ");
  assert.ok(staleCard.includes(`比較可能 ${expected.length - 1}店（対象${rows.length}店）`), staleCard);
  await second.page.click(`#catalogProducts [data-product="${id}"]`);
  await second.page.waitForSelector("#catalogDetail:not([hidden])");
  const staleBest = (await second.page.textContent("#catalogBest")).replace(/\s+/g, " ");
  assert.ok(staleBest.includes(`比較可能 ${expected.length - 1}店 ／ 取得対象 ${rows.length}店`), staleBest);
  assert.deepStrictEqual([...errors, ...second.errors], []);
  await second.page.close();
});
