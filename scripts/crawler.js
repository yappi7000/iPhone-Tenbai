const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

/*
 * ============================================================
 * iPhone 買取価格クローラー
 * 安全診断版 crawler.js
 * ============================================================
 *
 * この版の重要ルール
 *
 * 1. prices.json は絶対に変更しない
 * 2. defaultPrice は使用しない
 * 3. 実際に取得できた価格だけを候補として記録
 * 4. 取得失敗は ERROR として記録
 * 5. 診断結果は crawl_diagnostics.json に保存
 * 6. 推測価格・補完価格は一切作らない
 *
 * ============================================================
 */


/* ============================================================
 * 対象商品
 * ============================================================
 *
 * 既存の17シリーズは、現在のcrawler.jsのJANを維持。
 *
 * iPhone 18 Pro / Pro Maxについては、
 * JANがまだこのファイル内で確定していないため、
 * 現時点では商品仕様だけを定義し、JAN検索対象にはしない。
 *
 * JANを確認できた段階で TARGET_JANS に追加する。
 * ============================================================
 */

const TARGET_JANS = [
  // ----------------------------------------------------------
  // iPhone 17 Pro Max
  // ----------------------------------------------------------

  {
    jan: "4549995649284",
    name: "iPhone 17 Pro Max 256GB シルバー"
  },
  {
    jan: "4549995649291",
    name: "iPhone 17 Pro Max 256GB コズミックオレンジ"
  },
  {
    jan: "4549995649307",
    name: "iPhone 17 Pro Max 256GB ディープブルー"
  },

  {
    jan: "4549995649314",
    name: "iPhone 17 Pro Max 512GB シルバー"
  },
  {
    jan: "4549995649321",
    name: "iPhone 17 Pro Max 512GB コズミックオレンジ"
  },
  {
    jan: "4549995649338",
    name: "iPhone 17 Pro Max 512GB ディープブルー"
  },

  {
    jan: "4549995649345",
    name: "iPhone 17 Pro Max 1TB シルバー"
  },
  {
    jan: "4549995649352",
    name: "iPhone 17 Pro Max 1TB コズミックオレンジ"
  },
  {
    jan: "4549995649369",
    name: "iPhone 17 Pro Max 1TB ディープブルー"
  },


  // ----------------------------------------------------------
  // iPhone 17 Pro
  // ----------------------------------------------------------

  {
    jan: "4549995649253",
    name: "iPhone 17 Pro 256GB シルバー"
  },
  {
    jan: "4549995649260",
    name: "iPhone 17 Pro 256GB コズミックオレンジ"
  },
  {
    jan: "4549995649277",
    name: "iPhone 17 Pro 256GB ディープブルー"
  },

  {
    jan: "4549995649406",
    name: "iPhone 17 Pro 512GB シルバー"
  },
  {
    jan: "4549995649413",
    name: "iPhone 17 Pro 512GB コズミックオレンジ"
  },
  {
    jan: "4549995649420",
    name: "iPhone 17 Pro 512GB ディープブルー"
  },

  {
    jan: "4549995649437",
    name: "iPhone 17 Pro 1TB シルバー"
  },
  {
    jan: "4549995649444",
    name: "iPhone 17 Pro 1TB コズミックオレンジ"
  },
  {
    jan: "4549995649451",
    name: "iPhone 17 Pro 1TB ディープブルー"
  },


  // ----------------------------------------------------------
  // iPhone 17
  // ----------------------------------------------------------

  {
    jan: "4549995649154",
    name: "iPhone 17 256GB ブラック"
  },
  {
    jan: "4549995649161",
    name: "iPhone 17 256GB ホワイト"
  },
  {
    jan: "4549995649178",
    name: "iPhone 17 256GB ブルー"
  },

  {
    jan: "4549995649185",
    name: "iPhone 17 512GB ブラック"
  },
  {
    jan: "4549995649192",
    name: "iPhone 17 512GB ホワイト"
  },


  // ----------------------------------------------------------
  // iPhone 17e
  // ----------------------------------------------------------

  {
    jan: "4549995677485",
    name: "iPhone 17e 256GB ブラック"
  },
  {
    jan: "4549995677492",
    name: "iPhone 17e 256GB ホワイト"
  },

  {
    jan: "4549995677508",
    name: "iPhone 17e 128GB ブラック"
  },
  {
    jan: "4549995677515",
    name: "iPhone 17e 128GB ホワイト"
  }
];


/* ============================================================
 * 今後追加するiPhone 18シリーズ
 * ============================================================
 *
 * Apple公式確認済み仕様
 *
 * Pro:
 *   256GB / 512GB / 1TB / 2TB
 *
 * Pro Max:
 *   256GB / 512GB / 1TB / 2TB
 *
 * カラー:
 *   ブラック
 *   シルバー
 *   グレイシャー
 *   バーガンディ
 *
 * JANは推測しない。
 * ============================================================
 */

const IPHONE_18_MODELS = [
  {
    model: "iPhone 18 Pro",
    storage: ["256GB", "512GB", "1TB", "2TB"],
    colors: ["ブラック", "シルバー", "グレイシャー", "バーガンディ"]
  },
  {
    model: "iPhone 18 Pro Max",
    storage: ["256GB", "512GB", "1TB", "2TB"],
    colors: ["ブラック", "シルバー", "グレイシャー", "バーガンディ"]
  }
];


/* ============================================================
 * 診断対象店舗
 * ============================================================
 *
 * 現在のcrawler.jsで実際に使用している2店舗を維持。
 *
 * 今回はまずこの2店舗を安全に診断する。
 *
 * 10店舗化する場合は、ここへ実URLを追加する。
 * ============================================================
 */

const STORES = [
  {
    id: "mobasute",
    name: "モバステ",
    searchUrl: jan =>
      `https://pastec.net/search?keyword=${encodeURIComponent(jan)}`
  },

  {
    id: "morimori",
    name: "森森買取",
    searchUrl: jan =>
      `https://www.morimori-kaitori.jp/search?keyword=${encodeURIComponent(jan)}`
  }
];


/* ============================================================
 * 設定
 * ============================================================
 */

const CONFIG = {
  pageTimeout: 15000,
  waitAfterLoad: 1500,

  /*
   * 価格候補として認識する範囲。
   *
   * これは「価格を推測する」ためではなく、
   * ページ内に存在する金額候補を抽出するための
   * 安全フィルター。
   */
  minPrice: 40000,
  maxPrice: 600000
};


/* ============================================================
 * 出力先
 * ============================================================
 */

const ROOT_DIR = path.resolve(__dirname, "..");

const DIAGNOSTICS_PATH =
  path.join(ROOT_DIR, "data", "crawl_diagnostics.json");


/* ============================================================
 * ユーティリティ
 * ============================================================
 */

function nowJST() {
  return new Date().toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo"
  });
}


function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}


/*
 * ページ本文から「実際に存在する」価格候補を抽出。
 *
 * defaultPriceなどは一切使わない。
 */
function extractPriceCandidates(text) {

  const normalized = normalizeText(text);

  const regex =
    /(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g;

  const results = [];

  for (const match of normalized.matchAll(regex)) {

    const raw = match[1];

    const price = Number(
      raw.replace(/,/g, "")
    );

    if (
      price >= CONFIG.minPrice &&
      price <= CONFIG.maxPrice
    ) {
      results.push({
        raw: match[0],
        price
      });
    }
  }

  /*
   * 重複排除
   */
  const unique = [];

  const seen = new Set();

  for (const item of results) {

    if (!seen.has(item.price)) {

      seen.add(item.price);
      unique.push(item);
    }
  }

  return unique;
}


/*
 * ページ本文にJANが存在するか確認。
 */
function containsJan(text, jan) {

  return normalizeText(text).includes(String(jan));
}


/*
 * ページ本文に商品名が存在するか確認。
 *
 * 完全一致ではなく、
 * 正規化した文字列で確認。
 */
function containsProductName(text, name) {

  const source = normalizeText(text)
    .toLowerCase();

  const target = normalizeText(name)
    .toLowerCase();

  return source.includes(target);
}


/* ============================================================
 * 1店舗を診断
 * ============================================================
 */

async function inspectStore(browser, store, item) {

  const url = store.searchUrl(item.jan);

  const diagnostic = {

    store_id: store.id,

    store: store.name,

    jan: item.jan,

    product_name: item.name,

    url,

    checked_at: nowJST(),

    status: "ERROR",

    http: {
      status: null,
      ok: false,
      final_url: null
    },

    page: {
      title: null,
      body_length: 0,
      body_available: false
    },

    product: {
      jan_found: false,
      name_found: false
    },

    price_candidates: [],

    errors: []
  };


  const page = await browser.newPage();


  try {

    console.log(
      `    ${store.name} → ${item.name}`
    );


    /*
     * ページアクセス
     */

    const response = await page.goto(
      url,
      {
        waitUntil: "domcontentloaded",
        timeout: CONFIG.pageTimeout
      }
    );


    /*
     * HTTP情報
     */

    diagnostic.http.status =
      response ? response.status() : null;

    diagnostic.http.ok =
      response ? response.ok() : false;

    diagnostic.http.final_url =
      page.url();


    /*
     * JavaScript描画待ち
     */

    await page.waitForTimeout(
      CONFIG.waitAfterLoad
    );


    /*
     * タイトル
     */

    diagnostic.page.title =
      await page.title().catch(() => null);


    /*
     * 本文
     */

    const bodyText =
      await page
        .locator("body")
        .innerText()
        .catch(() => "");


    diagnostic.page.body_length =
      bodyText.length;

    diagnostic.page.body_available =
      bodyText.length > 0;


    /*
     * 商品確認
     */

    diagnostic.product.jan_found =
      containsJan(bodyText, item.jan);

    diagnostic.product.name_found =
      containsProductName(
        bodyText,
        item.name
      );


    /*
     * 価格候補
     *
     * ページに実際に存在する金額のみ。
     */

    diagnostic.price_candidates =
      extractPriceCandidates(bodyText);


    /*
     * エラー判定
     */

    if (!diagnostic.http.ok) {

      diagnostic.errors.push(
        `HTTP status ${diagnostic.http.status}`
      );
    }


    if (!diagnostic.page.body_available) {

      diagnostic.errors.push(
        "ページ本文を取得できませんでした"
      );
    }


    /*
     * 成功判定
     *
     * HTTP・本文が正常ならOK。
     *
     * 商品や価格が見つからない場合も、
     * 「取得できなかった」という重要な診断結果なので
     * ERROR扱いにはしない。
     */

    diagnostic.status =
      diagnostic.errors.length > 0
        ? "ERROR"
        : "OK";


  } catch (error) {

    diagnostic.status = "ERROR";

    diagnostic.errors.push(
      error && error.message
        ? error.message
        : String(error)
    );

  } finally {

    await page.close().catch(() => {});
  }


  return diagnostic;
}


/* ============================================================
 * メイン処理
 * ============================================================
 */

async function run() {

  console.log("");
  console.log("==========================================");
  console.log(" iPhone 買取価格クローラー");
  console.log(" 安全診断モード");
  console.log("==========================================");
  console.log("");

  console.log(
    `対象商品: ${TARGET_JANS.length}件`
  );

  console.log(
    `診断店舗: ${STORES.length}店舗`
  );

  console.log("");

  /*
   * Chromium起動
   */

  const browser =
    await chromium.launch({
      headless: true,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    });


  /*
   * 結果オブジェクト
   */

  const diagnostics = {

    version: "safe-diagnostic-2.0",

    started_at: nowJST(),

    finished_at: null,

    /*
     * 安全確認フラグ
     */

    safety: {

      prices_json_modified: false,

      default_price_used: false,

      fallback_price_used: false,

      guessed_price_used: false,

      guessed_jan_used: false
    },


    /*
     * iPhone 18仕様
     */

    iphone_18_spec:

      IPHONE_18_MODELS,


    /*
     * 対象商品
     */

    target_count:
      TARGET_JANS.length,

    targets:
      TARGET_JANS,


    /*
     * 店舗
     */

    store_count:
      STORES.length,

    stores: [],


    /*
     * 集計
     */

    summary: {

      ok: 0,

      error: 0,

      jan_found: 0,

      product_name_found: 0,

      price_candidate_found: 0
    }
  };


  try {

    /*
     * 商品 × 店舗
     */

    for (
      const item of TARGET_JANS
    ) {

      console.log(
        `\n[PRODUCT] ${item.name}`
      );

      console.log(
        `           JAN: ${item.jan}`
      );


      for (
        const store of STORES
      ) {

        const result =
          await inspectStore(
            browser,
            store,
            item
          );


        diagnostics.stores.push(
          result
        );


        /*
         * 集計
         */

        if (
          result.status === "OK"
        ) {

          diagnostics.summary.ok++;

        } else {

          diagnostics.summary.error++;
        }


        if (
          result.product.jan_found
        ) {

          diagnostics.summary.jan_found++;
        }


        if (
          result.product.name_found
        ) {

          diagnostics.summary.product_name_found++;
        }


        if (
          result.price_candidates.length > 0
        ) {

          diagnostics.summary.price_candidate_found++;
        }


        /*
         * コンソール表示
         */

        console.log(
          `      HTTP: ${result.http.status}`
        );

        console.log(
          `      JAN: ${
            result.product.jan_found
              ? "FOUND"
              : "NOT FOUND"
          }`
        );

        console.log(
          `      NAME: ${
            result.product.name_found
              ? "FOUND"
              : "NOT FOUND"
          }`
        );

        console.log(
          `      PRICE CANDIDATES: ${
            result.price_candidates.length
          }`
        );

        if (
          result.errors.length > 0
        ) {

          console.log(
            `      ERROR: ${
              result.errors.join(" / ")
            }`
          );
        }
      }
    }


  } finally {

    await browser.close();
  }


  /*
   * 完了時刻
   */

  diagnostics.finished_at =
    nowJST();


  /*
   * dataディレクトリ作成
   */

  const dataDir =
    path.join(
      ROOT_DIR,
      "data"
    );


  if (
    !fs.existsSync(dataDir)
  ) {

    fs.mkdirSync(
      dataDir,
      {
        recursive: true
      }
    );
  }


  /*
   * 診断結果だけ保存
   *
   * prices.jsonには触れない。
   */

  fs.writeFileSync(
    DIAGNOSTICS_PATH,

    JSON.stringify(
      diagnostics,
      null,
      2
    ),

    "utf8"
  );


  /*
   * 完了表示
   */

  console.log("");

  console.log(
    "=========================================="
  );

  console.log(
    " 診断完了"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `OK: ${diagnostics.summary.ok}`
  );

  console.log(
    `ERROR: ${diagnostics.summary.error}`
  );

  console.log(
    `JAN FOUND: ${diagnostics.summary.jan_found}`
  );

  console.log(
    `NAME FOUND: ${diagnostics.summary.product_name_found}`
  );

  console.log(
    `PRICE CANDIDATES: ${diagnostics.summary.price_candidate_found}`
  );

  console.log("");

  console.log(
    `診断結果: ${DIAGNOSTICS_PATH}`
  );

  console.log(
    "prices.json: NOT MODIFIED"
  );

  console.log(
    "defaultPrice: NOT USED"
  );

  console.log(
    "fallback price: NOT USED"
  );

  console.log(
    "guessed price: NOT USED"
  );

  console.log(
    "guessed JAN: NOT USED"
  );

  console.log("");
}


/* ============================================================
 * 実行
 * ============================================================
 */

run().catch(error => {

  console.error("");
  console.error(
    "=========================================="
  );
  console.error(
    " FATAL ERROR"
  );
  console.error(
    "=========================================="
  );

  console.error(
    error && error.stack
      ? error.stack
      : error
  );

  process.exitCode = 1;
});
