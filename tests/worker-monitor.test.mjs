/*
 * 価格鮮度の監視（worker/monitor.js）と、既存 Worker（worker/index.js の fetch）の回帰テスト
 *
 *   node --test tests/worker-monitor.test.mjs
 *
 * ネットワークは使わない（fetch はすべて偽の関数）。実データは 2026-11-11 の全件実行直後の公開データ。
 */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectMetrics, evaluate, updateBaseline, planIssues, marker, targetsFromMaster, runMonitor,
  appJwt, installationToken, THRESHOLDS, MIN_BASELINE_RUNS
} from "../worker/monitor.js";
import worker from "../worker/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const MASTER = readJson("data/product_master.json");
const KNOWN = readJson("scripts/known_store_restrictions.json");
const REAL_PRICES = readJson("tests/fixtures/monitor/prices_2026-11-11.json");
const REAL_DIAG = readJson("tests/fixtures/monitor/crawl_diagnostics_2026-11-11.json");
const TARGETS = targetsFromMaster(MASTER);
const H = 3600000;
const FINISHED = "2026-11-12T02:40:00.000Z";
const FINISHED_MS = Date.parse(FINISHED);

/*
 * 合成データ: 全件実行（FINISHED）直後の公開データ。opts で異常を作る。
 */
function makeData({ validSkus = 40, multiPerSku = 2, observedHoursAgo = 0, now = FINISHED_MS + H, notSaved = 0, laterChecked = 0,
  diagTargetCount = 40, updated = true, storeSuccess = {} } = {}) {
  const observed = new Date(now - observedHoursAgo * H).toISOString();
  const prices = {};
  TARGETS.forEach((t, i) => {
    const stores = i < validSkus
      ? Array.from({ length: multiPerSku }, (_, k) => ({ store: `S${k}`, price: 200000 + k, color_verified: true, observed_at: observed }))
      : [];
    const checked = i < notSaved ? new Date(FINISHED_MS - 30 * H).toISOString()
      : i < notSaved + laterChecked ? new Date(FINISHED_MS + 2 * H).toISOString() : FINISHED;
    prices[t.jan] = { stores, last_checked_at: checked };
  });
  const storeRows = [];
  for (const [id, success] of Object.entries({ rudeya: 40, ichome: 20, mobasute: 0, ...storeSuccess })) {
    TARGETS.forEach((t, i) => storeRows.push({ store_id: id, store: id, jan: t.jan, outcome: i < success ? "success" : "extraction_failed" }));
  }
  const diagnostics = {
    target_count: diagTargetCount,
    targets: diagTargetCount === 40 ? TARGETS : TARGETS.slice(0, 1),
    finished_at_iso: FINISHED,
    prices_update: { updated, fresh_price_count: updated ? 80 : 0 },
    stores: storeRows
  };
  return { prices, diagnostics, master: MASTER, known: { iphone: { mobasute: { cause: "HTTP 403" } } }, now };
}

const keys = findings => findings.map(f => `${f.level}:${f.key}`).sort();
const metricsOf = (opts, run = null) => collectMetrics({ ...makeData(opts), run });

/* ---------- 実データ ---------- */

test("実データ: 11/11 の全件実行の1時間後は異常なし（38/40 SKU・2店以上 21/32）", () => {
  const now = Date.parse(REAL_DIAG.finished_at_iso) + H;
  const m = collectMetrics({ prices: REAL_PRICES, diagnostics: REAL_DIAG, master: MASTER, known: KNOWN, now });
  assert.deepStrictEqual([m.targetCount, m.valid, m.multi18, m.total18, m.notSaved.length, m.fullDiag], [40, 38, 21, 32, 0, true]);
  assert.deepStrictEqual(evaluate(m), []);
  // 既知のアクセス制限の店舗（0件）は新規障害にしない
  assert.strictEqual(m.storeRates.mobasute.success, 0);
});

test("実データ: 価格は消えないが、32時間後は鮮度・全件実行の警告、35時間後は重大", () => {
  const at = h => evaluate(collectMetrics({ prices: REAL_PRICES, diagnostics: REAL_DIAG, master: MASTER, known: KNOWN, now: Date.parse(REAL_DIAG.finished_at_iso) + h * H }));
  assert.deepStrictEqual(keys(at(27)), ["notice:full-run"]);
  assert.deepStrictEqual(keys(at(32)), ["warning:freshness", "warning:full-run"]);
  assert.deepStrictEqual(keys(at(35)), ["critical:freshness", "critical:full-run"]);
});

test("CPU 時間: 実データ4ファイルの解析と判定が Workers Free の 10ms に収まる（ローカル実測・目安）", () => {
  const texts = ["tests/fixtures/monitor/prices_2026-11-11.json", "tests/fixtures/monitor/crawl_diagnostics_2026-11-11.json",
    "data/product_master.json", "scripts/known_store_restrictions.json"].map(p => fs.readFileSync(path.join(ROOT, p), "utf8"));
  const once = () => {
    const [prices, diagnostics, master, known] = texts.map(t => JSON.parse(t));
    const m = collectMetrics({ prices, diagnostics, master, known, now: Date.parse(diagnostics.finished_at_iso) + H });
    return planIssues(evaluate(m), [], "x");
  };
  for (let i = 0; i < 5; i++) once();
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const start = process.cpuUsage();
    once();
    const d = process.cpuUsage(start);
    samples.push((d.user + d.system) / 1000);
  }
  samples.sort((a, b) => a - b);
  const medianMs = samples[15];
  console.log(`monitor CPU median ${medianMs.toFixed(2)}ms / p90 ${samples[27].toFixed(2)}ms（Workers 上の値は導入時に Workers Logs の cpuTime で確認）`);
  assert.ok(medianMs < 10, `中央値 ${medianMs}ms`);
});

/* ---------- 「ワークフロー成功」だけで正常としない ---------- */

test("全件実行は成功でも、価格が保存されていなければ警告（全SKUなら重大）", () => {
  const run = { id: 1, status: "completed", conclusion: "success", created_at: FINISHED, updated_at: FINISHED, gate: "success" };
  assert.deepStrictEqual(keys(evaluate(metricsOf({ notSaved: 3 }, run))), ["warning:prices-saved"]);
  assert.ok(keys(evaluate(metricsOf({ notSaved: 40 }, run))).includes("critical:prices-saved"));
});

test("1SKU更新で last_checked_at が後に進んだSKUは保存済みとして扱う（完全一致を前提にしない）", () => {
  const m = metricsOf({ laterChecked: 5 });
  assert.strictEqual(m.notSaved.length, 0);
  assert.deepStrictEqual(evaluate(m), []);
});

test("全件診断が1SKU診断で上書きされている・有効価格の更新なし・ワークフロー失敗・Store coverage gate 失敗を検知する", () => {
  // 全件診断が無く、GitHub API の実行情報も無ければ、全件実行の完了も確認できない
  assert.deepStrictEqual(keys(evaluate(metricsOf({ diagTargetCount: 1 }))), ["warning:full-diagnostics", "warning:full-run"]);
  const okRun = { id: 4, status: "completed", conclusion: "success", created_at: FINISHED, updated_at: FINISHED, gate: "success" };
  assert.deepStrictEqual(keys(evaluate(metricsOf({ diagTargetCount: 1 }, okRun))), ["warning:full-diagnostics"]);
  assert.deepStrictEqual(keys(evaluate(metricsOf({ updated: false }))), ["critical:prices-update"]);
  const failed = { id: 2, status: "completed", conclusion: "failure", created_at: FINISHED, updated_at: FINISHED, gate: "failure" };
  assert.deepStrictEqual(keys(evaluate(metricsOf({}, failed))), ["critical:store-gate", "warning:full-run-result"]);
});

test("全件実行の遅れ: 26時間で注意・30時間で警告・34時間で重大（GitHub API の最終成功を優先）", () => {
  const lastSuccess = h => ({ id: 3, status: "completed", conclusion: "success", created_at: FINISHED, updated_at: new Date(FINISHED_MS + H - h * H).toISOString(), gate: "success" });
  assert.deepStrictEqual(keys(evaluate(metricsOf({}, lastSuccess(27)))), ["notice:full-run"]);
  assert.deepStrictEqual(keys(evaluate(metricsOf({}, lastSuccess(31)))), ["warning:full-run"]);
  assert.deepStrictEqual(keys(evaluate(metricsOf({}, lastSuccess(35)))), ["critical:full-run"]);
});

/* ---------- 有効SKU数・比較可能店舗数・成功率 ---------- */

test("有効SKU数: 固定の最低基準（50%未満は重大）とモデル別（Duo は注意まで）", () => {
  const f = keys(evaluate(metricsOf({ validSkus: 18 })));
  assert.ok(f.includes("critical:valid-skus"), f);
  // 対象は Pro Max 16 → Pro 16 → Duo 8 の順。32件だけ有効なら Duo が0件
  assert.deepStrictEqual(keys(evaluate(metricsOf({ validSkus: 32 }))), ["notice:valid-skus-model:iPhone Duo"]);
});

test("比較可能店舗数: iPhone 18 系で2店以上のSKUが50%未満なら警告", () => {
  assert.deepStrictEqual(keys(evaluate(metricsOf({ multiPerSku: 1 }))), ["warning:comparable-stores"]);
});

test("稼働中の店舗の0件は重大、既知のアクセス制限の店舗は除外", () => {
  assert.deepStrictEqual(keys(evaluate(metricsOf({ storeSuccess: { ichome: 0 } }))), ["critical:store-rate:ichome"]);
  assert.deepStrictEqual(keys(evaluate(metricsOf({ storeSuccess: { mobasute: 0 } }))), []);
});

test("中央値との比較: 有効SKU・比較可能・店舗別成功率の低下を検知する（基準値が3回分そろってから）", () => {
  const healthy = { finished_at: "x", valid: 40, multi18: 32, storeRates: { rudeya: 1, ichome: 0.8 } };
  const baseline = { runs: [1, 2, 3].map(i => ({ ...healthy, finished_at: `2026-11-0${i}` })) };
  const m = metricsOf({ validSkus: 29, storeSuccess: { ichome: 8 } });
  const f = keys(evaluate(m, baseline));
  assert.ok(f.includes("warning:valid-skus-drop"), f);        // 40 → 29（-27.5%）
  assert.ok(f.includes("warning:store-rate-drop:ichome"), f); // 80% → 20%
  // 基準値が足りない間は中央値の判定をしない（固定の最低基準だけ）
  assert.ok(!keys(evaluate(m, { runs: baseline.runs.slice(0, MIN_BASELINE_RUNS - 1) })).some(k => k.includes("-drop")));
});

test("基準値: 正常な全件実行だけを加え、取得率の低い回・未保存の回・重複は加えない（最大14回）", () => {
  const first = updateBaseline({ runs: [] }, metricsOf({}));
  assert.strictEqual(first.runs.length, 1);
  assert.strictEqual(updateBaseline(first, metricsOf({})), null, "同じ全件実行は二重に加えない");
  assert.strictEqual(updateBaseline({ runs: [] }, metricsOf({ validSkus: 10 })), null, "最低基準を満たさない回は正常値にしない");
  assert.strictEqual(updateBaseline({ runs: [] }, metricsOf({ multiPerSku: 1 })), null);
  assert.strictEqual(updateBaseline({ runs: [] }, metricsOf({ notSaved: 1 })), null);
  assert.strictEqual(updateBaseline({ runs: [] }, metricsOf({ updated: false })), null);
  assert.strictEqual(updateBaseline({ runs: [] }, metricsOf({ diagTargetCount: 1 })), null);
  const many = { runs: Array.from({ length: 14 }, (_, i) => ({ finished_at: `2026-10-${String(i + 10).padStart(2, "0")}`, valid: 40, multi18: 32, storeRates: {} })) };
  assert.strictEqual(updateBaseline(many, metricsOf({})).runs.length, 14);
  assert.ok(THRESHOLDS.validSkuMinRatio === 0.5);
});

/* ---------- Issue の重複防止 ---------- */

test("Issue: 警告・重大だけ作成、同じ種類は1件、内容が変わったときだけ更新、段階が上がったときだけコメント、回復でクローズ", () => {
  const warn = { key: "freshness", level: "warning", title: "表示中の価格が取得から31時間経過しています", details: ["残り約5時間"] };
  const notice = { key: "full-run", level: "notice", title: "全件実行が27時間行われていません", details: [] };
  const created = planIssues([warn, notice], [], "t1");
  assert.deepStrictEqual(created.map(p => [p.action, p.key]), [["create", "freshness"]], "注意は Issue にしない");
  const issue = { number: 5, body: created[0].body };
  // 時間の数字だけが変わっても更新しない（毎時の更新・通知をしない）
  assert.deepStrictEqual(planIssues([{ ...warn, title: "表示中の価格が取得から32時間経過しています", details: ["残り約4時間"] }], [issue], "t2"), []);
  // 重大に上がったら本文の更新と1回のコメント
  const up = planIssues([{ ...warn, level: "critical" }], [issue], "t3");
  assert.deepStrictEqual(up.map(p => p.action), ["update", "comment"]);
  // 重複・無関係の Issue には触れない。回復した種類はクローズ
  const dup = { number: 9, body: issue.body };
  const other = { number: 7, body: "手動の Issue" };
  assert.deepStrictEqual(planIssues([], [dup, issue, other], "t4").map(p => [p.action, p.number]), [["close", 5]]);
  assert.match(issue.body, new RegExp(marker("freshness")));
});

/* ---------- GitHub App 認証 ---------- */

test("GitHub App: RS256 の JWT（iat は60秒前・有効10分以内）と、リポジトリ・権限を絞ったインストールトークン", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----`;
  const jwt = await appJwt("123", pem, 1_800_000_000);
  const [h, p, s] = jwt.split(".");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepStrictEqual(payload, { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "123" });
  assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`)));
  await assert.rejects(appJwt("1", "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----"), /PKCS#8/);

  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ token: "ghs_test" }), { status: 201 }); };
  const token = await installationToken({ MONITOR_APP_ID: "123", MONITOR_APP_INSTALLATION_ID: "77", MONITOR_APP_PRIVATE_KEY: pem }, fakeFetch);
  assert.strictEqual(token, "ghs_test");
  assert.strictEqual(calls[0].url, "https://api.github.com/app/installations/77/access_tokens");
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { repositories: ["iPhone-Tenbai"], permissions: { issues: "write", actions: "read", metadata: "read" } });
});

/* ---------- 実行（偽の fetch） ---------- */

function fakeEnvironment({ data = makeData(), pagesStatus = 200, issues = [], run = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.startsWith("https://yappi7000.github.io/")) {
      if (pagesStatus !== 200) return json({}, pagesStatus);
      if (u.includes("data/prices.json")) return json(data.prices);
      if (u.includes("data/crawl_diagnostics.json")) return json(data.diagnostics);
      if (u.includes("data/product_master.json")) return json(data.master);
      if (u.includes("known_store_restrictions.json")) return json(data.known);
    }
    if (u.includes("/actions/workflows/crawl.yml/runs")) return json({ workflow_runs: run ? [{ id: 11, event: "schedule", status: "completed", conclusion: "success", created_at: FINISHED, updated_at: FINISHED, ...run }] : [] });
    if (u.includes("/actions/runs/11/jobs")) return json({ jobs: [{ steps: [{ name: "Store coverage gate", conclusion: run && run.gate || "success" }] }] });
    if (u.includes("/access_tokens")) return json({ token: "ghs_test" }, 201);
    if (u.includes("/issues?state=open")) return json(issues);
    if (u.includes("/issues")) return json({}, 201);
    return json({}, 404);
  };
  return { fetchImpl, calls };
}

function memoryKv() {
  const store = new Map();
  let writes = 0;
  return { get: async k => store.get(k) ?? null, put: async (k, v) => { writes++; store.set(k, v); }, writes: () => writes, store };
}

test("実行（dry-run 既定）: 判定とログだけで、Issue・ワークフロー・データへの書き込みを一切しない", async () => {
  const data = makeData({ observedHoursAgo: 31, now: FINISHED_MS + 31 * H });
  const { fetchImpl, calls } = fakeEnvironment({ data, run: {} });
  const logs = [];
  const result = await runMonitor({}, { fetchImpl, now: data.now, log: l => logs.push(l) });
  assert.strictEqual(result.mode, "dry-run");
  assert.deepStrictEqual(keys(result.findings), ["warning:freshness", "warning:full-run"]);
  assert.deepStrictEqual(result.plan.map(p => p.action), ["create", "create"], "通知の予定はログに出す");
  assert.ok(calls.every(c => c.method === "GET"), "GET 以外の通信をしない");
  assert.ok(!calls.some(c => /dispatches|access_tokens/.test(c.url)), "ワークフローの起動・トークン発行をしない");
  assert.strictEqual(calls.length, 6, "公開データ4 + 実行一覧 + ジョブ（サブリクエスト上限 50 に対して十分少ない）");
  assert.ok(!logs.join("").includes("ghs_"), "トークンをログに出さない");
});

test("実行（issues モード）: GitHub App の認証情報がある場合だけ Issue を作成し、無ければ dry-run のまま", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64")}\n-----END PRIVATE KEY-----`;
  const data = makeData({ updated: false });
  const a = fakeEnvironment({ data, run: {} });
  const noCreds = await runMonitor({ MONITOR_MODE: "issues" }, { fetchImpl: a.fetchImpl, now: data.now, log: () => {} });
  assert.strictEqual(noCreds.mode, "dry-run");
  assert.ok(a.calls.every(c => c.method === "GET"));
  const b = fakeEnvironment({ data, run: {} });
  const withCreds = await runMonitor({ MONITOR_MODE: "issues", MONITOR_APP_ID: "1", MONITOR_APP_INSTALLATION_ID: "2", MONITOR_APP_PRIVATE_KEY: pem },
    { fetchImpl: b.fetchImpl, now: data.now, log: () => {} });
  assert.strictEqual(withCreds.mode, "issues");
  const writes = b.calls.filter(c => c.method !== "GET").map(c => `${c.method} ${c.url.replace(/^https:\/\/api\.github\.com/, "")}`);
  assert.deepStrictEqual(writes, ["POST /app/installations/2/access_tokens", "POST /repos/yappi7000/iPhone-Tenbai/issues"]);
  assert.ok(!b.calls.some(c => /dispatches|\/git\/|contents/.test(c.url)), "ワークフロー起動・コードの書き換えはしない");
});

test("実行: 公開データを読めない回が3回続いたら監視の失敗を警告し、成功したら失敗回数を戻す（KV 書き込みは変化時だけ）", async () => {
  const kv = memoryKv();
  const bad = fakeEnvironment({ pagesStatus: 503 });
  for (let i = 1; i <= 3; i++) {
    const r = await runMonitor({ MONITOR_STATE: kv }, { fetchImpl: bad.fetchImpl, now: FINISHED_MS + H, log: () => {} });
    assert.strictEqual(keys(r.findings).includes("warning:monitor"), i === 3, `回数 ${i}`);
  }
  const good = fakeEnvironment({ run: {} });
  const ok = await runMonitor({ MONITOR_STATE: kv }, { fetchImpl: good.fetchImpl, now: FINISHED_MS + H, log: () => {} });
  assert.deepStrictEqual(ok.findings, []);
  assert.strictEqual(kv.store.get("monitor_failures"), "0");
  assert.ok(ok.baselineUpdated, "正常な全件実行を基準値に加える");
  const before = kv.writes();
  await runMonitor({ MONITOR_STATE: kv }, { fetchImpl: good.fetchImpl, now: FINISHED_MS + 2 * H, log: () => {} });
  assert.strictEqual(kv.writes(), before, "同じ全件実行・失敗なしなら KV に書かない（1日の書き込み上限 1,000 に対して数回）");
});

test("実行: GitHub API が使えなくても、公開データだけで判定を続ける", async () => {
  const { fetchImpl } = fakeEnvironment();
  const failingApi = async (url, init) => (String(url).includes("api.github.com") ? new Response("{}", { status: 403 }) : fetchImpl(url, init));
  const r = await runMonitor({}, { fetchImpl: failingApi, now: FINISHED_MS + H, log: () => {} });
  assert.deepStrictEqual(r.findings, []);
  assert.match(r.errors[0], /GitHub API: HTTP 403/);
});

/* ---------- 既存 Worker（fetch）の回帰 ---------- */

async function callFetch(request, env = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).includes("/actions/runs?")) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    if (String(url).includes("turnstile")) return new Response(JSON.stringify({ success: true, action: "price_refresh", hostname: "yappi7000.github.io" }), { status: 200 });
    if (String(url).includes("/dispatches")) return new Response(null, { status: 204 });
    return new Response("{}", { status: 404 });
  };
  try {
    const res = await worker.fetch(request, env);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers, calls };
  } finally {
    globalThis.fetch = original;
  }
}

test("既存 Worker の fetch は変わらない: CORS・Origin 制限・Turnstile 必須・JAN の許可リスト・今すぐ更新の起動先", async () => {
  const origin = "https://yappi7000.github.io";
  const env = { GITHUB_TOKEN: "t", TURNSTILE_SECRET: "s" };
  assert.strictEqual((await callFetch(new Request("https://w/", { method: "OPTIONS", headers: { Origin: origin } }), env)).status, 204);
  assert.strictEqual((await callFetch(new Request("https://w/", { method: "GET", headers: { Origin: "https://evil.example" } }), env)).status, 403);
  const busy = await callFetch(new Request("https://w/", { method: "GET", headers: { Origin: origin } }), env);
  assert.deepStrictEqual([busy.status, busy.body.busy], [200, false]);
  assert.strictEqual(busy.headers.get("Access-Control-Allow-Origin"), origin);
  const post = body => new Request("https://w/", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.strictEqual((await callFetch(post({ jan: "4549995734546" }), env)).status, 403, "Turnstile 必須");
  assert.strictEqual((await callFetch(post({ jan: "1234567890123", turnstileToken: "x" }), env)).status, 400, "許可リスト外の JAN");
  const ok = await callFetch(post({ jan: "4549995734546", turnstileToken: "x" }), env);
  assert.strictEqual(ok.status, 202);
  assert.ok(ok.calls.some(c => c.method === "POST" && c.url.endsWith("/actions/workflows/on-demand-price.yml/dispatches")));
  assert.ok(!ok.calls.some(c => /crawl\.yml\/dispatches/.test(c.url)), "今すぐ更新から全件実行は起動しない");
});

test("既存 Worker: scheduled は監視だけを実行し、fetch 用の秘密情報（GITHUB_TOKEN・TURNSTILE_SECRET）を使わない", async () => {
  assert.strictEqual(typeof worker.scheduled, "function");
  const source = fs.readFileSync(path.join(ROOT, "worker/monitor.js"), "utf8");
  assert.ok(!/GITHUB_TOKEN|TURNSTILE_SECRET/.test(source.replace(/\/\*[\s\S]*?\*\//g, "")), "監視のコードは既存の秘密情報を参照しない");
  const waits = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeEnvironment().fetchImpl;
  const originalLog = console.log;
  console.log = () => {};
  try {
    await worker.scheduled({}, {}, { waitUntil: p => waits.push(p) });
    const result = await waits[0];
    assert.strictEqual(result.mode, "dry-run");
  } finally {
    globalThis.fetch = original;
    console.log = originalLog;
  }
});
