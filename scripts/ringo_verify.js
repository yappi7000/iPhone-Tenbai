const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR =
  path.resolve(__dirname, '..');

const AUTH_DIR =
  path.join(
    ROOT_DIR,
    '.auth',
    'ringonodorei'
  );

const INDEX_PATH =
  path.join(
    ROOT_DIR,
    'index.html'
  );

const PRICES_PATH =
  path.join(
    ROOT_DIR,
    'data',
    'prices.json'
  );

const SNAPSHOT_PATH =
  path.join(
    ROOT_DIR,
    'data',
    'ringo_snapshot.json'
  );

const VERIFY_PATH =
  path.join(
    ROOT_DIR,
    'data',
    'price_verification.json'
  );

const TOOL_URL =
  'https://' +
  'ringonodorei.com' +
  '/admin/purchase-price-tool';


function nowJST() {
  return new Date().toLocaleString(
    'ja-JP',
    {
      timeZone: 'Asia/Tokyo'
    }
  );
}


function normalize(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function loadJanMap() {
  const html =
    fs.readFileSync(
      INDEX_PATH,
      'utf8'
    );

  const map = new Map();

  const pattern =
    /"(iPhone 18 Pro(?: Max)?_(?:256GB|512GB|1TB|2TB)_(?:ブラック|シルバー|バーガンディ|グレイシャー))"\s*:\s*"(\d{13})"/g;

  for (
    const match of html.matchAll(pattern)
  ) {
    map.set(
      match[1],
      match[2]
    );
  }

  if (map.size !== 32) {
    throw new Error(
      `JAN_DATABASE異常: ${map.size}/32`
    );
  }

  return map;
}


function parseSku(text) {
  const value =
    normalize(text);

  let model = null;

  if (
    /iPhone\s*18\s*Pro\s*Max/i.test(
      value
    )
  ) {
    model = 'iPhone 18 Pro Max';
  } else if (
    /iPhone\s*18\s*Pro/i.test(
      value
    )
  ) {
    model = 'iPhone 18 Pro';
  }

  const storageMatch =
    value.match(
      /(256GB|512GB|1TB|2TB)/i
    );

  const colorMatch =
    value.match(
      /(ブラック|シルバー|バーガンディ|グレイシャー)/
    );

  if (
    !model ||
    !storageMatch ||
    !colorMatch
  ) {
    return null;
  }

  const storage =
    storageMatch[1];

  const color =
    colorMatch[1];

  return {
    model,
    storage,
    color,
    key:
      `${model}_${storage}_${color}`
  };
}


function parsePriceCell(raw) {
  const text =
    normalize(raw);

  const priceMatch =
    text.match(
      /([1-9]\d{1,2}(?:,\d{3})+)\s*円/
    );

  let price = null;

  if (priceMatch) {
    price =
      Number(
        priceMatch[1]
          .replace(/,/g, '')
      );
  }

  const changeMatch =
    text.match(
      /\(([+\-−]?\s*[0-9,]+)\s*円\)/
    );

  let change = null;

  if (changeMatch) {
    const normalizedChange =
      changeMatch[1]
        .replace(/−/g, '-')
        .replace(/\s/g, '')
        .replace(/,/g, '');

    const value =
      Number(normalizedChange);

    if (Number.isFinite(value)) {
      change = value;
    }
  }

  return {
    price:
      Number.isFinite(price)
        ? price
        : null,

    change,

    raw:
      text
  };
}


(async () => {
  const janMap =
    loadJanMap();

  const context =
    await chromium.launchPersistentContext(
      AUTH_DIR,
      {
        headless: true
      }
    );

  try {
    const pages =
      context.pages();

    const page =
      pages[0] ||
      await context.newPage();

    await page.goto(
      TOOL_URL,
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    );

    await page.waitForTimeout(1200);

    if (
      page.url().includes(
        '/admin/login'
      )
    ) {
      throw new Error(
        'りんごの奴隷のログイン期限が切れています。npm run ringo:login を実行してください'
      );
    }

    const table =
      page.locator('table').first();

    if (
      await table.count() === 0
    ) {
      throw new Error(
        '価格比較テーブルが見つかりません'
      );
    }

    const headerTexts =
      await table
        .locator('thead th')
        .allInnerTexts();

    const headers =
      headerTexts.map(normalize);

    if (headers.length !== 15) {
      throw new Error(
        `テーブル列数異常: ${headers.length}/15`
      );
    }

    const storeNames =
      headers.slice(2);

    if (storeNames.length !== 13) {
      throw new Error(
        `店舗列数異常: ${storeNames.length}/13`
      );
    }

    const allRows =
      table.locator('tbody tr');

    const rowCount =
      await allRows.count();

    const parsedItems = [];

    for (
      let i = 0;
      i < rowCount;
      i++
    ) {
      const row =
        allRows.nth(i);

      const cells =
        await row
          .locator('td')
          .allInnerTexts();

      if (cells.length !== 15) {
        continue;
      }

      const sku =
        parseSku(cells[0]);

      if (!sku) {
        continue;
      }

      const jan =
        janMap.get(sku.key);

      if (!jan) {
        throw new Error(
          `JAN未登録: ${sku.key}`
        );
      }

      const stores = [];

      for (
        let j = 0;
        j < storeNames.length;
        j++
      ) {
        const parsed =
          parsePriceCell(
            cells[j + 2]
          );

        stores.push({
          store:
            storeNames[j],

          price:
            parsed.price,

          change:
            parsed.change,

          raw:
            parsed.raw
        });
      }

      parsedItems.push({
        jan,
        model:
          sku.model,
        storage:
          sku.storage,
        color:
          sku.color,
        sku_key:
          sku.key,
        stores
      });
    }

    if (parsedItems.length !== 32) {
      throw new Error(
        `SKU行数異常: ${parsedItems.length}/32`
      );
    }

    const uniqueJans =
      new Set(
        parsedItems.map(x => x.jan)
      );

    if (uniqueJans.size !== 32) {
      throw new Error(
        `JAN重複または不足: ${uniqueJans.size}/32`
      );
    }

    const body =
      await page
        .locator('body')
        .innerText();

    const updatedMatch =
      body.match(
        /最終更新[：:]\s*([^\n]+)/
      );

    const snapshot = {
      source:
        'りんごの奴隷',

      source_updated_at:
        updatedMatch
          ? normalize(updatedMatch[1])
          : null,

      fetched_at:
        nowJST(),

      sku_count:
        32,

      store_count:
        storeNames.length,

      stores:
        storeNames,

      items: {}
    };

    let ringoPriceCount = 0;

    for (
      const item of parsedItems
    ) {
      snapshot.items[item.jan] =
        item;

      ringoPriceCount +=
        item.stores.filter(
          x =>
            Number.isFinite(
              x.price
            )
        ).length;
    }

    fs.writeFileSync(
      SNAPSHOT_PATH,
      JSON.stringify(
        snapshot,
        null,
        2
      ) + '\n'
    );

    const direct =
      JSON.parse(
        fs.readFileSync(
          PRICES_PATH,
          'utf8'
        )
      );

    const overlap = [
      ['森森買取', '森森'],
      ['買取一丁目', '買取一丁目'],
      ['買取ホムラ', '買取ホムラ'],
      ['買取ルデヤ', '買取ルデヤ'],
      ['買取楽園', '買取楽園'],
      ['買取wiki', '買取WIKI'],
      ['モバステ', 'モバステ'],
      ['買取商店', '買取商店'],
      ['モバイルMIX', 'Mobile MIX'],
      ['モバイル一番', 'モバイル一番'],
      ['携帯空間', '携帯空間']
    ];

    const normalizeStore =
      value =>
        normalize(value)
          .toLowerCase();

    const results = [];

    const perStore = {};

    for (
      const [directName, ringoName]
      of overlap
    ) {
      perStore[directName] = {
        compared: 0,
        exact: 0,
        diff: 0,
        direct_only: 0,
        ringo_only: 0,
        both_missing: 0
      };
    }

    for (
      const jan of uniqueJans
    ) {
      const directStores =
        Array.isArray(
          direct[jan]?.stores
        )
          ? direct[jan].stores
          : [];

      const ringoItem =
        snapshot.items[jan];

      for (
        const [
          directName,
          ringoName
        ]
        of overlap
      ) {
        const directRow =
          directStores.find(
            x =>
              normalizeStore(
                x.store
              ) ===
              normalizeStore(
                directName
              )
          );

        const ringoRow =
          ringoItem.stores.find(
            x =>
              normalizeStore(
                x.store
              ) ===
              normalizeStore(
                ringoName
              )
          );

        const directPrice =
          Number.isFinite(
            Number(
              directRow?.price
            )
          )
            ? Number(
                directRow.price
              )
            : null;

        const ringoPrice =
          Number.isFinite(
            Number(
              ringoRow?.price
            )
          )
            ? Number(
                ringoRow.price
              )
            : null;

        let status;

        if (
          directPrice !== null &&
          ringoPrice !== null
        ) {
          perStore[
            directName
          ].compared++;

          if (
            directPrice ===
            ringoPrice
          ) {
            status = 'EXACT';

            perStore[
              directName
            ].exact++;
          } else {
            status = 'DIFF';

            perStore[
              directName
            ].diff++;
          }
        } else if (
          directPrice !== null
        ) {
          status =
            'DIRECT_ONLY';

          perStore[
            directName
          ].direct_only++;
        } else if (
          ringoPrice !== null
        ) {
          status =
            'RINGO_ONLY';

          perStore[
            directName
          ].ringo_only++;
        } else {
          status =
            'BOTH_MISSING';

          perStore[
            directName
          ].both_missing++;
        }

        results.push({
          jan,

          model:
            ringoItem.model,

          storage:
            ringoItem.storage,

          color:
            ringoItem.color,

          direct_store:
            directName,

          ringo_store:
            ringoName,

          direct_price:
            directPrice,

          ringo_price:
            ringoPrice,

          difference:
            directPrice !== null &&
            ringoPrice !== null
              ? directPrice -
                ringoPrice
              : null,

          status
        });
      }
    }

    const summary = {
      expected_overlap:
        32 * overlap.length,

      total:
        results.length,

      compared:
        results.filter(
          x =>
            x.direct_price !== null &&
            x.ringo_price !== null
        ).length,

      exact:
        results.filter(
          x => x.status === 'EXACT'
        ).length,

      diff:
        results.filter(
          x => x.status === 'DIFF'
        ).length,

      direct_only:
        results.filter(
          x =>
            x.status ===
            'DIRECT_ONLY'
        ).length,

      ringo_only:
        results.filter(
          x =>
            x.status ===
            'RINGO_ONLY'
        ).length,

      both_missing:
        results.filter(
          x =>
            x.status ===
            'BOTH_MISSING'
        ).length
    };

    const verification = {
      created_at:
        nowJST(),

      direct_source:
        '各買取店公式サイト',

      secondary_source:
        'りんごの奴隷',

      note:
        '価格差は取得時刻・店舗条件・各サイトの更新時刻差で発生し得る。直接取得価格をPrimaryとし、りんごの奴隷はSecondary検証として使用する。',

      ringo_source_updated_at:
        snapshot.source_updated_at,

      summary,

      per_store:
        perStore,

      differences:
        results
          .filter(
            x => x.status === 'DIFF'
          )
          .sort(
            (a, b) =>
              Math.abs(
                b.difference
              ) -
              Math.abs(
                a.difference
              )
          ),

      results
    };

    fs.writeFileSync(
      VERIFY_PATH,
      JSON.stringify(
        verification,
        null,
        2
      ) + '\n'
    );

    console.log('');
    console.log(
      '=========================================='
    );
    console.log(
      'りんごの奴隷 自動照合完了'
    );
    console.log(
      '=========================================='
    );

    console.log(
      'SKU:',
      parsedItems.length
    );

    console.log(
      'りんご店舗:',
      storeNames.length
    );

    console.log(
      'りんご価格取得数:',
      ringoPriceCount
    );

    console.log(
      '照合対象:',
      summary.total
    );

    console.log(
      '比較できた件数:',
      summary.compared
    );

    console.log(
      '完全一致:',
      summary.exact
    );

    console.log(
      '価格差あり:',
      summary.diff
    );

    console.log(
      '直接取得のみ:',
      summary.direct_only
    );

    console.log(
      'りんごのみ:',
      summary.ringo_only
    );

    console.log('');
    console.log(
      '店舗別'
    );

    for (
      const [name, value]
      of Object.entries(
        perStore
      )
    ) {
      console.log(
        `${name}: 一致=${value.exact} 差異=${value.diff} 直接のみ=${value.direct_only} りんごのみ=${value.ringo_only}`
      );
    }

    console.log('');
    console.log(
      '保存:',
      'data/ringo_snapshot.json'
    );

    console.log(
      '保存:',
      'data/price_verification.json'
    );

  } finally {
    await context.close();
  }
})().catch(error => {
  console.error('');
  console.error(
    '❌ りんご照合失敗'
  );

  console.error(
    error.message ||
    error
  );

  process.exit(1);
});
