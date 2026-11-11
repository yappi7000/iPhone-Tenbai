"use strict";

/*
 * 価格取得率の改善（2026/11/3 調査）の回帰テスト
 *
 *   node --test tests/price-coverage.test.js
 *
 * ネットワーク・ブラウザは使わない。店舗ページは抽出処理が読む本文の形だけを再現する
 * （診断データに残っている caution「基準232,000円 / ブラック -9,000円」等と同じ形）。
 */

const test = require("node:test");
const assert = require("node:assert");

const { classifyFetchOutcome } = require("../assets/fetch-outcome.js");
const {
  storesForItem,
  shouldCacheStaticPage,
  isPageReady,
  STATIC_CACHE_STORE_IDS,
  extractIchomePrice,
  extractRakuenPrice,
  extractRudeyaPrice,
  extractMobileIchibanPrice,
  unlistedColorBase,
  colorLabelsIn
} = require("../scripts/crawler.js");
const { priceRangeFor } = require("../scripts/price_rules.js");
const {
  ALERT_STREAK,
  summarizeRun,
  dominantCause,
  updateHealth,
  listAlerts,
  planIssues,
  formatReport,
  zeroSuccessStores,
  evaluateGate,
  formatGate,
  gateAnnotations
} = require("../scripts/store_health.js");

const ICHOME = { id: "ichome", name: "買取一丁目" };
const okResponse = { ok: () => true };

/*
 * 描画後の買取一丁目の本文（2842文字のページに相当する部分）
 */
const ICHOME_RENDERED = [
  "買取１丁目",
  "iPhone 18 Pro Max 256GB",
  "ブラック -9,000",
  "グレイシャ -7,000",
  "未開封 ¥232,000",
  "iPhone 18 Pro Max 512GB",
  "ブラック -9,000",
  "未開封 ¥269,000",
  "iPhone 18 Pro 256GB",
  "シルバー -11,000",
  "未開封 ¥203,000"
].join("\n");

// 描画前（909文字のページに相当）: ヘッダー・メニューだけで価格表が無い
const ICHOME_SKELETON = "買取１丁目\nホーム 買取価格表 店舗案内 お問い合わせ\n携帯・スマホ買取\n読み込み中";

/* ---------- 買取一丁目: 描画前のページを掲載なしにしない ---------- */

test("描画確認: 一丁目は価格表（未開封 ¥…）が現れた本文だけを描画済みとみなす", () => {
  assert.strictEqual(isPageReady("ichome", ICHOME_RENDERED), true);
  assert.strictEqual(isPageReady("ichome", ICHOME_SKELETON), false);
  assert.strictEqual(isPageReady("ichome", ""), false);
  // 目印を設定していない店舗は従来どおり（待たない・判定しない）
  assert.strictEqual(isPageReady("rudeya", "何でも"), true);
});

test("描画確認: 描画前のページは「掲載なし」ではなく「抽出失敗」、描画済みで商品が無ければ従来どおり掲載なし", () => {
  const base = {
    status: "ERROR", http: { status: 200, ok: true }, price: null, color_verified: false,
    product: { jan_found: false, name_found: false }, errors: ["商品名に一致する商品が見つかりません"]
  };
  const incomplete = { ...base, page: { title: "買取１丁目", body_length: 909, body_available: true, incomplete: true } };
  const rendered = { ...base, page: { title: "買取１丁目", body_length: 2842, body_available: true } };
  assert.strictEqual(classifyFetchOutcome(incomplete), "extraction_failed");
  assert.strictEqual(classifyFetchOutcome(rendered), "no_price");
});

test("キャッシュ: 一丁目は描画済みのページだけを使い回し、描画前のページは使い回さない", () => {
  assert.ok(STATIC_CACHE_STORE_IDS.has("ichome"));
  const page = { page: { title: "買取１丁目" } };
  assert.strictEqual(shouldCacheStaticPage(ICHOME, okResponse, ICHOME_RENDERED, page), true);
  assert.strictEqual(shouldCacheStaticPage(ICHOME, okResponse, ICHOME_SKELETON, page), false);
  assert.strictEqual(shouldCacheStaticPage(ICHOME, { ok: () => false }, ICHOME_RENDERED, page), false);
});

test("キャッシュの正確性: 一丁目は同じ本文からSKUごとに正しい価格を出し、別容量・Pro/Pro Max・未掲載色の価格を流用しない", () => {
  const pm256black = extractIchomePrice(ICHOME_RENDERED, "iPhone 18 Pro Max 256GB ブラック");
  assert.strictEqual(pm256black.price, 232000 - 9000);
  assert.strictEqual(pm256black.color_verified, true);

  const pm256glacier = extractIchomePrice(ICHOME_RENDERED, "iPhone 18 Pro Max 256GB グレイシャー");
  assert.strictEqual(pm256glacier.price, 232000 - 7000);

  const pm512black = extractIchomePrice(ICHOME_RENDERED, "iPhone 18 Pro Max 512GB ブラック");
  assert.strictEqual(pm512black.price, 269000 - 9000, "256GB の価格・増減を流用しない");

  const pro256silver = extractIchomePrice(ICHOME_RENDERED, "iPhone 18 Pro 256GB シルバー");
  assert.strictEqual(pro256silver.price, 203000 - 11000, "Pro Max のブロックを Pro に流用しない");

  // 未掲載のSKUは別SKUの価格を拾わない
  const pro512 = extractIchomePrice(ICHOME_RENDERED, "iPhone 18 Pro 512GB ブラック");
  assert.strictEqual(pro512.found, false);
  assert.strictEqual(pro512.price, null);
});

test("色別検証の維持: 一丁目で増減一覧に無い色（バーガンディ）は基準価格を流用せず、根拠の無さを記録する", () => {
  const r = extractIchomePrice(ICHOME_RENDERED, "iPhone 18 Pro Max 256GB バーガンディ");
  assert.strictEqual(r.price, null);
  assert.strictEqual(r.color_verified, false);
  assert.match(r.error, /対象色の明示条件なし/);
  assert.match(r.caution, /基準232,000円/);
  assert.match(r.caution, /ブラック・グレイシャ/);
  assert.match(r.caution, /バーガンディの価格根拠なし/);
});

/* ---------- 買取楽園: 「紫以外」は紫を名指しした基準色の明記 ---------- */

function rakuenBody(condition) {
  return [
    "iPhone 18 Promax 512GB",
    "SIM FREE 未開封",
    "新品: ¥270,000",
    condition,
    "SIM FREE 開封済み",
    "中古: ¥200,000"
  ].join("\n");
}

test("楽園: 「紫以外-1,000」なら紫（バーガンディ）は基準価格、他色は減額（どちらも色別検証済み）", () => {
  const body = rakuenBody("紫以外-1,000");
  const purple = extractRakuenPrice(body, "iPhone 18 Pro Max 512GB バーガンディ");
  assert.strictEqual(purple.price, 270000);
  assert.strictEqual(purple.color_verified, true);

  const black = extractRakuenPrice(body, "iPhone 18 Pro Max 512GB ブラック");
  assert.strictEqual(black.price, 269000);
  assert.strictEqual(black.color_verified, true);
});

test("楽園: 紫の記載が無い（黒・青/銀の明示価格だけ）なら、紫に基準価格を流用しない", () => {
  const body = rakuenBody("黒 261,000\n青/銀 263,000");
  const purple = extractRakuenPrice(body, "iPhone 18 Pro Max 512GB バーガンディ");
  assert.strictEqual(purple.price, null);
  assert.strictEqual(purple.color_verified, false);
  assert.match(purple.error, /対象色の価格根拠なし/);
  assert.match(purple.caution, /基準270,000円/);
  assert.match(purple.caution, /色表記: 黒・青・銀/);

  // 明示されている色は従来どおり
  assert.strictEqual(extractRakuenPrice(body, "iPhone 18 Pro Max 512GB ブラック").price, 261000);
  assert.strictEqual(extractRakuenPrice(body, "iPhone 18 Pro Max 512GB シルバー").price, 263000);
});

test("楽園: 紫を名指しした明示価格（紫 ¥…）は従来どおり採用し、Pro と Promax を取り違えない", () => {
  const body = rakuenBody("紫 ¥270,000\n黒 261,000");
  assert.strictEqual(extractRakuenPrice(body, "iPhone 18 Pro Max 512GB バーガンディ").price, 270000);
  assert.strictEqual(extractRakuenPrice(body, "iPhone 18 Pro 512GB バーガンディ").found, false);
});

test("色表記の記録: 診断用に色ラベルだけを抜き出す（価格判定には使わない）", () => {
  assert.deepStrictEqual(colorLabelsIn("ブラック -9,000 グレイシャ -7,000 未開封"), ["ブラック", "グレイシャ"]);
  assert.deepStrictEqual(colorLabelsIn("紫以外-1000"), ["紫以外"]);
  assert.deepStrictEqual(colorLabelsIn(""), []);
});

/* ---------- 携帯空間の保留 ---------- */

test("保留: 携帯空間（色根拠の無い表で過去0件）は巡回対象から外し、他店舗・Duo の対象は変えない", () => {
  const pro = storesForItem({ model: "iPhone 18 Pro Max", storage: "512GB", color: "バーガンディ" }).map(s => s.id);
  assert.ok(!pro.includes("keitaispace"));
  assert.deepStrictEqual(pro, ["mobasute", "morimori", "rudeya", "rakuen", "ichome", "iphonekaitori", "kaitoriwiki", "mobilemix", "mobileichiban", "kaitorishouten"]);
  const duo = storesForItem({ model: "iPhone Duo", storage: "512GB", color: "ナイトスカイ" }).map(s => s.id).sort();
  assert.deepStrictEqual(duo, ["iphonekaitori", "kaitorishouten", "kaitoriwiki", "morimori", "rudeya"]);
});

/* ---------- 店舗別レポート・継続異常の検知・Issue 計画 ---------- */

const TARGETS = Array.from({ length: 40 }, (_, i) => ({ jan: String(4549995700000 + i), name: `SKU${i}` }));

function diag(rowsFor, finished = "2026-11-03T03:58:44.025Z") {
  const stores = [];
  for (const t of TARGETS) for (const r of rowsFor(t)) stores.push({ jan: t.jan, ...r });
  return { finished_at_iso: finished, targets: TARGETS, target_count: TARGETS.length, stores };
}

const row = (store_id, store, outcome, extra = {}) => ({ store_id, store, outcome, http: { status: 200 }, errors: [], ...extra });

function sampleRun(finished, { rudeya = "success", mobasute = "blocked" } = {}) {
  return diag(t => [
    row("rudeya", "買取ルデヤ", rudeya),
    row("mobasute", "モバステ", t.jan.endsWith("0") ? mobasute : "stopped", { http: { status: 403 }, errors: ["HTTP status 403"] }),
    row("iphonekaitori", "iPhone買取価格表", "connection_error", { http: { status: null }, errors: ["page.goto: net::ERR_EMPTY_RESPONSE at https://www.iphonekaitori.tokyo/brand/apple/market-price\nCall log: ..."] })
  ], finished);
}

test("レポート: 店舗別・原因別の件数と主な理由（URL・ログは除く）、価格1店舗だけのSKU数を出す", () => {
  const run = summarizeRun(sampleRun("2026-11-03T03:58:44.025Z"));
  assert.strictEqual(run.scheduled, true);
  assert.strictEqual(run.stores.rudeya.success, 40);
  assert.deepStrictEqual(run.stores.iphonekaitori.by_outcome, { connection_error: 40 });
  assert.strictEqual(run.stores.iphonekaitori.top_reasons[0][0], "接続エラー: page.goto: net::ERR_EMPTY_RESPONSE");
  assert.strictEqual(run.sku_coverage.one.length, 40);
  assert.strictEqual(run.sku_coverage.zero.length, 0);
  const text = formatReport(run, { stores: {} }, []);
  assert.match(text, /\| iPhone買取価格表 ❗ \| 0\/40（0%） \| 0 \| 40 \|/);
  assert.match(text, /\| 買取ルデヤ \| 40\/40（100%） \|/);
  assert.match(text, /継続異常なし/);
});

test("継続異常: アクセス停止はアクセス制限の結果として同じ原因にまとめる", () => {
  assert.strictEqual(dominantCause({ by_outcome: { blocked: 1, stopped: 39 } }), "blocked");
  assert.strictEqual(dominantCause({ by_outcome: { no_price: 20, extraction_failed: 5 } }), "no_price");
});

test("継続異常: 同じ原因の価格0件が3回続いた店舗だけを通知し、原因が変われば数え直し、回復で0に戻す", () => {
  let health = { stores: {} };
  for (let day = 1; day <= ALERT_STREAK - 1; day++) {
    health = updateHealth(health, summarizeRun(sampleRun(`2026-11-0${day}T03:00:00.000Z`)));
  }
  assert.deepStrictEqual(listAlerts(health), [], "2回目まではまだ通知しない");

  health = updateHealth(health, summarizeRun(sampleRun("2026-11-03T03:00:00.000Z")));
  const keys = listAlerts(health).map(a => a.key).sort();
  assert.deepStrictEqual(keys, ["iphonekaitori:connection_error", "mobasute:blocked"]);
  assert.strictEqual(health.stores.rudeya.streak, 0);
  assert.strictEqual(health.stores.rudeya.last_success_at, "2026-11-03T03:00:00.000Z");

  // 原因が変わる（接続エラー → タイムアウト）と1回目から数え直す
  const changed = diag(() => [row("iphonekaitori", "iPhone買取価格表", "timeout", { http: { status: null }, errors: ["page.goto: Timeout 15000ms exceeded."] })], "2026-11-04T03:00:00.000Z");
  health = updateHealth(health, summarizeRun(changed));
  assert.strictEqual(health.stores.iphonekaitori.cause, "timeout");
  assert.strictEqual(health.stores.iphonekaitori.streak, 1);
  // 今回巡回しなかった店舗（保留など）は履歴を残すが、通知しない（ずっと残る通知にしない）
  assert.strictEqual(health.stores.mobasute.streak, ALERT_STREAK);
  assert.strictEqual(health.stores.mobasute.active, false);
  assert.ok(!listAlerts(health).some(a => a.store_id === "mobasute"));

  // 1件でも取れれば回復
  const recovered = diag(t => [row("mobasute", "モバステ", t.jan.endsWith("1") ? "success" : "blocked")], "2026-11-05T03:00:00.000Z");
  health = updateHealth(health, summarizeRun(recovered));
  assert.strictEqual(health.stores.mobasute.streak, 0);
  assert.strictEqual(health.stores.mobasute.cause, null);
});

test("継続異常: オンデマンド（1SKU）は定時実行とみなさず、履歴更新の対象にしない", () => {
  const one = { finished_at_iso: "x", targets: [TARGETS[0]], target_count: 1, stores: [row("rudeya", "買取ルデヤ", "blocked")].map(r => ({ jan: TARGETS[0].jan, ...r })) };
  assert.strictEqual(summarizeRun(one).scheduled, false);
});

test("Issue計画: 同じ店舗・原因のIssueは重複させず更新し、回復した店舗のIssueはクローズする", () => {
  let health = { stores: {} };
  for (let day = 1; day <= ALERT_STREAK; day++) health = updateHealth(health, summarizeRun(sampleRun(`2026-11-0${day}T03:00:00.000Z`)));
  const alerts = listAlerts(health);
  const open = [
    { number: 11, title: "古いタイトル", body: "<!-- crawler-health:mobasute:blocked -->\n..." },
    { number: 12, title: "重複", body: "<!-- crawler-health:mobasute:blocked -->\n..." },
    { number: 13, title: "回復済み", body: "<!-- crawler-health:rudeya:blocked -->\n..." },
    { number: 14, title: "手動のIssue", body: "通知と無関係" }
  ];
  const plan = planIssues(alerts, open);
  const byAction = a => plan.filter(p => p.action === a);
  assert.deepStrictEqual(byAction("update").map(p => p.number), [11], "既存Issueを更新し、新しく作らない");
  assert.deepStrictEqual(byAction("create").map(p => p.title), ["[価格取得] iPhone買取価格表: 接続エラー が3回以上連続（価格0件）"]);
  assert.deepStrictEqual(byAction("close").map(p => p.number), [13]);
  assert.ok(!plan.some(p => p.number === 12 || p.number === 14), "重複・無関係のIssueには触れない");
  const created = byAction("create")[0];
  assert.match(created.body, /<!-- crawler-health:iphonekaitori:connection_error -->/);
  assert.match(created.body, /回避せず/);
  assert.strictEqual(created.label, "crawler-health");
});

test("Issue計画: 継続異常が無ければ何も作らない", () => {
  assert.deepStrictEqual(planIssues([], []), []);
});

/* ---------- 色別価格: 記載のない色（正式価格は店舗表記がある場合だけ、それ以外は参考価格） ---------- */

test("記載のない色: 店舗の明記があるときだけ正式価格、他色だけの記載は参考価格、対象色・色限定・あいまいな記載は価格なし", () => {
  assert.deepStrictEqual(unlistedColorBase("シルバー -5,000 記載のない色は基準価格", "バーガンディ", 262000),
    { official: true, reference: false, rule: "記載のない色は基準価格（店舗表記）" });
  assert.strictEqual(unlistedColorBase("シルバー -5,000 上記以外のカラーは同額", "ブラック", 262000).official, true);
  const ref = unlistedColorBase("シルバー -5,000", "バーガンディ", 262000);
  assert.deepStrictEqual([ref.official, ref.reference], [false, true]);
  assert.match(ref.reason, /バーガンディの記載なし（色別の記載はシルバーのみ）/);
  // 対象色が（別名で）書かれているのに読めない場合は推測しない
  assert.deepStrictEqual(unlistedColorBase("紫 要相談 シルバー -5,000", "バーガンディ", 262000), { official: false, reference: false });
  assert.deepStrictEqual(unlistedColorBase("黒 -3,000", "ブラック", 262000), { official: false, reference: false });
  // 色限定・色により異なる等は参考価格にもしない
  for (const text of ["シルバーのみ買取", "色により異なる シルバー -5,000", "カラーによって変動 黒 -1,000", "色は要確認 シルバー -5,000"]) {
    assert.deepStrictEqual(unlistedColorBase(text, "バーガンディ", 262000), { official: false, reference: false }, text);
  }
  // 色の記載が全く無い・基準価格が不正なら何もしない
  assert.deepStrictEqual(unlistedColorBase("未開封のみ", "バーガンディ", 262000), { official: false, reference: false });
  assert.deepStrictEqual(unlistedColorBase("シルバー -5,000", "バーガンディ", null), { official: false, reference: false });
});

test("記載のない色: 一丁目・モバイル一番・楽園で、明記なしは価格を出さず参考価格だけ、明記ありは正式価格", () => {
  // 一丁目（実ページと同じ形）: バーガンディは増減一覧に無い → 価格なし・参考価格
  const ichome = extractIchomePrice(ICHOME_RENDERED, "iPhone 18 Pro Max 256GB バーガンディ");
  assert.deepStrictEqual([ichome.price, ichome.color_verified, ichome.reference_price], [null, false, 232000]);
  assert.match(ichome.error, /対象色の明示条件なし/, "正式価格の判定は従来どおり");
  assert.match(ichome.reference_reason, /ブラック・グレイシャー/);
  // 店舗が「記載のない色は基準価格」と明記した場合だけ正式価格
  const officialPage = ICHOME_RENDERED.replace("グレイシャ -7,000\n", "グレイシャ -7,000\n記載のない色は基準価格\n");
  const ichomeOfficial = extractIchomePrice(officialPage, "iPhone 18 Pro Max 256GB バーガンディ");
  assert.deepStrictEqual([ichomeOfficial.price, ichomeOfficial.color_verified], [232000, true]);
  assert.match(ichomeOfficial.caution, /記載のない色は基準価格（店舗表記）/);
  // 記載のある色の判定は変えない
  assert.strictEqual(extractIchomePrice(officialPage, "iPhone 18 Pro Max 256GB ブラック").price, 232000 - 9000);

  // モバイル一番（11/11 の診断と同じ「シルバー -5000」だけの記載）
  const ichibanBody = "iPhone 18 Pro Max 512GB simfree未開封 シルバー -5000 新品 262,000円";
  const burgundy = extractMobileIchibanPrice(ichibanBody, "iPhone 18 Pro Max 512GB バーガンディ");
  assert.deepStrictEqual([burgundy.price, burgundy.reference_price], [null, 262000]);
  const silver = extractMobileIchibanPrice(ichibanBody, "iPhone 18 Pro Max 512GB シルバー");
  assert.deepStrictEqual([silver.price, silver.color_verified, silver.reference_price], [257000, true, undefined]);

  // 楽園: 黒・青/銀の明示価格だけ → 紫は価格なし・参考価格（基準価格）
  const rakuen = extractRakuenPrice(rakuenBody("黒 261,000\n青/銀 263,000"), "iPhone 18 Pro Max 512GB バーガンディ");
  assert.deepStrictEqual([rakuen.price, rakuen.color_verified, rakuen.reference_price], [null, false, 270000]);
});

test("記載のない色: 参考価格は prices.json の reference_stores だけに入り、stores・成功数・公開前検証に混ざらない", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { updatePricesJsonSafely } = require("../scripts/crawler.js");
  const { verifyPrices } = require("../scripts/verify_prices.js");
  const { extractTargets } = require("../scripts/price_rules.js");
  const indexHtml = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const targets = extractTargets(indexHtml);
  const burgundy = targets.find(t => t.name === "iPhone 18 Pro Max 512GB バーガンディ");
  const row = (t, store_id, store, extra) => ({ store_id, store, jan: t.jan, status: "ERROR", price: null, color_verified: false,
    outcome: "extraction_failed", http: { status: 200 }, errors: [], checked_at: "2026/11/12 10:00:00", url: `https://example.test/${store_id}`, ...extra });
  const stores = [];
  for (const t of targets) {
    stores.push(row(t, "rudeya", "買取ルデヤ", { status: "OK", price: t.model === "iPhone Duo" ? 410000 : 262000, color_verified: true, outcome: "success" }));
    if (t === burgundy) {
      stores.push(row(t, "ichome", "買取一丁目", { reference_price: 262000, reference_reason: "バーガンディの記載なし（色別の記載はシルバーのみ）。基準価格を参考表示" }));
      stores.push(row(t, "mobileichiban", "モバイル一番", { reference_price: 9999999, reference_reason: "範囲外" }));
    }
  }
  const diagnostics = { started_at: "2026/11/12 10:00:00", finished_at: "2026/11/12 10:05:00",
    started_at_iso: "2026-11-12T01:00:00.000Z", finished_at_iso: "2026-11-12T01:05:00.000Z", targets, target_count: targets.length, stores };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prices-ref-"));
  const file = path.join(dir, "prices.json");
  fs.writeFileSync(file, "{}");
  const saved = process.env.TARGET_JAN;
  delete process.env.TARGET_JAN;
  try {
    const update = updatePricesJsonSafely(diagnostics, file);
    diagnostics.prices_update = update;
    assert.strictEqual(update.updated, true, JSON.stringify(update));
    const prices = JSON.parse(fs.readFileSync(file, "utf8"));
    const item = prices[burgundy.jan];
    assert.deepStrictEqual(item.stores.map(s => s.store), ["買取ルデヤ"], "順位用の stores には入れない");
    assert.deepStrictEqual(item.reference_stores.map(r => [r.store, r.reference_price, "price" in r]), [["買取一丁目", 262000, false]], "範囲外の参考価格は保存しない");
    assert.strictEqual(item.fetch_summary.success, 1, "成功数に数えない");
    assert.deepStrictEqual(prices[targets[0].jan].reference_stores, []);
    assert.deepStrictEqual(verifyPrices({ prices, diagnostics, indexHtml, previousPrices: null }).errors, []);
    // 参考価格に price を持たせたら検証で止める
    item.reference_stores[0].price = 262000;
    assert.ok(verifyPrices({ prices, diagnostics, indexHtml, previousPrices: null }).errors.some(e => /参考価格に price を持たせない/.test(e)));
  } finally {
    if (saved !== undefined) process.env.TARGET_JAN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const KNOWN = { mobasute: { registered: "2026-11-11", cause: "HTTP 403", last_success: null } };

test("監視: 既知のアクセス制限は警告、稼働中店舗の取得0件は重大（ワークフロー成功だけで正常としない）", () => {
  const run = summarizeRun(sampleRun("2026-11-03T03:58:44.025Z"));
  assert.deepStrictEqual(zeroSuccessStores(run).map(z => z.id).sort(), ["iphonekaitori", "mobasute"]);
  const gate = evaluateGate(run, KNOWN);
  assert.deepStrictEqual(gate.known.map(z => z.id), ["mobasute"]);
  assert.deepStrictEqual(gate.critical.map(z => z.id), ["iphonekaitori"]);
  assert.strictEqual(gate.failed, true);
  const text = formatGate(gate);
  assert.match(text, /重大: 稼働中の店舗で価格0件（新規の取得障害）: 1店舗/);
  assert.match(text, /既知のアクセス制限で継続して取得できない店舗: 1店舗/, "既知障害も隠さず表示する");
  const notes = gateAnnotations(gate);
  assert.ok(notes.includes("::warning::モバステ: 価格0/40件（既知のアクセス制限: HTTP 403）"), notes.join("\n"));
  assert.ok(notes.some(n => n.startsWith("::error::iPhone買取価格表")));
});

test("監視: 既知の制限だけなら警告で成功、全店舗0件は既知でも重大、回復した既知店舗は通知する", () => {
  const knownAll = { ...KNOWN, iphonekaitori: KNOWN.mobasute, rudeya: KNOWN.mobasute };
  const onlyKnown = evaluateGate(summarizeRun(sampleRun("2026-11-03T03:58:44.025Z")), { ...KNOWN, iphonekaitori: KNOWN.mobasute });
  assert.strictEqual(onlyKnown.failed, false);
  assert.strictEqual(onlyKnown.known.length, 2);
  const allZero = evaluateGate(summarizeRun(sampleRun("2026-11-03T03:58:44.025Z", { rudeya: "blocked" })), knownAll);
  assert.strictEqual(allZero.allZero, true);
  assert.strictEqual(allZero.failed, true);
  assert.match(formatGate(allZero), /重大: 全店舗で価格を1件も取得できませんでした/);
  const recovered = evaluateGate(summarizeRun(sampleRun("2026-11-03T03:58:44.025Z")), knownAll);
  assert.deepStrictEqual(recovered.recovered.map(r => r.id), ["rudeya"]);
  assert.ok(gateAnnotations(recovered).some(n => n.startsWith("::notice::買取ルデヤ")));
});

test("監視: --gate の終了コード（新規障害=1、既知の制限だけ=0）。履歴は書かない", () => {
  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const run = (diagnostics, known) => {
    fs.writeFileSync(path.join(dir, "diag.json"), JSON.stringify(diagnostics));
    fs.writeFileSync(path.join(dir, "known.json"), JSON.stringify({ iphone: known }));
    const env = { ...process.env }; delete env.GITHUB_STEP_SUMMARY;
    return spawnSync(process.execPath, [path.join(__dirname, "../scripts/store_health.js"), "--diagnostics", path.join(dir, "diag.json"),
      "--health", path.join(dir, "none.json"), "--known", path.join(dir, "known.json"), "--gate"], { encoding: "utf8", env });
  };
  const bad = run(sampleRun("2026-11-03T03:58:44.025Z"), KNOWN);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /::error::iPhone買取価格表: 価格0\/40件（新規の取得障害/);
  assert.match(bad.stdout, /::warning::モバステ/);
  const knownOnly = run(sampleRun("2026-11-03T03:58:44.025Z"), { ...KNOWN, iphonekaitori: KNOWN.mobasute });
  assert.strictEqual(knownOnly.status, 0, knownOnly.stdout + knownOnly.stderr);
  assert.ok(!fs.existsSync(path.join(dir, "none.json")), "ゲートは履歴を書かない");
});

test("監視: 既知の制限の一覧は根拠のある店舗だけ（iPhone・カタログとも、現在稼働中の店舗を含めない）", () => {
  const known = require("../scripts/known_store_restrictions.json");
  assert.deepStrictEqual(Object.keys(known.iphone).sort(), ["iphonekaitori", "kaitorishouten", "kaitoriwiki", "mobasute", "morimori"]);
  assert.deepStrictEqual(Object.keys(known.catalog).sort(), ["kaitorishouten", "kaitoriwiki", "keitaispace", "morimori"]);
  for (const entry of [...Object.values(known.iphone), ...Object.values(known.catalog)]) {
    assert.ok(entry.registered && entry.cause && entry.evidence, JSON.stringify(entry));
  }
});

test("ルデヤ: JAN一致の価格はモデル・容量別の範囲で判定する（Duo 2TB 605,000円を弾かない）", () => {
  const body = "新品\niPhone Duo 2TB スターホワイト 未開封 SIMフリー\nJAN: 4549995732948\n買取価格\n605,000円";
  const duo2tb = priceRangeFor("iPhone Duo", "2TB");
  assert.deepStrictEqual([extractRudeyaPrice(body, "4549995732948", duo2tb).price, extractRudeyaPrice(body, "4549995732948", duo2tb).error], [605000, null]);
  // 定価の1.5倍超（桁の読み違い）は引き続き除外
  assert.strictEqual(extractRudeyaPrice(body.replace("605,000", "905,000"), "4549995732948", duo2tb).price, null);
  // iPhone 18 の上限（50万円）は従来どおり
  const pro = body.replace("Duo 2TB スターホワイト", "18 Pro Max 2TB ブラック").replace("605,000", "520,000");
  assert.strictEqual(extractRudeyaPrice(pro, "4549995732948", priceRangeFor("iPhone 18 Pro Max", "2TB")).error, "買取価格が安全範囲外です");
  // 範囲が分からないときは全店共通の範囲（60万円まで）
  assert.strictEqual(extractRudeyaPrice(body, "4549995732948").price, null);
});
