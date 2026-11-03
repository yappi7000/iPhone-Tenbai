#!/usr/bin/env node
"use strict";

/*
 * 店舗別の取得状況レポートと、継続する異常の検知（GitHub Actions から実行）
 *
 *   node scripts/store_health.js \
 *     --diagnostics data/crawl_diagnostics.json \
 *     --health data/store_health.json \
 *     [--update]                      # 定時の全件実行のときだけ履歴を更新する
 *     [--issues-in open_issues.json]  # 既存の通知Issue（gh issue list --json の出力）
 *     [--plan-out issue_plan.json]    # 作成・更新・クローズする Issue の計画
 *     [--plan-only]                   # レポート出力・履歴更新をせず、計画だけを書く
 *
 * - 毎回: 店舗別・原因別の集計を Markdown で出力する（GITHUB_STEP_SUMMARY にも追記）。
 * - 定時実行: 店舗ごとに「価格0件が同じ原因で何回続いたか」を data/store_health.json に記録する。
 * - 同じ原因で ALERT_STREAK 回以上続いた店舗を「継続異常」として一覧にする。
 * - Issue は計画を出力するだけ。実際の作成はワークフロー側で明示的に有効化したときだけ行う。
 *
 * 価格は扱わない（価格の推測・補完はしない）。診断データの分類だけを集計する。
 */

const fs = require("fs");
const path = require("path");
const { classifyFetchOutcome, OUTCOME_LABELS } = require("../assets/fetch-outcome.js");
const { MODEL_RULES } = require("./price_rules");

// 同じ原因で価格0件がこの回数続いたら継続異常（定時実行は1日1回なので3日）
const ALERT_STREAK = 3;
const ISSUE_LABEL = "crawler-health";
const SCHEDULED_TARGET_COUNT = MODEL_RULES.reduce((sum, rule) => sum + rule.expectedSkus, 0);

function outcomeOf(row) {
  if (row.outcome) return row.outcome;
  const { outcome, ...rest } = row;
  return classifyFetchOutcome(rest);
}

/*
 * 失敗理由を短い文にする（URL・Playwright のログは除く）
 */
function reasonOf(row, outcome) {
  if (outcome === "stopped") return "同一実行内でアクセス停止";
  const first = (Array.isArray(row.errors) ? row.errors : [])
    .map(e => String(e).split("\n")[0].replace(/\s+at\s+https?:\/\/\S+/g, "").replace(/https?:\/\/\S+/g, "").trim())
    .find(e => e && !/^HTTP status \d+$/.test(e));
  const status = row.http && row.http.status;
  if (outcome === "blocked") return status ? `HTTP ${status}${first ? " / " + first : ""}` : (first || "遮断ページ");
  return (first || OUTCOME_LABELS[outcome] || outcome).slice(0, 80);
}

/*
 * 1回の実行の集計（対象SKUの行だけ）
 */
function summarizeRun(diagnostics) {
  const targets = Array.isArray(diagnostics && diagnostics.targets) ? diagnostics.targets : [];
  const targetJans = new Set(targets.map(t => String(t.jan)));
  const stores = {};
  const pricedStoresByJan = new Map(targets.map(t => [String(t.jan), 0]));

  for (const row of (diagnostics && Array.isArray(diagnostics.stores)) ? diagnostics.stores : []) {
    if (!row || !targetJans.has(String(row.jan || ""))) continue;
    const id = String(row.store_id || row.store || "unknown");
    const s = stores[id] || (stores[id] = { store: row.store || id, total: 0, by_outcome: {}, reasons: {} });
    const outcome = outcomeOf(row);
    s.total++;
    s.by_outcome[outcome] = (s.by_outcome[outcome] || 0) + 1;
    if (outcome === "success") {
      pricedStoresByJan.set(String(row.jan), pricedStoresByJan.get(String(row.jan)) + 1);
    } else {
      const reason = `${OUTCOME_LABELS[outcome] || outcome}: ${reasonOf(row, outcome)}`;
      s.reasons[reason] = (s.reasons[reason] || 0) + 1;
    }
  }

  for (const s of Object.values(stores)) {
    s.success = s.by_outcome.success || 0;
    s.top_reasons = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
    delete s.reasons;
  }

  const counts = [...pricedStoresByJan.values()];
  const nameByJan = new Map(targets.map(t => [String(t.jan), t.name]));
  return {
    run_at: (diagnostics && (diagnostics.finished_at_iso || diagnostics.started_at_iso)) || null,
    scheduled: targets.length === SCHEDULED_TARGET_COUNT,
    target_count: targets.length,
    stores,
    sku_coverage: {
      total: counts.length,
      zero: [...pricedStoresByJan].filter(([, n]) => n === 0).map(([jan]) => ({ jan, name: nameByJan.get(jan) })),
      one: [...pricedStoresByJan].filter(([, n]) => n === 1).map(([jan]) => ({ jan, name: nameByJan.get(jan) }))
    }
  };
}

/*
 * 価格0件の店舗の主な原因。アクセス停止はアクセス制限の結果なので blocked にまとめる。
 */
function dominantCause(storeSummary) {
  const counts = { ...storeSummary.by_outcome };
  delete counts.success;
  if (counts.stopped) {
    counts.blocked = (counts.blocked || 0) + counts.stopped;
    delete counts.stopped;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/*
 * 定時実行の結果で履歴を更新する（オンデマンドは件数が少ないので更新しない）
 */
function updateHealth(previous, run) {
  const prevStores = (previous && previous.stores) || {};
  const stores = {};
  const ids = new Set([...Object.keys(prevStores), ...Object.keys(run.stores)]);

  for (const id of ids) {
    const prev = prevStores[id] || {};
    const cur = run.stores[id];
    if (!cur) {
      // 今回の定時実行で巡回しなかった店舗（保留・廃止）は履歴を残すが、通知の対象から外す
      stores[id] = { ...prev, active: false };
      continue;
    }
    const failedAll = cur.total > 0 && cur.success === 0;
    const cause = failedAll ? dominantCause(cur) : null;
    stores[id] = {
      store: cur.store,
      last_run_at: run.run_at,
      success: cur.success,
      total: cur.total,
      cause,
      active: true,
      streak: failedAll ? (prev.cause === cause && prev.active !== false ? (prev.streak || 0) + 1 : 1) : 0,
      last_success_at: cur.success > 0 ? run.run_at : (prev.last_success_at || null),
      top_reasons: cur.top_reasons
    };
  }

  return { schema_version: 1, updated_at: run.run_at, alert_streak: ALERT_STREAK, stores };
}

function alertKey(id, cause) {
  return `${id}:${cause}`;
}

function listAlerts(health, threshold = ALERT_STREAK) {
  return Object.entries((health && health.stores) || {})
    .filter(([, s]) => s && s.active !== false && s.cause && (s.streak || 0) >= threshold)
    .map(([id, s]) => ({
      key: alertKey(id, s.cause),
      store_id: id,
      store: s.store,
      cause: s.cause,
      streak: s.streak,
      last_success_at: s.last_success_at,
      top_reasons: s.top_reasons || [],
      title: `[価格取得] ${s.store}: ${OUTCOME_LABELS[s.cause] || s.cause} が${threshold}回以上連続（価格0件）`
    }));
}

function issueBody(alert) {
  return [
    `<!-- ${ISSUE_LABEL}:${alert.key} -->`,
    `定時の価格取得で **${alert.store}** の価格を1件も取得できない状態が、同じ原因で **${alert.streak}回連続** しています。`,
    "",
    `- 主な原因: ${OUTCOME_LABELS[alert.cause] || alert.cause}`,
    `- 最後に価格を取得できた日時: ${alert.last_success_at || "記録なし"}`,
    ...alert.top_reasons.map(([reason, count]) => `- ${reason}（${count}件）`),
    "",
    "この店舗の価格はランキングに出ていません（古い価格・推測価格は表示しません）。",
    "アクセス制限（403・WAF・接続拒否）は回避せず、店舗側の状況が変わるまで保留してください。",
    "抽出失敗・掲載なしが続く場合は、店舗ページの構造変更の可能性があります。",
    "",
    "このIssueは自動で作成・更新され、店舗が回復するとクローズされます。"
  ].join("\n");
}

/*
 * 既存のIssue（gh issue list --label crawler-health --state open --json number,title,body）と
 * 今回の継続異常から、作成・更新・クローズの計画を作る。同じ店舗・原因のIssueは重複させない。
 */
function planIssues(alerts, openIssues) {
  const keyOf = issue => {
    const m = String(issue.body || "").match(new RegExp(`<!-- ${ISSUE_LABEL}:([^ ]+) -->`));
    return m ? m[1] : null;
  };
  const open = new Map();
  for (const issue of Array.isArray(openIssues) ? openIssues : []) {
    const key = keyOf(issue);
    if (key && !open.has(key)) open.set(key, issue);
  }
  const alertKeys = new Set(alerts.map(a => a.key));
  const plan = [];
  for (const alert of alerts) {
    const existing = open.get(alert.key);
    plan.push(existing
      ? { action: "update", number: existing.number, title: alert.title, body: issueBody(alert) }
      : { action: "create", title: alert.title, body: issueBody(alert), label: ISSUE_LABEL });
  }
  for (const [key, issue] of open) {
    if (!alertKeys.has(key)) {
      plan.push({ action: "close", number: issue.number, comment: "定時の価格取得で回復を確認しました（同じ原因の価格0件が続いていません）。自動でクローズします。" });
    }
  }
  return plan;
}

function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : "-";
}

function formatReport(run, health, alerts) {
  const lines = [];
  lines.push(`## 店舗別の取得状況（${run.scheduled ? "定時全件" : "オンデマンド"}・${run.target_count} SKU）`);
  lines.push("");
  lines.push("| 店舗 | 成功 | 掲載なし | 接続エラー | タイムアウト | アクセス制限 | 抽出失敗 | 停止 | 連続0件 | 主な理由 |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  const rows = Object.entries(run.stores).sort((a, b) => (a[1].success / a[1].total) - (b[1].success / b[1].total));
  for (const [id, s] of rows) {
    const o = s.by_outcome;
    const streak = health && health.stores && health.stores[id] ? health.stores[id].streak || 0 : 0;
    const flag = s.success === 0 ? " ❗" : "";
    const reason = s.top_reasons[0] ? `${s.top_reasons[0][0]}（${s.top_reasons[0][1]}件）` : "-";
    lines.push(`| ${s.store}${flag} | ${s.success}/${s.total}（${pct(s.success, s.total)}） | ${o.no_price || 0} | ${o.connection_error || 0} | ${o.timeout || 0} | ${o.blocked || 0} | ${o.extraction_failed || 0} | ${o.stopped || 0} | ${run.scheduled ? streak : "-"} | ${reason.replace(/\|/g, "／")} |`);
  }
  const cov = run.sku_coverage;
  lines.push("");
  lines.push(`- 価格0店舗のSKU: **${cov.zero.length}/${cov.total}**　価格1店舗だけのSKU: **${cov.one.length}/${cov.total}**`);
  if (cov.zero.length) lines.push(`  - 価格0店舗: ${cov.zero.map(t => `${t.name}（${t.jan}）`).join("、")}`);
  lines.push("");
  if (alerts.length) {
    lines.push(`### ⚠️ 継続異常（同じ原因で価格0件が${ALERT_STREAK}回以上連続）: ${alerts.length}店舗`);
    for (const a of alerts) lines.push(`- ${a.store}: ${OUTCOME_LABELS[a.cause] || a.cause}・${a.streak}回連続（最終成功: ${a.last_success_at || "記録なし"}）`);
  } else {
    lines.push(`### ✅ 継続異常なし（同じ原因で${ALERT_STREAK}回以上続く価格0件の店舗はありません）`);
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`不明な引数: ${key}`);
    const name = key.slice(2);
    if (name === "update") args.update = true;
    else if (name === "plan-only") args.planOnly = true;
    else args[name] = argv[++i];
  }
  return args;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function main() {
  const root = path.resolve(__dirname, "..");
  const args = parseArgs(process.argv.slice(2));
  const diagnosticsPath = path.resolve(root, args.diagnostics || "data/crawl_diagnostics.json");
  const healthPath = path.resolve(root, args.health || "data/store_health.json");

  const diagnostics = readJson(diagnosticsPath, null);
  if (!diagnostics) {
    console.error(`診断データを読めません: ${diagnosticsPath}`);
    process.exit(1);
  }

  const previous = readJson(healthPath, { stores: {} });

  if (args.planOnly) {
    const openIssues = args["issues-in"] ? readJson(path.resolve(args["issues-in"]), []) : [];
    const plan = planIssues(listAlerts(previous), openIssues);
    if (args["plan-out"]) fs.writeFileSync(path.resolve(args["plan-out"]), JSON.stringify(plan, null, 2) + "\n");
    console.log(`Issue計画: 作成${plan.filter(p => p.action === "create").length}・更新${plan.filter(p => p.action === "update").length}・クローズ${plan.filter(p => p.action === "close").length}`);
    return;
  }

  const run = summarizeRun(diagnostics);
  // 履歴の更新は定時の全件実行だけ（オンデマンドの1SKUで連続回数を進めない）
  const health = args.update && run.scheduled ? updateHealth(previous, run) : previous;
  const alerts = listAlerts(health);

  if (args.update && run.scheduled) {
    fs.writeFileSync(healthPath, JSON.stringify(health, null, 2) + "\n");
  }

  const text = formatReport(run, health, alerts);
  console.log(text);
  for (const a of alerts) console.log(`::warning::${a.title}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");

  if (args["plan-out"]) {
    const openIssues = args["issues-in"] ? readJson(path.resolve(args["issues-in"]), []) : [];
    fs.writeFileSync(path.resolve(args["plan-out"]), JSON.stringify(planIssues(alerts, openIssues), null, 2) + "\n");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ALERT_STREAK,
  ISSUE_LABEL,
  summarizeRun,
  dominantCause,
  updateHealth,
  listAlerts,
  planIssues,
  issueBody,
  formatReport
};
