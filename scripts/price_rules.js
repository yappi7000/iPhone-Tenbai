"use strict";

/*
 * iPhone買取価格の共通ルール
 *
 * crawler.js（取得・保存）と verify_prices.js（検証）の両方がここを参照する。
 * 片方だけ条件が変わって「保存は通るのに検証で落ちる」状態を防ぐため、
 * 対象SKUの抽出・モデル別価格範囲・取得率の閾値はこのファイルにだけ書く。
 */

/*
 * 対象モデル定義
 *
 * expectedSkus: index.html の JAN_DATABASE から抽出できるべきSKU数
 * colors: JAN_DATABASE のキーに使うカラー名（この一覧に無い色は対象外）
 * price: 1店舗あたりの買取価格として受け付ける範囲（円）
 *   - iPhone 18 Pro / Pro Max は従来の検証条件（5万〜50万円）をそのまま維持。
 * priceByStorage: 容量別の範囲（price より優先）
 * allowedStoreIds: 価格を取得してよい店舗（null = 制限なし）
 * enforceCoverage: 取得率の閾値で失敗にするか（false = 警告のみ）
 */

/*
 * iPhone Duo の Apple Store 定価（円・税込）
 * 出典: Apple 発表の国内価格（ケータイWatch 2026/9 報道で確認、index.html の APPLE_PRICES と一致）
 * tests/verify-prices.test.js で index.html との一致を検査する。
 */
const IPHONE_DUO_RETAIL = {
  "256GB": 364800,
  "512GB": 399800,
  "1TB": 469800,
  "2TB": 574800
};

/*
 * iPhone Duo の買取価格の受付範囲 = 定価の 0.5〜1.5 倍
 *   - 2026/10/25 時点の実勢（買取ルデヤ・森森買取の公開価格）は定価の約1.03〜1.13倍
 *     （例: 256GB 410,000〜410,500円 / 2TB 590,500〜595,000円）。
 *     iPhone 18 用の上限50万円では 1TB・2TB の正常価格がすべて弾かれる。
 *   - 0.5倍未満は「4万1千円」のような桁落ち・別商品の誤抽出、
 *     1.5倍超は桁の読み違いとみなして除外する。
 */
const DUO_PRICE_RATIO = { min: 0.5, max: 1.5 };

function retailRange(retail, ratio) {
  return Object.fromEntries(
    Object.entries(retail).map(([storage, yen]) => [
      storage,
      { min: Math.floor(yen * ratio.min), max: Math.ceil(yen * ratio.max) }
    ])
  );
}

const MODEL_RULES = [
  {
    model: "iPhone 18 Pro Max",
    storages: ["256GB", "512GB", "1TB", "2TB"],
    colors: ["ブラック", "シルバー", "バーガンディ", "グレイシャー"],
    expectedSkus: 16,
    price: { min: 50000, max: 500000 }
  },
  {
    model: "iPhone 18 Pro",
    storages: ["256GB", "512GB", "1TB", "2TB"],
    colors: ["ブラック", "シルバー", "バーガンディ", "グレイシャー"],
    expectedSkus: 16,
    price: { min: 50000, max: 500000 }
  },
  {
    model: "iPhone Duo",
    storages: ["256GB", "512GB", "1TB", "2TB"],
    colors: ["スターホワイト", "ナイトスカイ"],
    expectedSkus: 8,
    retail: IPHONE_DUO_RETAIL,
    priceByStorage: retailRange(IPHONE_DUO_RETAIL, DUO_PRICE_RATIO),
    /*
     * JAN完全一致で価格を抽出する店舗だけ。
     * 商品名・カラー文字列から抽出する店舗（楽園・MIX・モバイル一番・携帯空間・
     * 一丁目・モバステ）は iPhone 18 専用の解析ロジックで、Duo の掲載形式を
     * 検証していないため使わない（誤った色・容量の価格を出さないため）。
     */
    allowedStoreIds: ["rudeya", "morimori", "kaitorishouten", "kaitoriwiki", "iphonekaitori"],
    /*
     * 取得実績がまだ無いため、取得率の閾値は設けない（警告のみ）。
     * Duo の取得不調で iPhone 18 の更新まで止めないため。
     * 実績が溜まったら iPhone 18 と同じ方法で閾値を決める。
     */
    enforceCoverage: false
  }
];

/*
 * 取得率の閾値（定時の全件実行のみ）
 *
 * 根拠：data/crawl_diagnostics.json の過去の定時実行（2026/10/1〜10/24、22回）
 *   - 成功した実行は毎回 32/32 SKU で価格を取得できていた。
 *   - 最も多くのSKUをカバーしている店舗（買取ルデヤ、毎回32/32）が
 *     丸ごと取得失敗した場合でも、残りの店舗だけで 23〜32 SKU を取得できていた
 *     （最小23 SKU = 72%、10/18）。
 *   - つまり「1店舗の障害」なら 70% 前後は残る。
 *     これを大きく下回るのは、ブラウザ起動失敗・ネットワーク断・
 *     複数店舗の同時仕様変更など、取得処理全体の異常とみなせる。
 *
 * そこで最悪実績 72% から約3割の余裕を見て、全体・モデル別とも 50% を下限にする。
 *   - 1店舗障害（#56 で推測される状況）では止まらない。
 *   - 全滅や大規模な取得異常では止まる。
 *
 * 容量別（各8 SKU）は母数が小さく、正常時でも店舗の色別掲載の有無で揺れるため、
 * 失敗条件にはせず「0件なら警告」に留める。
 */
const COVERAGE_RULES = {
  minTotalRatio: 0.5,
  minModelRatio: 0.5,
  warnIfStorageZero: true,
  // 前回成功時から取得SKU数がこの割合以上減ったら警告（失敗にはしない）
  warnDropRatio: 0.25
};

// 価格が古いとみなす経過時間（フロント表示と同じ値を参照する）
const { STALE_HOURS } = require("../assets/price-freshness.js");

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * index.html の JAN_DATABASE から、MODEL_RULES に該当するSKUだけを抽出する。
 * 推測JANを作らないため、HTMLに書かれた13桁の値だけを使う。
 */
function extractTargets(indexHtml, rules = MODEL_RULES) {
  const targets = [];

  for (const rule of rules) {
    const pattern = new RegExp(
      `"(${escapeRegExp(rule.model)})_(${rule.storages.map(escapeRegExp).join("|")})_(${rule.colors.map(escapeRegExp).join("|")})"\\s*:\\s*"(\\d{13})"`,
      "g"
    );

    for (const match of String(indexHtml).matchAll(pattern)) {
      targets.push({
        jan: match[4],
        name: `${match[1]} ${match[2]} ${match[3]}`,
        model: match[1],
        storage: match[2],
        color: match[3]
      });
    }
  }

  return targets;
}

/*
 * 抽出結果の健全性チェック。問題があればエラー文の配列を返す。
 */
function validateTargets(targets, rules = MODEL_RULES) {
  const errors = [];

  for (const rule of rules) {
    const count = targets.filter(t => t.model === rule.model).length;
    if (count !== rule.expectedSkus) {
      errors.push(`${rule.model} のSKU数異常: ${count}件（期待値 ${rule.expectedSkus}件）`);
    }
  }

  const jans = targets.map(t => t.jan);
  if (new Set(jans).size !== jans.length) {
    errors.push("対象JANに重複があります");
  }

  for (const jan of jans) {
    if (!isValidJan13(jan)) {
      errors.push(`JANのチェックディジット不一致: ${jan}`);
    }
  }

  return errors;
}

function isValidJan13(jan) {
  const text = String(jan || "");
  if (!/^\d{13}$/.test(text)) return false;
  const digits = [...text].map(Number);
  const sum = digits
    .slice(0, 12)
    .reduce((acc, d, i) => acc + d * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

function ruleForModel(model, rules = MODEL_RULES) {
  return rules.find(rule => rule.model === model) || null;
}

/*
 * モデル別（容量別があれば容量別）の価格範囲。該当なしは null。
 */
function priceRangeFor(model, storage, rules = MODEL_RULES) {
  const rule = ruleForModel(model, rules);
  if (!rule) return null;
  if (rule.priceByStorage) return rule.priceByStorage[storage] || null;
  return rule.price || null;
}

/*
 * 価格範囲チェック。モデル・容量が不明なら受け付けない。
 */
function isPriceInRange(model, price, rules = MODEL_RULES, storage = null) {
  const range = priceRangeFor(model, storage, rules);
  const value = Number(price);
  return Boolean(
    range &&
    Number.isSafeInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

/*
 * そのモデルの価格取得に使ってよい店舗か
 */
function isStoreAllowedForModel(model, storeId, rules = MODEL_RULES) {
  const rule = ruleForModel(model, rules);
  if (!rule) return false;
  return !rule.allowedStoreIds || rule.allowedStoreIds.includes(storeId);
}

module.exports = {
  MODEL_RULES,
  COVERAGE_RULES,
  STALE_HOURS,
  extractTargets,
  validateTargets,
  isValidJan13,
  ruleForModel,
  priceRangeFor,
  isPriceInRange,
  isStoreAllowedForModel,
  IPHONE_DUO_RETAIL
};
