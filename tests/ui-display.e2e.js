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

async function openWith(prices, { select = ["iPhone 18 Pro Max", "256GB", "ブラック"], expectJan = JAN, onRequest = null, catalogPrices = null } = {}) {
  const page = await browser.newPage();
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
