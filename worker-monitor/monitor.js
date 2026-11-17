/*
 * 価格鮮度の監視（第1段階: 監視のみ）
 *
 * 監視専用 Worker（worker-monitor/、iphone-tenbai-monitor）の Cron Trigger から1時間ごとに実行し、公開中のデータと
 * GitHub Actions の実行結果を読み取って、全件更新の漏れ・遅れ・価格データの劣化を判定する。
 *
 * - 価格の取得・ワークフローの起動・データの書き換えはしない（読み取りと Issue 通知のみ）。
 * - 「ワークフロー成功」だけで正常としない。全件実行・全件診断・価格の保存・有効価格・
 *   比較可能店舗数・店舗別成功率・Store coverage gate をそれぞれ確認する。
 * - 固定の最低基準と、過去14回の正常な全件実行の中央値を併用する。基準を満たさない回は
 *   中央値に加えない（取得率の低い現状を正常値として固定しない）。
 * - MONITOR_MODE が "issues" で GitHub App の認証情報がある場合だけ Issue を作成・更新・クローズする。
 *   それ以外は判定結果をログに出すだけ（dry-run）。
 *
 * Workers Free の制限（2026-11 時点の公式ドキュメント）:
 *   Cron Trigger 1回の CPU 10ms・サブリクエスト 50・Cron Trigger はアカウントで5個、
 *   KV は読み取り 100,000/日・異なるキーへの書き込み 1,000/日・同じキーへの書き込み 1回/秒。
 *   この監視は1回あたりサブリクエスト最大16、KV 書き込みは基準値・失敗回数が変わったときだけ（1日数回）。
 */

export const PAGES_BASE = "https://yappi7000.github.io/iPhone-Tenbai/";
export const GITHUB_API = "https://api.github.com";
export const OWNER = "yappi7000";
export const REPO = "iPhone-Tenbai";
export const FULL_WORKFLOW = "crawl.yml";
export const GATE_STEP = "Store coverage gate";
export const ISSUE_LABEL = "price-freshness";

export const STALE_HOURS = 36;
export const BASELINE_RUNS = 14;
export const MIN_BASELINE_RUNS = 3;
export const MONITOR_FAILURE_ALERT = 3;
// 全件実行の終了から公開データ（GitHub Pages）への反映を待つ時間（実績は1〜2分）
export const PUBLISH_GRACE_MS = 30 * 60000;

// 監視対象（scripts/price_rules.js の MODEL_RULES と同じ。enforce=false は警告まで）
export const MODELS = {
  "iPhone 18 Pro Max": { expected: 16, enforce: true },
  "iPhone 18 Pro": { expected: 16, enforce: true },
  "iPhone Duo": { expected: 8, enforce: false }
};

// 暫定の閾値（固定の最低基準）。中央値との比較は MIN_BASELINE_RUNS 回分の基準値がそろってから
export const THRESHOLDS = {
  fullRunAgeHours: { notice: 26, warning: 30, critical: 34 },
  oldestPriceAgeHours: { warning: 30, critical: 34 },
  validSkuMinRatio: 0.5,          // 全体の有効SKUがこれ未満なら重大（COVERAGE_RULES.minTotalRatio と同じ）
  validSkuModelMinRatio: 0.5,     // モデル別（enforce=false のモデルは注意まで）
  validSkuDrop: { notice: 0.15, warning: 0.25 },
  multiStoreMinRatio18: 0.5,      // iPhone 18 系で2店以上比較できるSKUの最低割合
  multiStoreDrop: { notice: 0.3, warning: 0.5 },
  storeRateDropPoints: { notice: 0.3, warning: 0.5 }
};

const LEVELS = ["ok", "notice", "warning", "critical"];
export const LEVEL_LABELS = { notice: "注意", warning: "警告", critical: "重大" };
const rank = level => LEVELS.indexOf(level);

export function parseTime(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const hours = ms => ms / 3600000;

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/*
 * 監視対象の SKU（data/product_master.json の model → storage → color → JAN）
 */
export function targetsFromMaster(master) {
  const targets = [];
  for (const model of Object.keys(MODELS)) {
    const byStorage = master && master[model];
    if (!byStorage || typeof byStorage !== "object") continue;
    for (const [storage, byColor] of Object.entries(byStorage)) {
      for (const [color, jan] of Object.entries(byColor || {})) {
        if (/^\d{13}$/.test(String(jan))) targets.push({ jan: String(jan), model, storage, color });
      }
    }
  }
  return targets;
}

/*
 * 画面で順位に使われる価格（index.html の splitRankableStores と同じ条件）
 */
function rankableRows(item, nowMs) {
  const stores = item && Array.isArray(item.stores) ? item.stores : [];
  return stores.filter(row => {
    const price = Number(row && row.price);
    const observed = parseTime(row && row.observed_at);
    return Number.isSafeInteger(price) && price > 0 && row.color_verified === true &&
      observed !== null && nowMs - observed <= STALE_HOURS * 3600000 && observed - nowMs <= 5 * 60000;
  });
}

/*
 * 公開データから指標を集計する。
 *   run: GitHub API の最新の全件実行（無ければ null）。{ id, status, conclusion, created_at, updated_at, gate }
 */
export function collectMetrics({ prices, diagnostics, master, known, run = null, now = Date.now() }) {
  const targets = targetsFromMaster(master);
  const expectedTotal = Object.values(MODELS).reduce((sum, m) => sum + m.expected, 0);
  const targetJans = new Set(targets.map(t => t.jan));

  // 全件診断: 対象40SKUすべてを含む診断だけ（1SKU更新の診断は使わない）
  const diagTargets = diagnostics && Array.isArray(diagnostics.targets) ? diagnostics.targets : [];
  const isFull = Boolean(
    diagnostics && diagnostics.target_count === expectedTotal && diagTargets.length === expectedTotal &&
    diagTargets.every(t => targetJans.has(String(t.jan)))
  );
  const fullDiag = isFull ? diagnostics : null;
  const fullFinishedMs = fullDiag ? parseTime(fullDiag.finished_at_iso) : null;

  // 価格の保存: 全件実行の保存処理は対象SKUの last_checked_at に finished_at_iso を書く。
  // その後の1SKU更新はそのSKUだけ後の時刻に進めるので、「finished_at_iso 以降」で照合する（完全一致は使わない）。
  const notSaved = [];
  const byModel = {};
  let valid = 0;
  let multi18 = 0;
  let total18 = 0;
  let oldestMs = null;
  let storeCountSum = 0;
  for (const t of targets) {
    const item = prices && prices[t.jan];
    const checked = parseTime(item && item.last_checked_at);
    if (fullFinishedMs !== null && (checked === null || checked < fullFinishedMs)) notSaved.push(t.jan);
    const rows = rankableRows(item, now);
    const m = byModel[t.model] || (byModel[t.model] = { total: 0, valid: 0, multi: 0 });
    m.total++;
    if (rows.length) { m.valid++; valid++; }
    if (rows.length >= 2) m.multi++;
    if (t.model !== "iPhone Duo") {
      total18++;
      if (rows.length >= 2) multi18++;
    }
    storeCountSum += rows.length;
    for (const row of rows) {
      const observed = parseTime(row.observed_at);
      if (oldestMs === null || observed < oldestMs) oldestMs = observed;
    }
  }

  // 店舗別成功率（全件診断の店舗行。store_health.js と同じく 成功/対象行）
  const storeRates = {};
  if (fullDiag && Array.isArray(fullDiag.stores)) {
    const agg = {};
    for (const row of fullDiag.stores) {
      if (!row || !targetJans.has(String(row.jan || ""))) continue;
      const id = String(row.store_id || row.store || "unknown");
      const a = agg[id] || (agg[id] = { store: row.store || id, total: 0, success: 0 });
      a.total++;
      if (row.outcome === "success" || (row.status === "OK" && row.color_verified === true && row.price !== null)) a.success++;
    }
    for (const [id, a] of Object.entries(agg)) storeRates[id] = { ...a, rate: a.total ? a.success / a.total : 0 };
  }

  return {
    now,
    expectedTotal,
    targetCount: targets.length,
    fullDiag: Boolean(fullDiag),
    diagTargetCount: diagnostics ? diagnostics.target_count ?? null : null,
    fullFinishedAt: fullDiag ? fullDiag.finished_at_iso : null,
    pricesUpdate: fullDiag ? fullDiag.prices_update || null : null,
    notSaved,
    valid,
    validRatio: targets.length ? valid / targets.length : 0,
    byModel,
    multi18,
    total18,
    avgStores: targets.length ? storeCountSum / targets.length : 0,
    oldestPriceAgeHours: oldestMs === null ? null : hours(now - oldestMs),
    storeRates,
    known: (known && known.iphone) || {},
    run
  };
}

function finding(key, level, title, details) {
  return { key, level, title, details };
}

/*
 * 指標と基準値（過去の正常な全件実行）から異常を判定する。
 */
export function evaluate(metrics, baseline = { runs: [] }) {
  const T = THRESHOLDS;
  const out = [];
  const now = metrics.now;

  // 全件実行の経過時間は「公開中の全件診断」の終了時刻で数える（GitHub API の成功だけでは数えない）。
  // 全件診断が無い場合だけ、GitHub API の最新の成功で代用する（そのときは full-diagnostics も警告する）。
  const run = metrics.run;
  const diagMs = parseTime(metrics.fullFinishedAt);
  const lastFullMs = diagMs !== null ? diagMs
    : (run && run.status === "completed" && run.conclusion === "success" ? parseTime(run.updated_at) : null);
  if (lastFullMs === null) {
    out.push(finding("full-run", "warning", "全件実行の完了を確認できません", ["GitHub API と全件診断のどちらからも、最新の全件実行の終了時刻を得られませんでした。"]));
  } else {
    const age = hours(now - lastFullMs);
    const level = age >= T.fullRunAgeHours.critical ? "critical" : age >= T.fullRunAgeHours.warning ? "warning" : age >= T.fullRunAgeHours.notice ? "notice" : "ok";
    if (level !== "ok") out.push(finding("full-run", level, `全件実行が${Math.floor(age)}時間行われていません`, [`最終の全件実行: ${new Date(lastFullMs).toISOString()}`, "GitHub Actions の定時実行の遅延・停止の可能性があります。"]));
  }
  // GitHub Actions の実行と公開データの対応: 全件診断の終了時刻は、その全件実行の開始〜終了の間に入る
  // （2026-10-25〜11-11 の全件実行18回すべてで成立）。最新の成功した全件実行より前なら、公開データが反映されていない。
  if (run && run.status === "completed" && run.conclusion === "success" && diagMs !== null) {
    const start = parseTime(run.started_at || run.created_at);
    const end = parseTime(run.updated_at);
    if (start !== null && end !== null && diagMs < start - 60000) {
      const sinceEnd = now - end;
      const level = sinceEnd < PUBLISH_GRACE_MS ? "notice" : "warning";
      out.push(finding("full-run-publish", level, "最新の全件実行の結果が公開データに反映されていません", [
        `全件実行 run ${run.id}: ${run.started_at || run.created_at} 〜 ${run.updated_at}`,
        `公開中の全件診断の終了時刻: ${metrics.fullFinishedAt}（この実行より前）`,
        "価格のコミット・GitHub Pages の公開を確認してください。"
      ]));
    } else if (start !== null && end !== null && diagMs > end + 60000) {
      out.push(finding("full-run-publish", "notice", "公開中の全件診断に対応する全件実行を確認できません", [
        `公開中の全件診断の終了時刻: ${metrics.fullFinishedAt} / 最新の成功した全件実行: ${run.updated_at}`
      ]));
    }
  }
  if (run && run.status === "completed" && run.conclusion !== "success") {
    out.push(finding("full-run-result", "warning", `最新の全件実行が ${run.conclusion} で終了しました`, [`run ${run.id}（${run.created_at}）。検証に失敗した場合、価格は保存されていません。`]));
  }
  if (run && run.gate === "failure") {
    out.push(finding("store-gate", "critical", "Store coverage gate が失敗しました（新規の取得障害・全店舗0件の可能性）", [`run ${run.id} の Store coverage gate を確認してください。`]));
  }

  // 全件診断・価格の保存・有効価格の更新
  if (!metrics.fullDiag) {
    out.push(finding("full-diagnostics", "warning", "全件診断が見つかりません", [`data/crawl_diagnostics.json の target_count=${metrics.diagTargetCount}（期待値 ${metrics.expectedTotal}）。1SKU更新で上書きされたか、全件実行が保存されていません。`]));
  } else {
    if (!metrics.pricesUpdate || metrics.pricesUpdate.updated !== true || !(metrics.pricesUpdate.fresh_price_count > 0)) {
      out.push(finding("prices-update", "critical", "全件実行で有効な価格を更新できていません", [`prices_update: ${JSON.stringify(metrics.pricesUpdate)}`]));
    }
    if (metrics.notSaved.length) {
      const level = metrics.notSaved.length >= metrics.targetCount ? "critical" : "warning";
      out.push(finding("prices-saved", level, `${metrics.notSaved.length}SKUの価格が全件実行の時点で保存されていません`, [`last_checked_at が全件実行（${metrics.fullFinishedAt}）より前: ${metrics.notSaved.slice(0, 10).join(", ")}`]));
    }
  }

  // 有効SKU数（固定の最低基準）
  if (metrics.validRatio < T.validSkuMinRatio) {
    out.push(finding("valid-skus", "critical", `有効価格のあるSKUが ${metrics.valid}/${metrics.targetCount} です`, [`最低基準 ${Math.round(T.validSkuMinRatio * 100)}% 未満。36時間以内の色別検証済み価格が無いSKUは画面で「価格未取得」になります。`]));
  }
  for (const [model, m] of Object.entries(metrics.byModel)) {
    if (m.total && m.valid / m.total < T.validSkuModelMinRatio) {
      const level = MODELS[model] && MODELS[model].enforce ? "warning" : "notice";
      out.push(finding(`valid-skus-model:${model}`, level, `${model} の有効価格SKUが ${m.valid}/${m.total} です`, [`モデル別の最低基準 ${Math.round(T.validSkuModelMinRatio * 100)}% 未満。`]));
    }
  }
  // 比較可能店舗数（固定の最低基準: iPhone 18 系）
  if (metrics.total18 && metrics.multi18 / metrics.total18 < T.multiStoreMinRatio18) {
    out.push(finding("comparable-stores", "warning", `iPhone 18 系で2店以上比較できるSKUが ${metrics.multi18}/${metrics.total18} です`, [`最低基準 ${Math.round(T.multiStoreMinRatio18 * 100)}% 未満。`]));
  }

  // 最古の有効価格（36時間で画面から消える）
  if (metrics.oldestPriceAgeHours !== null) {
    const age = metrics.oldestPriceAgeHours;
    const level = age >= T.oldestPriceAgeHours.critical ? "critical" : age >= T.oldestPriceAgeHours.warning ? "warning" : "ok";
    if (level !== "ok") out.push(finding("freshness", level, `表示中の価格が取得から${Math.floor(age)}時間経過しています`, [`${STALE_HOURS}時間を超えると順位から外れます（残り約${Math.max(0, Math.floor(STALE_HOURS - age))}時間）。`]));
  }

  // 店舗別成功率（既知のアクセス制限の店舗は除く）
  for (const [id, s] of Object.entries(metrics.storeRates)) {
    if (metrics.known[id]) continue;
    if (s.total > 0 && s.success === 0) {
      out.push(finding(`store-rate:${id}`, "critical", `${s.store} の取得が0件です（新規の取得障害）`, [`0/${s.total}`]));
    }
  }

  // 過去の正常な全件実行の中央値との比較
  const runs = (baseline && Array.isArray(baseline.runs)) ? baseline.runs : [];
  if (runs.length >= MIN_BASELINE_RUNS) {
    const mValid = median(runs.map(r => r.valid));
    if (mValid) {
      const drop = 1 - metrics.valid / mValid;
      const level = drop >= T.validSkuDrop.warning ? "warning" : drop >= T.validSkuDrop.notice ? "notice" : "ok";
      if (level !== "ok") out.push(finding("valid-skus-drop", level, `有効価格SKUが過去の中央値から${Math.round(drop * 100)}%減っています`, [`今回 ${metrics.valid} / 中央値 ${mValid}（過去${runs.length}回の正常な全件実行）`]));
    }
    const mMulti = median(runs.map(r => r.multi18));
    if (mMulti) {
      const drop = 1 - metrics.multi18 / mMulti;
      const level = drop >= T.multiStoreDrop.warning ? "warning" : drop >= T.multiStoreDrop.notice ? "notice" : "ok";
      if (level !== "ok") out.push(finding("comparable-stores-drop", level, `2店以上比較できるSKUが過去の中央値から${Math.round(drop * 100)}%減っています`, [`今回 ${metrics.multi18} / 中央値 ${mMulti}`]));
    }
    for (const [id, s] of Object.entries(metrics.storeRates)) {
      if (metrics.known[id] || s.success === 0) continue;
      const mRate = median(runs.map(r => r.storeRates && r.storeRates[id]).filter(v => v !== undefined));
      if (mRate === null) continue;
      const drop = mRate - s.rate;
      const level = drop >= T.storeRateDropPoints.warning ? "warning" : drop >= T.storeRateDropPoints.notice ? "notice" : "ok";
      if (level !== "ok") out.push(finding(`store-rate-drop:${id}`, level, `${s.store} の取得成功率が下がっています`, [`今回 ${Math.round(s.rate * 100)}% / 中央値 ${Math.round(mRate * 100)}%`]));
    }
  }

  return out;
}

/*
 * 基準値の更新。新しい全件実行で、固定の最低基準を満たす正常な回だけを加える
 * （取得率の低い回・保存されていない回は中央値に入れない）。変化が無ければ null。
 */
export function updateBaseline(baseline, metrics) {
  const runs = (baseline && Array.isArray(baseline.runs)) ? baseline.runs : [];
  if (!metrics.fullDiag || !metrics.fullFinishedAt) return null;
  if (runs.some(r => r.finished_at === metrics.fullFinishedAt)) return null;
  const healthy =
    metrics.pricesUpdate && metrics.pricesUpdate.updated === true &&
    metrics.notSaved.length === 0 &&
    metrics.validRatio >= THRESHOLDS.validSkuMinRatio &&
    metrics.total18 > 0 && metrics.multi18 / metrics.total18 >= THRESHOLDS.multiStoreMinRatio18;
  if (!healthy) return null;
  const storeRates = Object.fromEntries(Object.entries(metrics.storeRates).map(([id, s]) => [id, s.rate]));
  const next = [...runs, { finished_at: metrics.fullFinishedAt, valid: metrics.valid, multi18: metrics.multi18, storeRates }]
    .sort((a, b) => String(a.finished_at).localeCompare(String(b.finished_at)))
    .slice(-BASELINE_RUNS);
  return { runs: next };
}

/* ---------- GitHub Issue（重複防止） ---------- */

export const marker = key => `<!-- freshness-monitor:${key} -->`;
const levelMarker = (level, digest) => `<!-- freshness-level:${level} digest:${digest} -->`;

function digestOf(f) {
  // 本文の更新判定用（時刻は含めない。時間表示の変化だけで毎時更新しない）
  const text = f.level + "|" + f.title.replace(/\d+/g, "#") + "|" + f.details.join("|").replace(/\d+/g, "#");
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function issueTitle(f) {
  return `[価格鮮度・${LEVEL_LABELS[f.level]}] ${f.title}`;
}

export function issueBody(f, checkedAt) {
  return [
    marker(f.key),
    levelMarker(f.level, digestOf(f)),
    `**${LEVEL_LABELS[f.level]}**: ${f.title}`,
    "",
    ...f.details.map(d => `- ${d}`),
    "",
    `確認: ${checkedAt}（Cloudflare Worker の鮮度監視・自動）`,
    "価格の取得・ワークフローの起動・アクセス制限の回避は行いません。回復すると自動でクローズします。"
  ].join("\n");
}

function parseIssueState(body) {
  const m = String(body || "").match(/<!-- freshness-level:(\w+) digest:(\w+) -->/);
  return m ? { level: m[1], digest: m[2] } : { level: null, digest: null };
}

/*
 * Issue の作成・更新・クローズ計画。
 *   - 警告・重大だけ Issue にする（注意はログのみ）
 *   - 同じ種類（目印）の Issue は1件だけ。重複・無関係の Issue には触れない
 *   - 内容が変わったときだけ本文を更新し、段階が上がったときだけコメントする
 *   - 判定から消えた種類はクローズする
 */
export function planIssues(findings, openIssues, checkedAt) {
  const plan = [];
  const alerting = findings.filter(f => rank(f.level) >= rank("warning"));
  const byKey = new Map();
  for (const issue of [...openIssues].sort((a, b) => a.number - b.number)) {
    const m = String(issue.body || "").match(/<!-- freshness-monitor:([^ ]+) -->/);
    if (m && !byKey.has(m[1])) byKey.set(m[1], issue);
  }
  for (const f of alerting) {
    const existing = byKey.get(f.key);
    const body = issueBody(f, checkedAt);
    if (!existing) {
      plan.push({ action: "create", key: f.key, title: issueTitle(f), body, labels: [ISSUE_LABEL] });
      continue;
    }
    const prev = parseIssueState(existing.body);
    if (prev.digest !== digestOf(f)) {
      plan.push({ action: "update", key: f.key, number: existing.number, title: issueTitle(f), body });
    }
    if (prev.level && rank(f.level) > rank(prev.level)) {
      plan.push({ action: "comment", key: f.key, number: existing.number, body: `段階が「${LEVEL_LABELS[prev.level] || prev.level}」から「${LEVEL_LABELS[f.level]}」に上がりました。${f.title}` });
    }
  }
  const active = new Set(alerting.map(f => f.key));
  for (const [key, issue] of byKey) {
    if (!active.has(key)) plan.push({ action: "close", key, number: issue.number, comment: `回復を確認しました（${checkedAt}）。自動でクローズします。` });
  }
  return plan;
}

/* ---------- GitHub App 認証（Issue 用。秘密鍵は Worker のシークレット） ---------- */

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlText = text => b64url(new TextEncoder().encode(text));

function pemToPkcs8(pem) {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error("PKCS#1 形式の鍵です。PKCS#8 に変換して登録してください（openssl pkcs8 -topk8 -nocrypt）");
  }
  const b64 = String(pem).replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export async function appJwt(appId, privateKeyPem, nowSec = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // GitHub の推奨: 時計のずれを考慮して iat を60秒前、有効期限は10分以内
  const payload = b64urlText(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(signature)}`;
}

/*
 * インストールトークン（1時間で失効）。このリポジトリ・必要な権限だけに絞って発行する。
 */
export async function installationToken(env, fetchImpl = fetch) {
  const jwt = await appJwt(env.MONITOR_APP_ID, env.MONITOR_APP_PRIVATE_KEY);
  const res = await fetchImpl(`${GITHUB_API}/app/installations/${env.MONITOR_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { ...ghHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [REPO], permissions: { issues: "write", actions: "read", metadata: "read" } })
  });
  if (!res.ok) throw new Error(`GitHub App のトークン発行に失敗しました（HTTP ${res.status}）`);
  const data = await res.json();
  if (!data || typeof data.token !== "string") throw new Error("GitHub App のトークン応答が不正です");
  return data.token;
}

function ghHeaders(token) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "iPhone-Tenbai-freshness-monitor"
  };
}

export function hasAppCredentials(env) {
  return Boolean(env && env.MONITOR_APP_ID && env.MONITOR_APP_INSTALLATION_ID && env.MONITOR_APP_PRIVATE_KEY);
}

/* ---------- 実行 ---------- */

async function getJson(fetchImpl, url, init = {}, sizes = null) {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url.replace(/\?.*$/, "")}`);
  const text = await res.text();
  // Workers ではコード内で CPU 時間を測れない（時刻は I/O の後にしか進まない）ため、
  // 解析したデータ量を記録し、Workers Logs / Metrics の CPU 時間と突き合わせる
  if (sizes) sizes[url.replace(/\?.*$/, "").split("/").pop()] = text.length;
  return JSON.parse(text);
}

/*
 * 最新の全件実行（定時・手動の crawl.yml）と、その Store coverage gate の結果
 */
export async function latestFullRun(fetchImpl, token) {
  const base = `${GITHUB_API}/repos/${OWNER}/${REPO}/actions`;
  const runs = await getJson(fetchImpl, `${base}/workflows/${FULL_WORKFLOW}/runs?branch=main&per_page=10`, { headers: ghHeaders(token) });
  const full = (runs.workflow_runs || []).filter(r => r.event === "schedule" || r.event === "workflow_dispatch");
  // 判定には最新の「完了した」全件実行を使う（実行中の回は結果が出ていない）
  const run = full.find(r => r.status === "completed");
  if (!run) return null;
  let gate = null;
  if (run.status === "completed") {
    const jobs = await getJson(fetchImpl, `${base}/runs/${run.id}/jobs`, { headers: ghHeaders(token) });
    const step = (jobs.jobs || []).flatMap(j => j.steps || []).find(s => s.name === GATE_STEP);
    gate = step ? step.conclusion : null;
  }
  return { id: run.id, status: run.status, conclusion: run.conclusion, created_at: run.created_at,
    started_at: run.run_started_at || run.created_at, updated_at: run.updated_at, gate,
    in_progress: full.some(r => r.status !== "completed") };
}

async function kvGet(env, key) {
  if (!env.MONITOR_STATE) return null;
  try { return JSON.parse((await env.MONITOR_STATE.get(key)) || "null"); } catch { return null; }
}

async function kvPut(env, key, value) {
  if (env.MONITOR_STATE) await env.MONITOR_STATE.put(key, JSON.stringify(value));
}

/*
 * 1回分の監視。戻り値はログ・テスト用（秘密情報は含めない）。
 */
export async function runMonitor(env = {}, { fetchImpl = fetch, now = Date.now(), log = console.log } = {}) {
  const checkedAt = new Date(now).toISOString();
  const mode = env.MONITOR_MODE === "issues" && hasAppCredentials(env) ? "issues" : "dry-run";
  const result = { checkedAt, mode, findings: [], plan: [], baselineUpdated: false, errors: [] };
  let token = null;
  let failures = (await kvGet(env, "monitor_failures")) || 0;

  try {
    if (mode === "issues") token = await installationToken(env, fetchImpl);
    const bust = `?t=${now}`;
    const sizes = {};
    result.parsedBytes = sizes;
    const page = path => getJson(fetchImpl, PAGES_BASE + path + bust, { cf: { cacheTtl: 0 }, headers: { "Cache-Control": "no-cache" } }, sizes);
    const [prices, diagnostics, master, known] = await Promise.all([
      page("data/prices.json"), page("data/crawl_diagnostics.json"), page("data/product_master.json"), page("scripts/known_store_restrictions.json")
    ]);
    let run = null;
    try {
      run = await latestFullRun(fetchImpl, token);
    } catch (error) {
      result.errors.push(`GitHub API: ${error.message}`);
    }
    const metrics = collectMetrics({ prices, diagnostics, master, known, run, now });
    const baseline = (await kvGet(env, "baseline")) || { runs: [] };
    result.findings = evaluate(metrics, baseline);
    const nextBaseline = updateBaseline(baseline, metrics);
    if (nextBaseline) { await kvPut(env, "baseline", nextBaseline); result.baselineUpdated = true; }
    result.metrics = { valid: metrics.valid, targetCount: metrics.targetCount, multi18: metrics.multi18, total18: metrics.total18,
      oldestPriceAgeHours: metrics.oldestPriceAgeHours, fullFinishedAt: metrics.fullFinishedAt, notSaved: metrics.notSaved.length };
    if (failures !== 0) { failures = 0; await kvPut(env, "monitor_failures", 0); }
  } catch (error) {
    result.errors.push(error.message);
    failures = Math.min(failures + 1, 100);
    await kvPut(env, "monitor_failures", failures);
    if (failures >= MONITOR_FAILURE_ALERT) {
      result.findings.push(finding("monitor", "warning", `鮮度監視が${failures}回連続で失敗しています`, [error.message]));
    }
  }

  if (mode === "issues" && token) {
    try {
      const repoApi = `${GITHUB_API}/repos/${OWNER}/${REPO}`;
      const open = await getJson(fetchImpl, `${repoApi}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`, { headers: ghHeaders(token) });
      result.plan = planIssues(result.findings, Array.isArray(open) ? open : [], checkedAt);
      for (const p of result.plan) {
        const post = (url, method, body) => fetchImpl(url, { method, headers: { ...ghHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (p.action === "create") await post(`${repoApi}/issues`, "POST", { title: p.title, body: p.body, labels: p.labels });
        if (p.action === "update") await post(`${repoApi}/issues/${p.number}`, "PATCH", { title: p.title, body: p.body });
        if (p.action === "comment") await post(`${repoApi}/issues/${p.number}/comments`, "POST", { body: p.body });
        if (p.action === "close") {
          await post(`${repoApi}/issues/${p.number}/comments`, "POST", { body: p.comment });
          await post(`${repoApi}/issues/${p.number}`, "PATCH", { state: "closed" });
        }
      }
    } catch (error) {
      result.errors.push(`Issue: ${error.message}`);
    }
  } else {
    result.plan = planIssues(result.findings, [], checkedAt);
  }

  log(JSON.stringify({ monitor: "price-freshness", ...result, plan: result.plan.map(p => ({ action: p.action, key: p.key })) }));
  return result;
}
