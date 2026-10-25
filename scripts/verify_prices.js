#!/usr/bin/env node
"use strict";

/*
 * prices.json の検証（GitHub Actions の Verify ステップから実行）
 *
 * 旧検証は「価格0件のSKUが1つでもあれば失敗」だったが、
 * crawler.js は「取れなかったSKUは古い価格を出さず空にする」設計のため、
 * 1店舗が落ちるだけで全体が止まっていた（#56 で推測される状況）。
 *
 * この検証は次の考え方で判定する。
 *   失敗にするもの
 *     - 対象SKUの抽出異常（数・重複・チェックディジット）
 *     - 今回の実行で確認されていないSKUがある（取得日時の偽装・取り残し）
 *     - 不正な価格行（店舗名重複、モデル別範囲外、今回取得でない日時、色未検証）
 *     - 状態と日時の矛盾（価格0件なのに取得成功日時が進んでいる等）
 *     - 取得率が過去実績に基づく閾値を下回る（全体・モデル別）
 *     - 対象外SKU（iPhone 17など）が書き換わった、またはSKUが減った
 *   警告に留めるもの
 *     - 価格0件のSKU（画面で「価格未取得」と表示される）
 *     - 容量別で0件、前回成功時からの大幅減、店舗単位の全滅
 *
 * 使い方
 *   node scripts/verify_prices.js \
 *     --prices data/prices.json \
 *     --diagnostics data/crawl_diagnostics.json \
 *     --index index.html \
 *     --previous "$RUNNER_TEMP/previous_prices.json" \
 *     [--target-jan 4549995734546]
 */

const fs = require("fs");
const path = require("path");
const {
  MODEL_RULES,
  COVERAGE_RULES,
  extractTargets,
  validateTargets,
  isPriceInRange
} = require("./price_rules");
const { parseTimestamp } = require("../assets/price-freshness.js");

// 実行開始〜終了の範囲外の取得日時を許さない（時計ずれ5分だけ許容）
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "-";
}

function hasPrices(item) {
  return Boolean(item && Array.isArray(item.stores) && item.stores.length > 0);
}

/*
 * 診断データから店舗別の取得状況を集計する（対象SKUの行だけ）。
 *   ok: 価格取得成功 / http403: HTTP 403 / timeout: タイムアウト / other: その他の失敗
 */
function summarizeStoreHealth(diagnostics, targetJans) {
  const health = {};
  for (const row of (diagnostics && Array.isArray(diagnostics.stores)) ? diagnostics.stores : []) {
    if (!row || !targetJans.has(String(row.jan || ""))) continue;
    const name = String(row.store || row.store_id || "(不明)");
    const h = health[name] || (health[name] = { ok: 0, http403: 0, timeout: 0, other: 0, reasons: {} });
    if (row.status === "OK") {
      h.ok++;
      continue;
    }
    const errorsText = (Array.isArray(row.errors) ? row.errors : []).join(" ");
    const status = row.http && row.http.status;
    let reason;
    if (status === 403) {
      h.http403++;
      reason = "HTTP 403";
    } else if (/timeout|タイムアウト/i.test(errorsText)) {
      h.timeout++;
      reason = "タイムアウト";
    } else {
      h.other++;
      reason = (Array.isArray(row.errors) && row.errors.find(e => !/^HTTP status/.test(e))) ||
        (status && status !== 200 ? `HTTP ${status}` : "価格を特定できず");
    }
    h.reasons[reason] = (h.reasons[reason] || 0) + 1;
  }
  return health;
}

/*
 * 検証本体。副作用なし。
 * 戻り値: { errors: string[], warnings: string[], report: object }
 */
function verifyPrices({
  prices,
  diagnostics,
  indexHtml,
  previousPrices = null,
  targetJan = "",
  rules = MODEL_RULES,
  coverage = COVERAGE_RULES
}) {
  const errors = [];
  const warnings = [];

  /* ---------- 対象SKU ---------- */
  const allTargets = extractTargets(indexHtml, rules);
  errors.push(...validateTargets(allTargets, rules));

  const onDemand = String(targetJan || "").trim() !== "";
  let targets = allTargets;

  if (onDemand) {
    targets = allTargets.filter(t => t.jan === String(targetJan).trim());
    if (targets.length !== 1) {
      errors.push(`指定JANが更新対象外です: ${targetJan}`);
    }
  }

  /* ---------- 診断データとの整合 ---------- */
  const startedMs = parseTimestamp(diagnostics && diagnostics.started_at_iso);
  const finishedMs = parseTimestamp(diagnostics && diagnostics.finished_at_iso);
  const runFinishedIso = diagnostics && diagnostics.finished_at_iso;

  if (startedMs === null || finishedMs === null || finishedMs < startedMs) {
    errors.push("診断データの実行日時（started_at_iso / finished_at_iso）が不正です");
  }

  const diagJans = new Set(
    (Array.isArray(diagnostics && diagnostics.targets) ? diagnostics.targets : [])
      .map(t => String(t.jan || ""))
  );

  if (!diagnostics || diagnostics.target_count !== targets.length) {
    errors.push(
      `診断データの対象件数が一致しません: diagnostics=${diagnostics && diagnostics.target_count}, expected=${targets.length}`
    );
  }

  for (const t of targets) {
    if (!diagJans.has(t.jan)) {
      errors.push(`${t.jan}: 今回の診断対象に含まれていません`);
    }
  }

  const storeHealth = summarizeStoreHealth(diagnostics, new Set(targets.map(t => t.jan)));

  if (diagnostics && diagnostics.prices_update && diagnostics.prices_update.updated === false) {
    // 更新中止時はSKU単位の検証をしない（大量のエラーで中止理由が埋もれないように）
    errors.unshift(`crawler が prices.json の更新を中止しました: ${diagnostics.prices_update.reason}`);
    return {
      errors,
      warnings,
      report: {
        mode: onDemand ? "on-demand" : "scheduled",
        aborted: true,
        targetCount: targets.length,
        fetchedSkuCount: 0,
        priceCount: 0,
        byModel: [],
        byStorage: [],
        byStore: {},
        storeHealth,
        noPriceSkus: [],
        previous: null
      }
    };
  }

  /* ---------- SKU単位の検証 ---------- */
  const skuResults = [];

  for (const t of targets) {
    const item = prices[t.jan];
    const label = `${t.jan}（${t.name}）`;

    if (!item || !Array.isArray(item.stores)) {
      errors.push(`${label}: prices.json に存在しないか stores が不正です`);
      skuResults.push({ target: t, ok: false });
      continue;
    }

    if (item.last_checked_at !== runFinishedIso) {
      errors.push(`${label}: 今回の実行で確認されていません（last_checked_at=${item.last_checked_at}）`);
    }

    const names = new Set();
    let validRows = 0;

    for (const row of item.stores) {
      const name = String((row && row.store) || "").trim();
      const price = Number(row && row.price);
      const observedMs = parseTimestamp(row && row.observed_at);
      const problems = [];

      if (!name) problems.push("店舗名なし");
      if (names.has(name)) problems.push("店舗名重複");
      if (!isPriceInRange(t.model, price, rules, t.storage)) problems.push(`価格がモデル別範囲外（${price}）`);
      if (row.color_verified !== true) problems.push("色未検証");
      if (row.condition !== "unopened") problems.push("未開封以外");
      if (
        observedMs === null ||
        startedMs === null ||
        finishedMs === null ||
        observedMs < startedMs - CLOCK_TOLERANCE_MS ||
        observedMs > finishedMs + CLOCK_TOLERANCE_MS
      ) {
        problems.push(`今回取得した価格ではありません（observed_at=${row && row.observed_at}）`);
      }

      if (problems.length) {
        errors.push(`${label}: 不正な価格行 ${name || "(不明)"} - ${problems.join("、")}`);
      } else {
        validRows++;
      }

      names.add(name);
    }

    const fetched = item.stores.length > 0;

    if (fetched) {
      if (item.fetch_status !== "ok") {
        errors.push(`${label}: 価格があるのに fetch_status=${item.fetch_status}`);
      }
      if (item.last_success_at !== runFinishedIso) {
        errors.push(`${label}: 価格があるのに取得成功日時が今回の実行と一致しません`);
      }
    } else {
      if (item.fetch_status !== "no_price") {
        errors.push(`${label}: 価格0件なのに fetch_status=${item.fetch_status}`);
      }
      if (item.last_success_at && item.last_success_at === runFinishedIso) {
        errors.push(`${label}: 価格0件なのに取得成功日時が今回の実行に進んでいます`);
      }

      const prev = previousPrices && previousPrices[t.jan];
      if (previousPrices) {
        // 前回の値から一切変わっていないこと（取得成功日時を据え置く）
        if ((item.last_update ?? null) !== ((prev && prev.last_update) ?? null)) {
          errors.push(`${label}: 価格0件なのに last_update が前回から変わっています`);
        }
        if ((item.last_success_at ?? null) !== ((prev && prev.last_success_at) ?? null)) {
          errors.push(`${label}: 価格0件なのに last_success_at が前回から変わっています`);
        }
      } else if (diagnostics && item.last_update && item.last_update === diagnostics.finished_at) {
        errors.push(`${label}: 価格0件なのに last_update が今回の実行に進んでいます`);
      }
    }

    skuResults.push({ target: t, ok: fetched && validRows === item.stores.length, prices: validRows });
  }

  /* ---------- 取得率（定時の全件実行のみ） ---------- */
  const fetchedCount = skuResults.filter(r => r.ok).length;
  const report = {
    mode: onDemand ? "on-demand" : "scheduled",
    targetCount: targets.length,
    fetchedSkuCount: fetchedCount,
    priceCount: skuResults.reduce((sum, r) => sum + (r.prices || 0), 0),
    byModel: [],
    byStorage: [],
    byStore: {},
    storeHealth,
    // 価格0件のSKU（画面では「価格未取得」と表示）
    noPriceSkus: targets.filter(t => prices[t.jan] && Array.isArray(prices[t.jan].stores) && prices[t.jan].stores.length === 0),
    previous: null
  };

  if (!onDemand) {
    // 閾値は取得実績のあるモデル（enforceCoverage !== false）だけで判定する
    const enforcedModels = new Set(rules.filter(r => r.enforceCoverage !== false).map(r => r.model));
    const enforced = skuResults.filter(r => enforcedModels.has(r.target.model));
    const enforcedOk = enforced.filter(r => r.ok).length;
    const minTotal = Math.ceil(enforced.length * coverage.minTotalRatio);
    report.enforcedTotal = { ok: enforcedOk, total: enforced.length, min: minTotal };
    if (enforcedOk < minTotal) {
      errors.push(`全体取得率が閾値未満: ${enforcedOk}/${enforced.length} SKU（下限 ${minTotal}）`);
    }

    for (const rule of rules) {
      const rows = skuResults.filter(r => r.target.model === rule.model);
      const ok = rows.filter(r => r.ok).length;
      const enforce = rule.enforceCoverage !== false;
      const min = enforce ? Math.ceil(rows.length * coverage.minModelRatio) : null;
      report.byModel.push({ model: rule.model, ok, total: rows.length, min });
      if (enforce && ok < min) {
        errors.push(`${rule.model} の取得率が閾値未満: ${ok}/${rows.length} SKU（下限 ${min}）`);
      }
      if (!enforce && rows.length && ok === 0) {
        warnings.push(`${rule.model}: 価格を1件も取得できませんでした（取得実績が無いため閾値は未設定・警告のみ）`);
      }

      for (const storage of rule.storages) {
        const srows = rows.filter(r => r.target.storage === storage);
        const sok = srows.filter(r => r.ok).length;
        report.byStorage.push({ model: rule.model, storage, ok: sok, total: srows.length });
        if (coverage.warnIfStorageZero && srows.length && sok === 0) {
          warnings.push(`${rule.model} ${storage}: 全カラーで価格を取得できませんでした`);
        }
      }
    }
  }

  // 店舗別の取得件数
  for (const r of skuResults) {
    const item = prices[r.target.jan];
    for (const row of (item && item.stores) || []) {
      report.byStore[row.store] = (report.byStore[row.store] || 0) + 1;
    }
  }

  /* ---------- 前回成功時との比較・対象外SKUの保護 ---------- */
  if (previousPrices) {
    const prevFetched = targets.filter(t => hasPrices(previousPrices[t.jan])).length;
    const prevByStore = {};
    for (const t of targets) {
      for (const row of (previousPrices[t.jan] && previousPrices[t.jan].stores) || []) {
        prevByStore[row.store] = (prevByStore[row.store] || 0) + 1;
      }
    }
    report.previous = { fetchedSkuCount: prevFetched, byStore: prevByStore };

    if (!onDemand && prevFetched > 0 && (prevFetched - fetchedCount) / prevFetched >= coverage.warnDropRatio) {
      warnings.push(`前回成功時から取得SKUが大きく減少: ${prevFetched} → ${fetchedCount}`);
    }

    if (!onDemand) {
      for (const [store, count] of Object.entries(prevByStore)) {
        if (count > 0 && !report.byStore[store]) {
          warnings.push(`${store}: 前回は${count}件取得、今回は0件（店舗側の障害・仕様変更の可能性）`);
        }
      }
    }

    if (Object.keys(prices).length < Object.keys(previousPrices).length) {
      errors.push(`prices.json のSKU数が減少しました: ${Object.keys(previousPrices).length} → ${Object.keys(prices).length}`);
    }

    // 今回の更新対象ではないSKU（iPhone 17、オンデマンド時の他SKU）は変更してはいけない
    const updatable = new Set(targets.map(t => t.jan));
    for (const [jan, prevItem] of Object.entries(previousPrices)) {
      if (updatable.has(jan)) continue;
      if (JSON.stringify(prices[jan]) !== JSON.stringify(prevItem)) {
        errors.push(`${jan}: 今回の更新対象外なのに内容が変わっています`);
      }
    }
  } else {
    warnings.push("前回の prices.json が無いため、前回比較と対象外SKUの保護チェックを省略しました");
  }

  return { errors, warnings, report };
}

function formatReport({ errors, warnings, report }) {
  const lines = [];
  lines.push(`## 価格検証（${report.mode === "scheduled" ? "定時全件" : "オンデマンド"}）`);
  lines.push("");
  lines.push(`- 取得SKU: **${report.fetchedSkuCount}/${report.targetCount}**（${pct(report.fetchedSkuCount, report.targetCount)}）`);
  lines.push(`- 有効価格: ${report.priceCount}件`);
  if (report.previous) {
    lines.push(`- 前回成功時の取得SKU: ${report.previous.fetchedSkuCount}/${report.targetCount}`);
  }

  if (report.byModel.length) {
    lines.push("");
    lines.push("| モデル | 取得 | 下限 |");
    lines.push("|---|---|---|");
    for (const m of report.byModel) {
      lines.push(`| ${m.model} | ${m.ok}/${m.total}（${pct(m.ok, m.total)}） | ${m.min === null ? "未設定（警告のみ）" : m.min} |`);
    }
    lines.push("");
    lines.push("| モデル | 容量 | 取得 |");
    lines.push("|---|---|---|");
    for (const s of report.byStorage) {
      lines.push(`| ${s.model} | ${s.storage} | ${s.ok}/${s.total} |`);
    }
  }

  const stores = new Set([
    ...Object.keys(report.byStore),
    ...Object.keys((report.previous && report.previous.byStore) || {})
  ]);
  if (stores.size) {
    lines.push("");
    lines.push("| 店舗 | 今回 | 前回 |");
    lines.push("|---|---|---|");
    for (const store of stores) {
      lines.push(`| ${store} | ${report.byStore[store] || 0} | ${report.previous ? (report.previous.byStore[store] || 0) : "-"} |`);
    }
  }

  if (report.aborted) {
    lines.push("");
    lines.push("> ⚠️ crawler が prices.json の更新を中止したため、SKU単位の検証は行っていません（公開データは前回のまま）。");
  }

  if (report.noPriceSkus && report.noPriceSkus.length) {
    lines.push("");
    lines.push(`### 価格0件のSKU（${report.noPriceSkus.length}件・画面では「価格未取得」と表示）`);
    lines.push("");
    lines.push("| JAN | 商品 |");
    lines.push("|---|---|");
    for (const t of report.noPriceSkus) lines.push(`| ${t.jan} | ${t.name} |`);
  }

  const health = Object.entries(report.storeHealth || {});
  const failing = health.filter(([, h]) => h.http403 + h.timeout + h.other > 0);
  if (failing.length) {
    lines.push("");
    lines.push(`### 取得失敗のある店舗（${failing.length}店舗）`);
    lines.push("");
    lines.push("| 店舗 | 成功 | HTTP 403 | タイムアウト | その他 | 主な理由 |");
    lines.push("|---|---|---|---|---|---|");
    for (const [store, h] of failing.sort((a, b) => a[1].ok - b[1].ok)) {
      const top = Object.entries(h.reasons).sort((a, b) => b[1] - a[1])[0];
      lines.push(`| ${store}${h.ok === 0 ? " ❗全件失敗" : ""} | ${h.ok} | ${h.http403} | ${h.timeout} | ${h.other} | ${top ? `${top[0]}（${top[1]}件）` : "-"} |`);
    }
  }

  if (warnings.length) {
    lines.push("");
    lines.push(`### 警告（${warnings.length}件）`);
    for (const w of warnings) lines.push(`- ${w}`);
  }

  lines.push("");
  lines.push(errors.length ? `### ❌ 失敗（${errors.length}件）` : "### ✅ 検証OK");
  for (const e of errors) lines.push(`- ${e}`);

  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`不明な引数: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function main() {
  const root = path.resolve(__dirname, "..");
  const args = parseArgs(process.argv.slice(2));
  const read = (p, fallback) => fs.readFileSync(path.resolve(root, p || fallback), "utf8");

  let previousPrices = null;
  if (args.previous) {
    try {
      previousPrices = JSON.parse(fs.readFileSync(args.previous, "utf8"));
    } catch (error) {
      console.error(`前回の prices.json を読めません: ${error.message}`);
      process.exit(1);
    }
  }

  const result = verifyPrices({
    prices: JSON.parse(read(args.prices, "data/prices.json")),
    diagnostics: JSON.parse(read(args.diagnostics, "data/crawl_diagnostics.json")),
    indexHtml: read(args.index, "index.html"),
    previousPrices,
    targetJan: args["target-jan"] || process.env.TARGET_JAN || ""
  });

  const text = formatReport(result);
  console.log(text);

  for (const w of result.warnings) console.log(`::warning::${w.replace(/\n/g, " ")}`);
  for (const e of result.errors) console.log(`::error::${e.replace(/\n/g, " ")}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  }

  // 検証失敗時も結果を残せるよう、レポートをファイルにも書く（Actions の成果物として保存）
  if (process.env.VERIFY_REPORT_PATH) {
    fs.writeFileSync(process.env.VERIFY_REPORT_PATH, text + "\n");
  }

  process.exit(result.errors.length ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { verifyPrices, formatReport, summarizeStoreHealth };
