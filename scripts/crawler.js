const fs = require('fs');
const path = require('path');
const https = require('https');
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
    jan: "4549995648294",
    name: "iPhone 17 Pro 256GB シルバー"
  },
  {
    jan: "4549995648300",
    name: "iPhone 17 Pro 256GB コズミックオレンジ"
  },
  {
    jan: "4549995648317",
    name: "iPhone 17 Pro 256GB ディープブルー"
  },

  {
    jan: "4549995648324",
    name: "iPhone 17 Pro 512GB シルバー"
  },
  {
    jan: "4549995648331",
    name: "iPhone 17 Pro 512GB コズミックオレンジ"
  },
  {
    jan: "4549995648348",
    name: "iPhone 17 Pro 512GB ディープブルー"
  },

  {
    jan: "4549995648355",
    name: "iPhone 17 Pro 1TB シルバー"
  },
  {
    jan: "4549995648362",
    name: "iPhone 17 Pro 1TB コズミックオレンジ"
  },
  {
    jan: "4549995648379",
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


const IPHONE_18_MOBA_TARGETS = [
  { name: "iPhone18 Pro 256GB" },
  { name: "iPhone18 Pro 512GB" },
  { name: "iPhone18 Pro 1TB" },
  { name: "iPhone18 Pro 2TB" },
  { name: "iPhone18 Pro Max 256GB" },
  { name: "iPhone18 Pro Max 512GB" },
  { name: "iPhone18 Pro Max 1TB" },
  { name: "iPhone18 Pro Max 2TB" }
];

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

/*
 * iPhone 18 Pro / Pro Max
 * 表示・保存用 32 SKU
 *
 * 価格取得用の8商品とは分離する。
 * 色別価格が確認できない場合は価格を推測しない。
 */
const IPHONE_18_SKUS =
  IPHONE_18_MODELS.flatMap(model =>
    model.storage.flatMap(storage =>
      model.colors.map(color => ({
        model: model.model,
        storage,
        color,
        name:
          `${model.model} ${storage} ${color}`,
        lookup_name:
          `${model.model.replace("iPhone ", "iPhone")} ${storage}`
      }))
    )
  );



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

const IPHONE_18_COLOR_SAFE_STORE_IDS = new Set([
  "keitaispace",
  "mobileichiban",
  "mobilemix",
  "rakuen",
  "mobasute",
  "ichome",
  "morimori",
  "homura",
  "rudeya",
  "iphonekaitori",
  "kaitoriwiki",
  "kaitorishouten",
  "iphonekaitori"
]);

const STORES = [

  {
    id: "iosys",
    deferred: true,
    name: "イオシス",
    priceTableUrl: "https://k-tai-iosys.com/pricelist/smartphone/iphone/"
  },

  {
    id: "janpara",
    deferred: true,
    name: "じゃんぱら",
    searchUrl: jan =>
      "https://buy.janpara.co.jp/buy/search?design=1&keyword=" +
      encodeURIComponent(jan),
    janSearch: true
  },

  {
    id: "mobasute",
    name: "モバステ",
    priceTableUrl: "https://pastec.net/iphone"
  },

  {
    id: "morimori",
    name: "森森買取",
    searchUrl: jan =>
      `https://www.morimori-kaitori.jp/search?sk=${encodeURIComponent(jan)}`
  },

  {
    id: "homura",
    name: "買取ホムラ",
    searchUrl: jan =>
      "https://" +
      "kaitori-homura.com" +
      "/products?commit=" +
      encodeURIComponent("検索") +
      "&q%5Bname_or_jan_code_cont%5D=" +
      encodeURIComponent(jan),
    janSearch: true
  },
  {
    id: "rudeya",
    name: "買取ルデヤ",
    searchUrl: jan =>
      "https://" +
      "kaitori-rudeya.com" +
      "/search/index/" +
      encodeURIComponent(jan),
    janSearch: true
  },
  {
    id: "rakuen",
    name: "買取楽園",
    priceTableUrl:
      "https://" +
      "www.keitairakuen.com" +
      "/product-category/keitai/iphone/"
  },
  {
    id: "ichome",
    name: "買取一丁目",
    priceTableUrl: "https://www.1-chome.com/keitai"
  },

  {
    id: "iphonekaitori",
    name: "iPhone買取価格表",
    priceTableUrl: "https://www.iphonekaitori.tokyo/brand/apple/market-price"
  },

  {
    id: "kaitoriwiki",
    name: "買取wiki",
    searchUrl: jan =>
      `https://kaitori.wiki/search?keyword=${encodeURIComponent(jan)}`
  },

  {
    id: "amemoba",
    name: "アメモバ",
    iphone18Only: true
  },
  {
    id: "mobilemix",
    name: "モバイルMIX",
    priceTableUrl:
      "https://" + "mobile-mix.jp" + "/?category=7"
  },
  {
    id: "mobileichiban",
    name: "モバイル一番",
    priceTableUrl:
      "https://" + "www.mobile-ichiban.com" + "/Prod/1"
  },
  {
    id: "keitaispace",
    name: "携帯空間",
    priceTableUrl:
      "https://" + "www.keitaispace.co.jp" + "/product/?ca=23"
  },
  {
    id: "kaitorishouten",
    name: "買取商店",
    priceTableUrl:
      "https://" + "www.kaitorishouten-co.jp" + "/keitai"
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

const PRICES_PATH =
  path.join(ROOT_DIR, "data", "prices.json");

const PRICE_OUTPUT_STORE_IDS = [
  "keitaispace",
  "mobileichiban",
  "mobilemix",
  "rakuen",
  "mobasute",
  "ichome",
  "morimori",
  "homura",
  "rudeya",
  "iphonekaitori",
  "kaitoriwiki",
  "kaitorishouten"
];



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
function 
extractPriceCandidates(text) {

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

/*
 * モバステの価格表から商品単位で未開封価格を取得。
 *
 * ページ全体の価格候補ではなく、
 * 商品名に一致する .p-priceTable__name 内の
 * .price--unopened を直接取得する。
 *
 * 推測価格・補完価格は一切作らない。
 */

function toMobasute17Name(productName) {
  let name = normalizeText(productName);

  // iPhone と 17 の間の空白を削除
  name = name.replace(/^iPhone\s+(17|18)/, "iPhone$1");

  // モバステはカラー別の商品名を使用していないため、
  // TARGET_JANS 側の商品名末尾にあるカラー名を削除
  const colors = [
    "シルバー",
    "コズミックオレンジ",
    "ディープブルー",
    "グレイシャー",
    "バーガンディ",
    "ブラック",
    "ホワイト",
    "ブルー"
  ];

  for (const color of colors) {
    if (name.endsWith(` ${color}`)) {
      name = name.slice(
        0,
        -(color.length + 1)
      );
      break;
    }
  }

  return normalizeText(name);
}


function applyMobasuteColorAdjustment(
  extracted,
  color
) {
  if (
    !extracted ||
    extracted.price === null ||
    extracted.price === undefined
  ) {
    return extracted;
  }

  const basePrice =
    Number(extracted.price);

  if (
    !Number.isFinite(basePrice) ||
    basePrice <= 0
  ) {
    return extracted;
  }

  const caution =
    normalizeText(
      extracted.caution || ""
    );

  if (!color || !caution) {
    return {
      ...extracted,
      base_price: basePrice,
      adjustment: 0
    };
  }

  const colorPatterns = {
    "ブラック":
      /ブラック\s*([+-]\s*[0-9,]+)/i,

    "シルバー":
      /シルバー\s*([+-]\s*[0-9,]+)/i,

    "グレイシャー":
      /(?:グレイシャー|グレイシャ)\s*([+-]\s*[0-9,]+)/i,

    "バーガンディ":
      /バーガンディ\s*([+-]\s*[0-9,]+)/i
  };

  const pattern =
    colorPatterns[color];

  const match =
    pattern
      ? caution.match(pattern)
      : null;

  if (!match) {
    return {
      ...extracted,
      base_price: basePrice,
      adjustment: 0
    };
  }

  const adjustment =
    Number(
      match[1]
        .replace(/\s/g, "")
        .replace(/,/g, "")
    );

  if (!Number.isFinite(adjustment)) {
    return {
      ...extracted,
      price: null,
      raw_price: null,
      error:
        "モバステ色別増減額を数値化できません"
    };
  }

  const finalPrice =
    basePrice + adjustment;

  return {
    ...extracted,
    price: finalPrice,
    raw_price:
      `${finalPrice.toLocaleString("ja-JP")}円`,
    base_price: basePrice,
    adjustment
  };
}


async function extractMobasutePrice(page, productName) {

  const target = normalizeText(productName);

  const products = page.locator(".p-priceTable__name");

  const count = await products.count();

  for (let i = 0; i < count; i++) {

    const product = products.nth(i);

    const nameElement =
      product.locator(":scope > span").first();

    const name =
      normalizeText(
        await nameElement.innerText().catch(() => "")
      );

    if (name !== target) {
      continue;
    }

    const unopenedElement =
      product.locator(".price--unopened").first();

    if (await unopenedElement.count() === 0) {
      return {
        found: true,
        price: null,
        caution: normalizeText(
          await product
            .locator(".p-priceTable__caution")
            .innerText()
            .catch(() => "")
        ),
        error: "未開封価格の要素が見つかりません"
      };
    }

    const rawPrice =
      normalizeText(
        await unopenedElement.innerText().catch(() => "")
      );

    const match =
      rawPrice.match(/([1-9]\d{1,2}(?:,\d{3})*)\s*円/);

    if (!match) {
      return {
        found: true,
        price: null,
        caution: normalizeText(
          await product
            .locator(".p-priceTable__caution")
            .innerText()
            .catch(() => "")
        ),
        error: "未開封価格を数値として解析できません"
      };
    }

    return {
      found: true,
      price: Number(match[1].replace(/,/g, "")),
      raw_price: rawPrice,
      caution: normalizeText(
        await product
          .locator(".p-priceTable__caution")
          .innerText()
          .catch(() => "")
      ),
      error: null
    };
  }

  return {
    found: false,
    price: null,
    caution: "",
    error: "商品名に一致する商品ブロックが見つかりません"
  };
}


/* ============================================================
 * 1店舗を診断
 * ============================================================
 */

function toIchome17Name(productName) {
  let name = normalizeText(productName);

  const colors = [
    "シルバー",
    "コズミックオレンジ",
    "ディープブルー",
    "グレイシャー",
    "バーガンディ",
    "ブラック",
    "ホワイト",
    "ブルー"
  ];

  for (const color of colors) {
    if (name.endsWith(` ${color}`)) {
      name = name.slice(0, -(color.length + 1));
      break;
    }
  }

  return normalizeText(name);
}


function extractIchomePrice(
  bodyText,
  productName
) {
  const text =
    String(bodyText || "")
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ");

  const normalizedName =
    normalizeText(productName);

  const colorMatch =
    normalizedName.match(
      /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/
    );

  const color =
    colorMatch
      ? colorMatch[1]
      : null;

  const target =
    normalizeText(
      normalizedName.replace(
        /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/,
        ""
      )
    );

  const index =
    text.indexOf(target);

  if (index === -1) {
    return {
      found: false,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "商品名に一致する商品が見つかりません"
    };
  }

  const block =
    text.slice(
      index,
      index + 500
    );

  const baseMatch =
    block.match(
      /未開封\s*[¥￥]\s*([0-9,]+)/
    );

  if (!baseMatch) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "未開封価格を取得できません"
    };
  }

  const basePrice =
    Number(
      baseMatch[1].replace(/,/g, "")
    );

  if (
    !Number.isFinite(basePrice) ||
    basePrice <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "未開封価格を数値化できません"
    };
  }

  const beforeUnopened =
    block.split(/未開封/)[0];

  let adjustment = 0;
  let rule = "色別増減なし";

  if (color) {
    const colorRule =
      /((?:ブラック|シルバー|グレイシャー?|バーガンディ)(?:\s*[,、\/]\s*(?:ブラック|シルバー|グレイシャー?|バーガンディ))*)\s*([+-]\s*[0-9,]+)/g;

    for (
      const m of beforeUnopened.matchAll(colorRule)
    ) {
      const colors =
        m[1]
          .split(/[,、\/]/)
          .map(x => x.trim())
          .map(x =>
            x === "グレイシャ"
              ? "グレイシャー"
              : x
          );

      if (!colors.includes(color)) {
        continue;
      }

      const value =
        Number(
          m[2]
            .replace(/\s/g, "")
            .replace(/,/g, "")
        );

      if (!Number.isFinite(value)) {
        return {
          found: true,
          price: null,
          raw_price: null,
          caution: beforeUnopened.trim(),
          error:
            "色別増減額を数値化できません"
        };
      }

      adjustment = value;
      rule =
        `${m[1]} ${value.toLocaleString("ja-JP")}円`;

      break;
    }
  }

  const finalPrice =
    basePrice + adjustment;

  return {
    found: true,
    price: finalPrice,
    raw_price:
      `${finalPrice.toLocaleString("ja-JP")}円`,
    base_price:
      basePrice,
    adjustment,
    caution:
      `基準${basePrice.toLocaleString("ja-JP")}円 / ${rule}`,
    error: null
  };
}


function extractIphoneKaitoriPrice(bodyText, jan) {
  const text = String(bodyText || "").replace(/\r/g, "");

  const janPattern =
    new RegExp(
      `JANコード[：:]\\s*${jan}\\s*([1-9]\\d{1,2}(?:,\\d{3})*)円`
    );

  const match = text.match(janPattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "JAN完全一致の商品価格が見つかりません"
    };
  }

  return {
    found: true,
    price: Number(match[1].replace(/,/g, "")),
    raw_price: `${match[1]}円`,
    error: null
  };
}


function extractKaitoriWikiPrice(bodyText, productName) {
  const text = String(bodyText || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ");

  const target = normalizeText(productName);

  const index = text.indexOf(target);

  if (index === -1) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "検索結果の商品名が一致しません"
    };
  }

  const block = text.slice(index, index + 500);

  const match = block.match(
    /買取価格\s*[：:]\s*([1-9]\d{1,2}(?:,\d{3})*)円/
  );

  if (!match) {
    return {
      found: true,
      price: null,
      raw_price: null,
      error: "買取価格を取得できません"
    };
  }

  return {
    found: true,
    price: Number(match[1].replace(/,/g, "")),
    raw_price: `${match[1]}円`,
    error: null
  };
}


function extractAmemoba18Price(bodyText, productName) {
  const text = String(bodyText || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ");

  const target = normalizeText(productName)
    .replace(/^iPhone18\b/, "iPhone 18");

  const domesticIndex = text.indexOf("国内版SIMフリー");

  if (domesticIndex === -1) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "国内版SIMフリー欄が見つかりません"
    };
  }

  const domesticBlock = text.slice(domesticIndex);

  const productIndex = domesticBlock.indexOf(target);

  if (productIndex === -1) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "国内版SIMフリーの商品名が見つかりません"
    };
  }

  const block = domesticBlock.slice(productIndex, productIndex + 300);

  const match = block.match(
    /未開封買取価格\s*([1-9]\d{1,2}(?:,\d{3})*)円/
  );

  if (!match) {
    return {
      found: true,
      price: null,
      raw_price: null,
      error: "未開封買取価格を取得できません"
    };
  }

  return {
    found: true,
    price: Number(match[1].replace(/,/g, "")),
    raw_price: `${match[1]}円`,
    error: null
  };
}

function getAmemoba18Url(productName) {
  if (/iPhone18 Pro Max/i.test(productName)) {
    return "https://amemoba.com/smartphone/iphone/iphone-18pro-max/";
  }

  if (/iPhone18 Pro/i.test(productName)) {
    return "https://amemoba.com/smartphone/iphone/iphone-18-pro/";
  }

  return null;
}


function extractJanparaPrice(bodyText, productName) {
  const text = String(bodyText || "")
    .replace(/\r/g, "");

  const normalized = productName
    .replace(/^iPhone\s*/i, "iPhone ");

  const escaped = normalized.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const pattern = new RegExp(
    "国内版\\s*〖SIMフリー〗\\s*" +
    escaped +
    "[^\\n]*\\n(?:[^\\n]*\\n)*?" +
    "未使用品\\s*\\n\\s*([0-9,]+)円",
    "i"
  );

  const match = text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "国内版SIMフリー・未使用品価格が見つかりません"
    };
  }

  return {
    found: true,
    price: Number(match[1].replace(/,/g, "")),
    raw_price: `${match[1]}円`,
    error: null
  };
}


function extractIosysPrice(bodyText, productName) {
  const text = String(bodyText || "")
    .replace(/\r/g, "");

  /*
   * イオシスは
   *
   * 国内版SIMフリー iPhone17 Pro MAX 256GB
   * | 未使用品買取価格186,000円
   *
   * の形式。
   *
   * 海外版SIMフリーは意図的に除外する。
   */

  let model = productName
    .replace(/^iPhone\s*/i, "iPhone")
    .replace(/ Pro Max /i, " Pro MAX ");

  const escaped = model.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const pattern = new RegExp(
    "国内版SIMフリー\\s*" +
    escaped +
    "\\s*[^\\n]*" +
    "未使用品買取価格\\s*([0-9,]+)円",
    "i"
  );

  const match = text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "国内版SIMフリー・未使用品価格が見つかりません"
    };
  }

  return {
    found: true,
    price: Number(match[1].replace(/,/g, "")),
    raw_price: `${match[1]}円`,
    error: null
  };
}

function fetchMorimoriHtml(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml"
        }
      },
      response => {
        let body = "";

        response.setEncoding("utf8");

        response.on("data", chunk => {
          body += chunk;
        });

        response.on("end", () => {
          resolve({
            status: response.statusCode || null,
            final_url: url,
            body
          });
        });
      }
    );

    request.setTimeout(CONFIG.pageTimeout, () => {
      request.destroy(
        new Error("森森買取 HTTP timeout")
      );
    });

    request.on("error", reject);
  });
}

function extractHomuraPrice(bodyText, productName) {
  const text = String(bodyText || "").replace(/\r/g, "");

  const target = String(productName || "")
    .replace(/\s+/g, " ")
    .trim();

  /*
   * ホムラ実ページ確認済み形式
   *
   * 【未開封】iPhone 17 Pro Max 256GB silver
   * 514549995649284
   * 買取金額（税込）
   * ¥ 192,000
   *
   * 色は商品名照合から除外し、
   * モデル＋容量まで一致させる。
   */

  const base = target
    .replace(/\s+(シルバー|ディープブルー|コズミックオレンジ|ブラック|グレイシャー|バーガンディ)$/i, "")
    .trim();

  const escaped = base.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const pattern = new RegExp(
    "【未開封】[^\\n]*" +
    escaped +
    "[^\\n]*" +
    "[\\s\\S]{0,180}?" +
    "買取金額（(?:税込|税込み)）" +
    "\\s*¥?\\s*([0-9,]+)",
    "i"
  );

  const match = text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "未開封商品の買取金額が見つかりません"
    };
  }

  const price = Number(
    match[1].replace(/,/g, "")
  );

  if (
    !Number.isFinite(price) ||
    price < CONFIG.minPrice ||
    price > CONFIG.maxPrice
  ) {
    return {
      found: true,
      price: null,
      raw_price: match[1] + "円",
      error: "買取金額が安全範囲外です"
    };
  }

  return {
    found: true,
    price,
    raw_price: match[1] + "円",
    error: null
  };
}


function extractRudeyaPrice(bodyText, jan) {
  const text = String(bodyText || "").replace(/\r/g, "");

  const janText = String(jan || "").trim();

  /*
   * 実ページ確認済み形式
   *
   * 新品
   * iPhone 17 Pro Max 256GB ... 未開封 SIMフリー
   * JAN: 4549995649284
   * ...
   * 買取価格
   * 192,000円
   *
   * 「郵送買取+300円キャンペーン」は加算しない。
   */

  const escapedJan = janText.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const pattern = new RegExp(
    "新品[\\s\\S]{0,300}?" +
    "未開封[\\s\\S]{0,200}?" +
    "JAN:\\s*" +
    escapedJan +
    "[\\s\\S]{0,300}?" +
    "買取価格\\s*([0-9,]+)円",
    "i"
  );

  const match = text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "新品・未開封商品の買取価格が見つかりません"
    };
  }

  const price = Number(
    match[1].replace(/,/g, "")
  );

  if (
    !Number.isFinite(price) ||
    price < CONFIG.minPrice ||
    price > CONFIG.maxPrice
  ) {
    return {
      found: true,
      price: null,
      raw_price: match[1] + "円",
      error: "買取価格が安全範囲外です"
    };
  }

  return {
    found: true,
    price,
    raw_price: match[1] + "円",
    error: null
  };
}


function extractRakuenPrice(
  bodyText,
  productName
) {
  const text =
    String(bodyText || "")
      .replace(/\r/g, "");

  const normalizedName =
    normalizeText(productName);

  const colorMatch =
    normalizedName.match(
      /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/
    );

  const color =
    colorMatch
      ? colorMatch[1]
      : null;

  let target =
    normalizedName.replace(
      /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/,
      ""
    );

  /*
   * 買取楽園では Pro Max を Promax と表記。
   */
  target =
    target.replace(
      "iPhone 18 Pro Max",
      "iPhone 18 Promax"
    );

  const index =
    text.indexOf(target);

  if (index === -1) {
    return {
      found: false,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "SIM FREE未開封商品が見つかりません"
    };
  }

  /*
   * 開封済みブロックより前だけを対象にする。
   */
  const openedIndex =
    text.indexOf(
      "SIM FREE 開封済み",
      index
    );

  const block =
    text.slice(
      index,
      openedIndex > index
        ? openedIndex
        : index + 500
    );

  if (
    !block.includes(
      "SIM FREE 未開封"
    )
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "SIM FREE未開封ブロックを取得できません"
    };
  }

  const baseMatch =
    block.match(
      /新品:\s*[¥￥]\s*([1-9][0-9,]*)/
    );

  if (!baseMatch) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "新品基準価格を取得できません"
    };
  }

  const basePrice =
    Number(
      baseMatch[1].replace(/,/g, "")
    );

  if (
    !Number.isFinite(basePrice) ||
    basePrice <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "新品基準価格を数値化できません"
    };
  }

  let finalPrice = basePrice;
  let adjustment = 0;
  let rule = "基準価格";

  /*
   * 紫 = バーガンディ
   * 青 = グレイシャー
   * 銀 = シルバー
   * 黒 = ブラック
   */

  if (color) {
    /*
     * 例:
     * 紫以外-1000
     * 紫以外-2000
     */
    const nonPurpleMatch =
      block.match(
        /紫以外\s*([+-]\s*[0-9,]+)/
      );

    if (
      nonPurpleMatch &&
      color !== "バーガンディ"
    ) {
      adjustment =
        Number(
          nonPurpleMatch[1]
            .replace(/\s/g, "")
            .replace(/,/g, "")
        );

      if (!Number.isFinite(adjustment)) {
        return {
          found: true,
          price: null,
          raw_price: null,
          caution: "",
          error:
            "紫以外の増減額を数値化できません"
        };
      }

      finalPrice =
        basePrice + adjustment;

      rule =
        `紫以外 ${adjustment.toLocaleString("ja-JP")}円`;
    }

    /*
     * Pro Max等の明示色価格
     * 例:
     * 黒 253,000
     * 青/銀 246,000
     */
    const explicitPatterns = {
      "ブラック":
        /黒\s*([1-9][0-9,]*)/,

      "シルバー":
        /青\/銀\s*([1-9][0-9,]*)|銀\s*([1-9][0-9,]*)/,

      "グレイシャー":
        /青\/銀\s*([1-9][0-9,]*)|青\s*([1-9][0-9,]*)/
    };

    const pattern =
      explicitPatterns[color];

    const explicit =
      pattern
        ? block.match(pattern)
        : null;

    if (explicit) {
      const raw =
        explicit[1] ||
        explicit[2];

      const explicitPrice =
        Number(
          raw.replace(/,/g, "")
        );

      if (
        Number.isFinite(explicitPrice) &&
        explicitPrice > 0
      ) {
        finalPrice =
          explicitPrice;

        adjustment =
          explicitPrice - basePrice;

        rule =
          `${color}明示価格`;
      }
    }
  }

  if (
    !Number.isFinite(finalPrice) ||
    finalPrice <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "色別最終価格を数値化できません"
    };
  }

  return {
    found: true,

    price:
      finalPrice,

    raw_price:
      `${finalPrice.toLocaleString("ja-JP")}円`,

    base_price:
      basePrice,

    adjustment,

    caution:
      `基準${basePrice.toLocaleString("ja-JP")}円 / ${rule}を反映。店舗・時間限定条件は未反映`,

    error: null
  };
}


async function extractMobileMixPrice(
  page,
  productName
) {
  const rawBody =
    await page
      .locator("body")
      .innerText()
      .catch(() => "");

  const text =
    String(rawBody || "")
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizedName =
    String(productName || "")
      .replace(/\s+/g, " ")
      .trim();

  const colorMatch =
    normalizedName.match(
      /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/
    );

  const color =
    colorMatch
      ? colorMatch[1]
      : null;

  const target =
    normalizedName
      .replace(
        /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/,
        ""
      )
      .trim();

  const escapedTarget =
    target
      .split(/\s+/)
      .map(part =>
        part.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )
      )
      .join("\\s*");

  const pattern =
    new RegExp(
      escapedTarget +
      "\\s*" +
      "([0-9,]+)円" +
      "\\s*未開封\\s*" +
      "([\\s\\S]{0,180}?)" +
      "(?:買取申込|$)",
      "i"
    );

  const match =
    text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "Mobile MIX対象商品ブロックを取得できません"
    };
  }

  const basePrice =
    Number(
      match[1].replace(/,/g, "")
    );

  const conditionText =
    String(match[2] || "").trim();

  if (
    !Number.isFinite(basePrice) ||
    basePrice <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: conditionText,
      error:
        "Mobile MIX基準価格を数値化できません"
    };
  }

  let adjustment = 0;
  let rule = "全色・基準価格";

  const allColorMatch =
    conditionText.match(
      /全色\s*(?:△\s*)?([+-]\s*[0-9,]+)/
    );

  if (allColorMatch) {
    const value =
      Number(
        allColorMatch[1]
          .replace(/\s/g, "")
          .replace(/,/g, "")
      );

    if (Number.isFinite(value)) {
      adjustment = value;
      rule =
        `全色 ${value.toLocaleString("ja-JP")}円`;
    }
  }

  if (color) {
    const colorRule =
      /((?:ブラック|シルバー|グレイシャー?|バーガンディ)(?:\s*[,、､\/]\s*(?:ブラック|シルバー|グレイシャー?|バーガンディ))*)\s*(?:△\s*)?([+-]\s*[0-9,]+)/g;

    for (
      const m of conditionText.matchAll(colorRule)
    ) {
      const colors =
        m[1]
          .split(/[,、､\/]/)
          .map(x => x.trim())
          .map(x =>
            x === "グレイシャ"
              ? "グレイシャー"
              : x
          );

      if (!colors.includes(color)) {
        continue;
      }

      const value =
        Number(
          m[2]
            .replace(/\s/g, "")
            .replace(/,/g, "")
        );

      if (!Number.isFinite(value)) {
        return {
          found: true,
          price: null,
          raw_price: null,
          caution: conditionText,
          error:
            "Mobile MIX色別増減額を数値化できません"
        };
      }

      adjustment = value;

      rule =
        `${m[1]} ${value.toLocaleString("ja-JP")}円`;

      break;
    }
  }

  const finalPrice =
    basePrice + adjustment;

  if (
    !Number.isFinite(finalPrice) ||
    finalPrice <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: conditionText,
      error:
        "Mobile MIX最終価格を数値化できません"
    };
  }

  return {
    found: true,

    price:
      finalPrice,

    raw_price:
      `${finalPrice.toLocaleString("ja-JP")}円`,

    base_price:
      basePrice,

    adjustment,

    caution:
      `基準${basePrice.toLocaleString("ja-JP")}円 / ${rule}`,

    error: null
  };
}


function extractMobileIchibanPrice(
  bodyText,
  productName
) {
  const text =
    String(bodyText || "")
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ");

  const normalizedName =
    String(productName || "")
      .replace(/\s+/g, " ")
      .trim();

  const colorMatch =
    normalizedName.match(
      /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/
    );

  const color =
    colorMatch
      ? colorMatch[1]
      : null;

  const target =
    normalizedName
      .replace(
        /\s(ブラック|シルバー|グレイシャー|バーガンディ)$/,
        ""
      )
      .trim();

  const escaped =
    target.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  /*
   * 商品名
   * ↓
   * simfree未開封
   * ↓
   * 色別条件
   * ↓
   * 新品
   * ↓
   * 基準価格
   */
  const pattern =
    new RegExp(
      escaped +
      "\\s*" +
      "simfree未開封" +
      "([\\s\\S]{0,180}?)" +
      "新品\\s*" +
      "([0-9,]+)円",
      "i"
    );

  const match =
    text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "simfree未開封の新品価格を取得できません"
    };
  }

  const conditionText =
    String(match[1] || "");

  const basePrice =
    Number(
      match[2].replace(/,/g, "")
    );

  if (
    !Number.isFinite(basePrice) ||
    basePrice <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "基準価格を数値化できません"
    };
  }

  let adjustment = 0;
  let rule = "色別増減なし";

  if (color) {
    const colorRule =
      /((?:ブラック|シルバー|グレイシャー|バーガンディ)(?:\/(?:ブラック|シルバー|グレイシャー|バーガンディ))*)\s*([+-]\s*[0-9,]+)/g;

    for (
      const ruleMatch of
      conditionText.matchAll(colorRule)
    ) {
      const colors =
        ruleMatch[1].split("/");

      if (!colors.includes(color)) {
        continue;
      }

      const value =
        Number(
          ruleMatch[2]
            .replace(/\s/g, "")
            .replace(/,/g, "")
        );

      if (!Number.isFinite(value)) {
        return {
          found: true,
          price: null,
          raw_price: null,
          caution: conditionText.trim(),
          error:
            "色別増減額を数値化できません"
        };
      }

      adjustment = value;

      rule =
        `${ruleMatch[1]} ${value.toLocaleString("ja-JP")}円`;

      break;
    }
  }

  const finalPrice =
    basePrice + adjustment;

  if (
    !Number.isFinite(finalPrice) ||
    finalPrice <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "色別最終価格を数値化できません"
    };
  }

  return {
    found: true,

    price:
      finalPrice,

    raw_price:
      `${finalPrice.toLocaleString("ja-JP")}円`,

    base_price:
      basePrice,

    adjustment,

    caution:
      `基準${basePrice.toLocaleString("ja-JP")}円 / ${rule}`,

    error: null
  };
}


function extractKeitaiSpacePrice(
  bodyText,
  productName
) {
  const text =
    String(bodyText || "")
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ");

  const normalizedName =
    String(productName || "")
      .replace(/\s+/g, " ")
      .trim();

  const target =
    normalizedName
      .replace(
        /\s+(シルバー|ディープブルー|コズミックオレンジ|ブラック|グレイシャー|バーガンディ)$/i,
        ""
      )
      .trim();

  /*
   * 携帯空間では
   * iPhone18 Pro
   * iPhone 18 Pro Max
   * のように表記揺れがあるため吸収する。
   */
  let escaped =
    target.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  escaped =
    escaped.replace(
      /iPhone 18/i,
      "iPhone\\s*18"
    );

  const pattern =
    new RegExp(
      escaped +
      "\\s*" +
      "[\\s\\S]{0,120}?" +
      "未開封品\\s*" +
      "([0-9,]+)円",
      "i"
    );

  const match =
    text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "未開封品価格を取得できません"
    };
  }

  const price =
    Number(
      match[1].replace(/,/g, "")
    );

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return {
      found: true,
      price: null,
      raw_price: null,
      caution: "",
      error:
        "価格を数値化できません"
    };
  }

  return {
    found: true,

    price,

    raw_price:
      `${price.toLocaleString("ja-JP")}円`,

    caution:
      "未開封品価格を取得。元ページに色別増減表記なし",

    error: null
  };
}


function extractKaitoriShoutenPrice(
  bodyText,
  jan
) {
  const text = String(bodyText || "")
    .replace(/\r/g, "");

  const janText = String(jan || "").trim();

  const escapedJan = janText.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const pattern = new RegExp(
    "JAN:\\s*" +
    escapedJan +
    "[\\s\\S]{0,120}?" +
    "新品\\s*" +
    "¥?\\s*([0-9,]+)",
    "i"
  );

  const match = text.match(pattern);

  if (!match) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error:
        "JAN完全一致の新品価格を取得できません"
    };
  }

  const price = Number(
    match[1].replace(/,/g, "")
  );

  if (!Number.isFinite(price) || price <= 0) {
    return {
      found: true,
      price: null,
      raw_price: null,
      error:
        "新品価格を数値化できません"
    };
  }

  return {
    found: true,
    price,
    raw_price: `${match[1]}円`,
    error: null
  };
}

function extractMorimoriPrice(html, jan) {
  const janText = `JAN:${jan}`;

  const janIndex = html.indexOf(janText);

  if (janIndex === -1) {
    return {
      found: false,
      price: null,
      raw_price: null,
      error: "JAN完全一致の商品が見つかりません"
    };
  }

  const blockStart =
    html.lastIndexOf(
      'class="product-item search-product-item-height"',
      janIndex
    );

  const nextBlock =
    html.indexOf(
      'class="product-item search-product-item-height"',
      janIndex + janText.length
    );

  const blockEnd =
    nextBlock === -1 ? html.length : nextBlock;

  if (blockStart === -1) {
    return {
      found: true,
      price: null,
      raw_price: null,
      error: "JANの商品ブロックを特定できません"
    };
  }

  const block =
    html.slice(blockStart, blockEnd);

  const priceMatch =
    block.match(
      /class="price-normal-number"[^>]*>\s*([1-9]\d{1,2}(?:,\d{3})*)\s*円/
    );

  if (!priceMatch) {
    return {
      found: true,
      price: null,
      raw_price: null,
      error: "通常買取価格を取得できません"
    };
  }

  return {
    found: true,
    price: Number(
      priceMatch[1].replace(/,/g, "")
    ),
    raw_price: `${priceMatch[1]}円`,
    error: null
  };
}


const STATIC_STORE_CACHE = new Map();

const STATIC_CACHE_STORE_IDS = new Set([
  "rakuen",
  "mobileichiban",
  "keitaispace",
  "kaitorishouten"
]);


async function inspectStore(browser, store, item) {
  if (store.iphone18Only) {
    return null;
  }

  /*
   * iPhone 18 色別32SKUは、
   * JAN等で色を特定できる店舗だけ通常クロールする。
   */
  if (!IPHONE_18_COLOR_SAFE_STORE_IDS.has(store.id)) {
    return null;
  }

  /*
   * SMOKE=1 の場合は
   * Pro / Pro Max の256GBブラックだけ確認。
   */
  if (
    process.env.SMOKE === "1" &&
    !(
      item.storage === "256GB" &&
      item.color === "ブラック"
    )
  ) {
    return null;
  }

  const url = store.priceTableUrl || store.searchUrl(item.jan);

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

  if (store.id === "morimori") {
    try {
      console.log(
        `    ${store.name} → ${item.name}`
      );

      const fetched =
        await fetchMorimoriHtml(url);

      diagnostic.http.status =
        fetched.status;

      diagnostic.http.ok =
        fetched.status !== null &&
        fetched.status >= 200 &&
        fetched.status < 300;

      diagnostic.http.final_url =
        fetched.final_url;

      diagnostic.page.body_length =
        fetched.body.length;

      diagnostic.page.body_available =
        fetched.body.length > 0;

      const titleMatch =
        fetched.body.match(
          /<title[^>]*>([\s\S]*?)<\/title>/i
        );

      diagnostic.page.title =
        titleMatch
          ? normalizeText(titleMatch[1])
          : null;

      const extracted =
        extractMorimoriPrice(
          fetched.body,
          item.jan
        );

      diagnostic.product.jan_found =
        extracted.found;

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price;

      diagnostic.caution = "";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

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

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

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
    }

    return diagnostic;
  }
 
 const page = await browser.newPage();


  try {

    console.log(
      `    ${store.name} → ${item.name}`
    );


    /*
 * ページアクセス
 */

let response;
let cachedStatic = null;

if (
  STATIC_CACHE_STORE_IDS.has(store.id) &&
  STATIC_STORE_CACHE.has(store.id)
) {
  cachedStatic = STATIC_STORE_CACHE.get(store.id);

  response = {
    status: () => cachedStatic.status,
    ok: () => cachedStatic.ok
  };
} else {
  response = await page.goto(
    url,
    {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.pageTimeout
    }
  );
}


/*
 * HTTP情報
 */

    diagnostic.http.status =
      response ? response.status() : null;

    diagnostic.http.ok =
      response ? response.ok() : false;

    diagnostic.http.final_url =
      cachedStatic
        ? cachedStatic.final_url
        : page.url();


    /*
     * JavaScript描画待ち
     *
     * キャッシュ利用時は既に取得済みなので待たない
     */

    if (!cachedStatic) {
      await page.waitForTimeout(
        CONFIG.waitAfterLoad
      );
    }


    /*
     * タイトル
     */

    diagnostic.page.title =
      cachedStatic
        ? cachedStatic.title
        : await page.title().catch(() => null);


    /*
     * 本文
     */

    let bodyText;

    if (cachedStatic) {
      bodyText = cachedStatic.bodyText;

      diagnostic.http.final_url =
        cachedStatic.final_url;
    } else {
      bodyText =
        await page
          .locator("body")
          .innerText()
          .catch(() => "");

      if (STATIC_CACHE_STORE_IDS.has(store.id)) {
        STATIC_STORE_CACHE.set(
          store.id,
          {
            status:
              response ? response.status() : null,
            ok:
              response ? response.ok() : false,
            final_url: page.url(),
            title:
              await page.title().catch(() => null),
            bodyText
          }
        );
      }
    }


    diagnostic.page.body_length =
      bodyText.length;

    diagnostic.page.body_available =
      bodyText.length > 0;


    /*
     * 商品確認
     */


    if (store.id === "kaitorishouten") {
      const extracted =
        extractKaitoriShoutenPrice(
          bodyText,
          item.jan
        );

      diagnostic.product.jan_found =
        extracted.found;

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price;

      diagnostic.caution =
        "JAN完全一致の商品から新品価格を取得";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

    }

    else if (store.id === "keitaispace") {
      const extracted =
        extractKeitaiSpacePrice(
          bodyText,
          item.name
        );

      diagnostic.product.jan_found = false;
      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price;

      diagnostic.caution =
        extracted.caution ||
        "未開封品価格を取得。中古品価格は対象外";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

    }

    else if (store.id === "mobileichiban") {
      const extracted =
        extractMobileIchibanPrice(
          bodyText,
          item.name
        );

      diagnostic.product.jan_found = false;
      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price;

      diagnostic.caution =
        extracted.caution || "";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

    }

    else if (store.id === "mobilemix") {
      const extracted =
        await extractMobileMixPrice(
          page,
          item.name
        );

      diagnostic.product.jan_found = false;

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price || null;

      diagnostic.caution =
        extracted.caution || "";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw:
                extracted.raw_price || "",
              price:
                extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

    }

    else if (store.id === "rakuen") {
      const extracted =
        extractRakuenPrice(
          bodyText,
          item.name
        );

      diagnostic.product.jan_found = false;

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price || null;

      diagnostic.caution =
        extracted.caution || "";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }
    }

    else if (store.id === "rudeya") {
      const extracted =
        extractRudeyaPrice(
          bodyText,
          item.jan
        );

      diagnostic.product.jan_found =
        bodyText.includes(item.jan);

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price || null;

      diagnostic.caution =
        "新品・未開封商品の通常買取価格のみ取得。郵送キャンペーン加算なし";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }
    }

    else if (store.id === "homura") {
      const extracted =
        extractHomuraPrice(
          bodyText,
          item.name
        );

      diagnostic.product.jan_found =
        bodyText.includes(item.jan);

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price || null;

      diagnostic.caution =
        "【未開封】商品の買取金額（税込）のみ取得";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }
    }

    else if (store.id === "mobasute") {
      const mobasuteName =
        toMobasute17Name(item.name);

      const baseExtracted =
        await extractMobasutePrice(
          page,
          mobasuteName
        );

      const extracted =
        applyMobasuteColorAdjustment(
          baseExtracted,
          item.color
        );

      diagnostic.product.jan_found = false;
      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price || null;

      diagnostic.caution =
        extracted.adjustment
          ? `基準${extracted.base_price.toLocaleString("ja-JP")}円 / ${item.color} ${extracted.adjustment.toLocaleString("ja-JP")}円を反映 / ${extracted.caution || ""}`
          : extracted.caution || "元店舗の未開封基準価格";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

        } else if (store.id === "ichome") {
      const extracted =
        extractIchomePrice(
          bodyText,
          item.name
        );

      diagnostic.product.jan_found = false;
      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price || null;

      diagnostic.caution =
        extracted.caution || "";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

       
    } else if (store.id === "kaitoriwiki") {
      const extracted =
        extractKaitoriWikiPrice(
          bodyText,
          item.name
        );

      diagnostic.product.jan_found =
        extracted.found;

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price;

      diagnostic.caution =
        "買取wiki検索結果の掲載買取価格";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

    } else if (store.id === "iosys") {
      const extracted =
        extractIosysPrice(
          bodyText,
          item.name
        );

      diagnostic.product.jan_found =
        false;

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price;

      diagnostic.caution = "";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

    } else if (store.id === "iphonekaitori") {
      const extracted =
        extractIphoneKaitoriPrice(
          bodyText,
          item.jan
        );

      diagnostic.product.jan_found =
        extracted.found;

      diagnostic.product.name_found =
        extracted.found;

      diagnostic.price =
        extracted.price;

      diagnostic.raw_price =
        extracted.raw_price;

      diagnostic.caution = "";

      diagnostic.price_candidates =
        extracted.price !== null
          ? [{
              raw: extracted.raw_price || "",
              price: extracted.price
            }]
          : [];

      if (extracted.error) {
        diagnostic.errors.push(
          extracted.error
        );
      }

    } else {
      diagnostic.product.jan_found =
        containsJan(bodyText, item.jan);

      diagnostic.product.name_found =
        containsProductName(
          bodyText,
          item.name
        );

      diagnostic.price_candidates =
        extractPriceCandidates(bodyText);
    }

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

function updatePricesJsonSafely(diagnostics) {
  const targetJans =
    Array.isArray(diagnostics.targets)
      ? diagnostics.targets
          .map(item => String(item.jan || ""))
          .filter(Boolean)
      : [];

  const uniqueTargetJans =
    [...new Set(targetJans)];

  if (
    targetJans.length !== 32 ||
    uniqueTargetJans.length !== 32
  ) {
    return {
      updated: false,
      reason:
        `対象JAN異常: total=${targetJans.length}, unique=${uniqueTargetJans.length}`
    };
  }

  const validRows =
    diagnostics.stores.filter(result =>
      result &&
      result.jan &&
      PRICE_OUTPUT_STORE_IDS.includes(
        result.store_id
      ) &&
      result.status === "OK" &&
      Number.isFinite(Number(result.price)) &&
      Number(result.price) > 0
    );

  const expectedStoreCount =
    PRICE_OUTPUT_STORE_IDS.length;

  const expectedPriceCount =
    32 * expectedStoreCount;

  if (
    validRows.length !==
    expectedPriceCount
  ) {
    return {
      updated: false,
      reason:
        `価格レコード数異常: ${validRows.length}/${expectedPriceCount}`
    };
  }

  const byJan = new Map();

  for (const jan of uniqueTargetJans) {
    byJan.set(jan, []);
  }

  for (const row of validRows) {
    const jan = String(row.jan);

    if (!byJan.has(jan)) {
      return {
        updated: false,
        reason:
          `対象外JANを検出: ${jan}`
      };
    }

    byJan.get(jan).push(row);
  }

  const prices = {};

  for (const jan of uniqueTargetJans) {
    const rows = byJan.get(jan) || [];

    const storeIds =
      new Set(
        rows.map(row => row.store_id)
      );

    if (
      rows.length !== expectedStoreCount ||
      storeIds.size !== expectedStoreCount
    ) {
      return {
        updated: false,
        reason:
          `${jan}: 店舗数異常 rows=${rows.length}, unique=${storeIds.size}, expected=${expectedStoreCount}`
      };
    }

    for (
      const requiredId
      of PRICE_OUTPUT_STORE_IDS
    ) {
      if (!storeIds.has(requiredId)) {
        return {
          updated: false,
          reason:
            `${jan}: ${requiredId} が不足`
        };
      }
    }

    prices[jan] = {
      stores:
        rows
          .map(row => ({
            store: row.store,
            price: Number(row.price),
            url: row.url,
            condition: "unopened",
            scope: "jan"
          }))
          .sort(
            (a, b) =>
              b.price - a.price
          ),

      last_update:
        diagnostics.finished_at || nowJST()
    };
  }

  if (
    Object.keys(prices).length !== 32
  ) {
    return {
      updated: false,
      reason:
        `出力SKU数異常: ${Object.keys(prices).length}/32`
    };
  }

  const tmpPath =
    `${PRICES_PATH}.tmp`;

  fs.writeFileSync(
    tmpPath,
    JSON.stringify(
      prices,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    tmpPath,
    PRICES_PATH
  );

  return {
    updated: true,
    reason: null,
    sku_count: 32,
    price_count:
      expectedPriceCount
  };
}




function mergeIPhone17PricesSafely(candidatePrices) {
  const targets = loadIPhone17TargetsFromMaster();
  const allowedJans =
    new Set(targets.map(item => String(item.jan)));

  if (
    !candidatePrices ||
    typeof candidatePrices !== "object" ||
    Array.isArray(candidatePrices)
  ) {
    return {
      updated: false,
      reason: "17シリーズ候補価格データが不正"
    };
  }

  const currentPrices = JSON.parse(
    fs.readFileSync(PRICES_PATH, "utf8")
  );

  const mergedPrices = {
    ...currentPrices
  };

  let updatedSkuCount = 0;
  let priceCount = 0;

  for (const [jan, item] of Object.entries(candidatePrices)) {
    const normalizedJan = String(jan);

    if (!allowedJans.has(normalizedJan)) {
      return {
        updated: false,
        reason: `17シリーズ対象外JANを検出: ${normalizedJan}`
      };
    }

    if (!item || !Array.isArray(item.stores)) {
      continue;
    }

    const seenStores = new Set();

    const validStores = item.stores
      .filter(store => {
        const price = Number(store.price);
        const storeName = String(store.store || "").trim();

        if (!storeName) return false;
        if (!Number.isFinite(price)) return false;
        if (price < 50000 || price > 400000) return false;
        if (seenStores.has(storeName)) return false;

        seenStores.add(storeName);
        return true;
      })
      .map(store => ({
        store: String(store.store),
        price: Number(store.price),
        url: String(store.url || ""),
        condition: "unopened",
        scope: "jan"
      }))
      .sort((a, b) => b.price - a.price);

    // 価格を1店舗も確認できないSKUは、
    // 既存価格を消さず今回は更新しない
    if (validStores.length === 0) {
      continue;
    }

    mergedPrices[normalizedJan] = {
      stores: validStores,
      last_update: item.last_update || nowJST()
    };

    updatedSkuCount++;
    priceCount += validStores.length;
  }

  if (updatedSkuCount === 0) {
    return {
      updated: false,
      reason: "17シリーズで更新可能な価格が0件"
    };
  }

  const tmpPath = `${PRICES_PATH}.17.tmp`;

  fs.writeFileSync(
    tmpPath,
    JSON.stringify(mergedPrices, null, 2) + "\n",
    "utf8"
  );

  // 書き込んだJSONを再読込できることを確認してから置換
  const verify = JSON.parse(
    fs.readFileSync(tmpPath, "utf8")
  );

  if (Object.keys(verify).length < Object.keys(currentPrices).length) {
    fs.unlinkSync(tmpPath);

    return {
      updated: false,
      reason: "17シリーズマージ後に既存SKUが減少したため中止"
    };
  }

  fs.renameSync(
    tmpPath,
    PRICES_PATH
  );

  return {
    updated: true,
    reason: null,
    sku_count: updatedSkuCount,
    price_count: priceCount,
    total_sku_count: Object.keys(mergedPrices).length
  };
}


function loadIPhone17TargetsFromMaster() {
  const masterPath = path.join(
    ROOT_DIR,
    "data",
    "product_master.json"
  );

  const master = JSON.parse(
    fs.readFileSync(masterPath, "utf8")
  );

  const targets = [];

  for (const [model, storages] of Object.entries(master)) {
    if (!model.startsWith("iPhone 17")) {
      continue;
    }

    for (const [storage, colors] of Object.entries(storages)) {
      for (const [color, jan] of Object.entries(colors)) {
        targets.push({
          jan: String(jan),
          name: `${model} ${storage} ${color}`,
          model,
          storage,
          color
        });
      }
    }
  }

  const uniqueJans =
    new Set(targets.map(item => item.jan));

  if (
    targets.length === 0 ||
    uniqueJans.size !== targets.length
  ) {
    throw new Error(
      `iPhone 17 商品マスター異常: total=${targets.length}, unique=${uniqueJans.size}`
    );
  }

  return targets;
}



async function crawlIPhone17Prices() {
  const targets = loadIPhone17TargetsFromMaster();

  const browser = await chromium.launch({
    headless: true
  });

  const collectedPrices = {};

  try {
    for (const item of targets) {
      const stores = [];

      console.log("");
      console.log("==========================================");
      console.log(`商品: ${item.name}`);
      console.log(`JAN: ${item.jan}`);
      console.log("==========================================");

      for (const store of STORES) {
        if (store.deferred || store.iphone18Only) {
          continue;
        }

        try {
          const result =
            await inspectStore(browser, store, item);

          if (!result || !result.price) {
            console.log(
              `${store.name}: PRICE NOT FOUND / 取扱なし`
            );
            continue;
          }

          const price = Number(result.price);

          if (
            !Number.isFinite(price) ||
            price < 50000 ||
            price > 400000
          ) {
            console.log(
              `${store.name}: 異常価格を除外 ${result.price}`
            );
            continue;
          }

          console.log(
            `${store.name}: ¥${price.toLocaleString()}`
          );

          stores.push({
            store: store.name,
            price,
            url: result.url || result.final_url || ""
          });
        } catch (error) {
          console.log(
            `${store.name}: ERROR - ${error.message}`
          );
        }
      }

      if (stores.length > 0) {
        collectedPrices[item.jan] = {
          name: item.name,
          stores,
          last_update: nowJST()
        };
      }
    }
  } finally {
    await browser.close();
  }

  return {
    targets,
    collectedPrices
  };
}


async function runIPhone17Smoke() {
  console.log("");
  console.log("==========================================");
  console.log(" iPhone 17 SERIES DIAGNOSTIC");
  console.log("==========================================");
  console.log("prices.json は更新しません");
  console.log("");

  const {
    targets,
    collectedPrices
  } = await crawlIPhone17Prices();

  const outputPath = path.join(
    ROOT_DIR,
    "data",
    "prices_17_candidate.json"
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(collectedPrices, null, 2),
    "utf8"
  );

  console.log("");
  console.log(
    `17候補価格保存: ${outputPath}`
  );
  console.log(
    `価格取得SKU: ${Object.keys(collectedPrices).length}/${targets.length}`
  );
  console.log("");
  console.log("17シリーズ診断完了");
  console.log("prices.json は変更していません");
}


async function run() {

  /*
   * 通常JANクロール対象
   *
   * iPhone 17 無印だけに限定
   * 18 Pro / 18 Pro Max は下部の専用処理で取得
   */
  const indexHtml18 =
    fs.readFileSync(
      path.join(ROOT_DIR, "index.html"),
      "utf8"
    );

  const activeTargetJans = [];

  const jan18Pattern =
    /"(iPhone 18 Pro(?: Max)?_(?:256GB|512GB|1TB|2TB)_(?:ブラック|シルバー|バーガンディ|グレイシャー))"\s*:\s*"(\d{13})"/g;

  for (const match of indexHtml18.matchAll(jan18Pattern)) {
    const parts = match[1].split("_");

    const model = parts[0];
    const storage = parts[1];
    const color = parts[2];

    activeTargetJans.push({
      jan: match[2],
      name: `${model} ${storage} ${color}`,
      model,
      storage,
      color
    });
  }

  if (activeTargetJans.length !== 32) {
    throw new Error(
      `iPhone 18 SKU数異常: ${activeTargetJans.length}件`
    );
  }

  if (
    new Set(
      activeTargetJans.map(item => item.jan)
    ).size !== 32
  ) {
    throw new Error(
      "iPhone 18 JANに重複があります"
    );
  }console.log("");
  console.log("==========================================");
  console.log(" iPhone 買取価格クローラー");
  console.log(" 安全診断モード");
  console.log("==========================================");
  console.log("");

  console.log(
    `対象商品: ${activeTargetJans.length}件（iPhone 18 Pro / Pro Max）`
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
      activeTargetJans.length,

    targets:
      activeTargetJans,


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
      const item of activeTargetJans
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

        if (store.deferred) {
          continue;
        }

        const result =
          await inspectStore(
            browser,
            store,
            item
          );


        if (!result) {
          continue;
        }

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




    /*
     * iPhone 18 Pro / Pro Max
     * モバステ商品名検索
     * JANは使用しない
     */
    /*
     * iPhone 18 Pro / Pro Max
     * アメモバ 国内版SIMフリー
     * 未開封買取価格のみ
     * JANは使用しない
     */
    const amemobaStore = STORES.find(
      store => store.id === "amemoba"
    );

    if (amemobaStore) {
      const amemobaPages = new Map();

      try {
        for (const item of IPHONE_18_MOBA_TARGETS) {
          console.log(
            `\n[PRODUCT 18 AMEMOBA] ${item.name}`
          );

          const targetUrl =
            getAmemoba18Url(item.name);

          if (!targetUrl) {
            diagnostics.stores.push({
              store_id: amemobaStore.id,
              store: amemobaStore.name,
              jan: null,
              product_name: item.name,
              url: null,
              checked_at: nowJST(),
              status: "ERROR",
              http: {
                status: null,
                ok: false,
                final_url: null
              },
              product: {
                jan_found: false,
                name_found: false
              },
              price: null,
              raw_price: null,
              caution:
                "国内版SIMフリー・未開封買取価格のみ",
              price_candidates: [],
              errors: [
                "アメモバ対象URLを特定できません"
              ]
            });
            continue;
          }

          let cached =
            amemobaPages.get(targetUrl);

          if (!cached) {
            const page =
              await browser.newPage();

            const response =
              await page.goto(
                targetUrl,
                {
                  waitUntil: "domcontentloaded",
                  timeout: CONFIG.pageTimeout
                }
              );

            await page.waitForTimeout(
              CONFIG.waitAfterLoad
            );

            const bodyText =
              await page.locator("body").innerText();

            cached = {
              page,
              response,
              bodyText
            };

            amemobaPages.set(
              targetUrl,
              cached
            );
          }

          const extracted =
            extractAmemoba18Price(
              cached.bodyText,
              item.name
            );

          const result = {
            store_id: amemobaStore.id,
            store: amemobaStore.name,
            jan: null,
            product_name: item.name,
            url: targetUrl,
            checked_at: nowJST(),
            status:
              cached.response &&
              cached.response.ok() &&
              extracted.price !== null
                ? "OK"
                : "ERROR",
            http: {
              status: cached.response
                ? cached.response.status()
                : null,
              ok: cached.response
                ? cached.response.ok()
                : false,
              final_url:
                cached.page.url()
            },
            product: {
              jan_found: false,
              name_found:
                extracted.found
            },
            price:
              extracted.price,
            raw_price:
              extracted.raw_price,
            caution:
              "国内版SIMフリー・未開封買取価格のみ",
            price_candidates:
              extracted.price !== null
                ? [{
                    raw:
                      extracted.raw_price || "",
                    price:
                      extracted.price
                  }]
                : [],
            errors:
              extracted.error
                ? [extracted.error]
                : []
          };

          diagnostics.stores.push(result);

          if (result.status === "OK") {
            diagnostics.summary.ok++;
          } else {
            diagnostics.summary.error++;
          }

          if (result.product.name_found) {
            diagnostics.summary.product_name_found++;
          }

          if (result.price_candidates.length > 0) {
            diagnostics.summary.price_candidate_found++;
          }

          console.log(
            `  [アメモバ] ${result.raw_price || "取得失敗"}`
          );
        }
      } finally {
        for (
          const cached
          of amemobaPages.values()
        ) {
          await cached.page.close();
        }
      }
    }

    const mobasuteStore = STORES.find(
      store => store.id === "mobasute"
    );

    if (!mobasuteStore) {
      throw new Error("モバステ設定が見つかりません");
    }

    const page18 = await browser.newPage();

    try {
      const response18 = await page18.goto(
        mobasuteStore.priceTableUrl,
        {
          waitUntil: "domcontentloaded",
          timeout: CONFIG.pageTimeout
        }
      );

      await page18.waitForTimeout(
        CONFIG.waitAfterLoad
      );

      for (const item of IPHONE_18_MOBA_TARGETS) {
        console.log(
          `\n[PRODUCT 18] ${item.name}`
        );

        const extracted =
          await extractMobasutePrice(
            page18,
            item.name
          );

        const result = {
          store_id: mobasuteStore.id,
          store: mobasuteStore.name,
          jan: null,
          product_name: item.name,
          url: mobasuteStore.priceTableUrl,
          checked_at: nowJST(),

          status:
            response18 &&
            response18.ok() &&
            extracted.price !== null
              ? "OK"
              : "ERROR",

          http: {
            status: response18
              ? response18.status()
              : null,
            ok: response18
              ? response18.ok()
              : false,
            final_url: page18.url()
          },

          product: {
            jan_found: false,
            name_found: extracted.found
          },

          price: extracted.price,
          raw_price: extracted.raw_price || null,
          caution: extracted.caution || "",

          price_candidates:
            extracted.price !== null
              ? [{
                  raw: extracted.raw_price || "",
                  price: extracted.price
                }]
              : [],

          errors: []
        };

        if (!response18 || !response18.ok()) {
          result.errors.push(
            `HTTP status ${
              response18
                ? response18.status()
                : "null"
            }`
          );
        }

        if (extracted.error) {
          result.errors.push(extracted.error);
        }

        diagnostics.stores.push(result);

        if (result.status === "OK") {
          diagnostics.summary.ok++;
        } else {
          diagnostics.summary.error++;
        }

        if (result.product.name_found) {
          diagnostics.summary.product_name_found++;
        }

        if (result.price_candidates.length > 0) {
          diagnostics.summary.price_candidate_found++;
        }

        console.log(
          `      HTTP: ${result.http.status}`
        );

        console.log(
          `      NAME: ${
            result.product.name_found
              ? "FOUND"
              : "NOT FOUND"
          }`
        );

        console.log(
          `      PRICE: ${
            result.price !== null
              ? result.price
              : "NOT FOUND"
          }`
        );

        if (result.raw_price) {
          console.log(
            `      RAW PRICE: ${result.raw_price}`
          );
        }

        if (result.errors.length > 0) {
          console.log(
            `      ERROR: ${result.errors.join(" / ")}`
          );
        }
      }

    } finally {
      await page18.close().catch(() => {});
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
   * 32 SKU × 6店舗が全件成功した時だけ
   * prices.json を原子的に更新する。
   */
  const pricesUpdate =
    updatePricesJsonSafely(
      diagnostics
    );

  diagnostics.safety.prices_json_modified =
    pricesUpdate.updated;

  diagnostics.prices_update =
    pricesUpdate;


  /*
   * iPhone 17シリーズ
   *
   * 18シリーズの安全更新処理とは分離する。
   * 取得できた店舗の実価格だけを既存prices.jsonへマージし、
   * 取得できなかったSKU・店舗の既存価格は削除しない。
   */
  let iphone17Update = {
    updated: false,
    reason: "18シリーズ更新失敗のため17シリーズ更新を実行せず"
  };

  if (pricesUpdate.updated) {
    try {
      console.log("");
      console.log("==========================================");
      console.log(" iPhone 17 SERIES UPDATE");
      console.log("==========================================");

      const {
        targets: iphone17Targets,
        collectedPrices: iphone17Prices
      } = await crawlIPhone17Prices();

      console.log(
        `17シリーズ価格取得SKU: ${Object.keys(iphone17Prices).length}/${iphone17Targets.length}`
      );

      iphone17Update =
        mergeIPhone17PricesSafely(
          iphone17Prices
        );

      console.log(
        iphone17Update.updated
          ? `17シリーズ更新完了: ${iphone17Update.sku_count} SKU / ${iphone17Update.price_count}価格 / 合計${iphone17Update.total_sku_count} SKU`
          : `17シリーズ更新中止: ${iphone17Update.reason}`
      );
    } catch (error) {
      iphone17Update = {
        updated: false,
        reason:
          error && error.message
            ? error.message
            : String(error)
      };

      console.error(
        `17シリーズ更新エラー: ${iphone17Update.reason}`
      );
    }
  }

  diagnostics.iphone17_update =
    iphone17Update;


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
    diagnostics.safety.prices_json_modified
      ? "prices.json: UPDATED"
      : "prices.json: NOT MODIFIED"
  );

  if (
    diagnostics.prices_update &&
    diagnostics.prices_update.reason
  ) {
    console.log(
      `prices.json理由: ${diagnostics.prices_update.reason}`
    );
  }

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

const mainRunner =
  process.env.IPHONE17_SMOKE === "1"
    ? runIPhone17Smoke
    : run;

mainRunner().catch(error => {

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
