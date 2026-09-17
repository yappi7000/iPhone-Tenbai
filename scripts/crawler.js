const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// 調査対象の主要モデルとJAN
const TARGET_JANS = [
  // iPhone 17 Pro Max
  { jan: "4549995649284", name: "iPhone 17 Pro Max 256GB シルバー" },
  { jan: "4549995649291", name: "iPhone 17 Pro Max 256GB コズミックオレンジ" },
  { jan: "4549995649307", name: "iPhone 17 Pro Max 256GB ディープブルー" },
  { jan: "4549995649314", name: "iPhone 17 Pro Max 512GB シルバー" },
  { jan: "4549995649321", name: "iPhone 17 Pro Max 512GB コズミックオレンジ" },
  { jan: "4549995649338", name: "iPhone 17 Pro Max 512GB ディープブルー" },

  // iPhone 17 Pro
  { jan: "4549995649253", name: "iPhone 17 Pro 256GB シルバー" },
  { jan: "4549995649260", name: "iPhone 17 Pro 256GB コズミックオレンジ" },
  { jan: "4549995649277", name: "iPhone 17 Pro 256GB ディープブルー" },
  { jan: "4549995649406", name: "iPhone 17 Pro 512GB シルバー" },
  { jan: "4549995649413", name: "iPhone 17 Pro 512GB コズミックオレンジ" },
  { jan: "4549995649420", name: "iPhone 17 Pro 512GB ディープブルー" },

  // iPhone 17
  { jan: "4549995649154", name: "iPhone 17 256GB ブラック" }
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const results = {};
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  for (const item of TARGET_JANS) {
    console.log(`Checking: ${item.name} (${item.jan})`);
    results[item.jan] = {
      stores: [],
      last_update: now
    };

    // 1. 買取商店
    try {
      const url = `https://kaitorishouten.jp/item/search?q=${item.jan}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500); // 動的描画の完了待ち
      const bodyText = await page.innerText('body');
      
      // 数字,数字 + 円 または ¥数字 を抽出
      const matches = [...bodyText.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val > 50000 && val < 600000 && val > maxP) {
          maxP = val;
        }
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "買取商店", price: maxP, url });
        console.log(`  -> 買取商店: ¥${maxP.toLocaleString()}`);
      }
    } catch (e) {
      console.log(`  買取商店 Error: ${e.message}`);
    }

    // 2. モバステ
    try {
      const url = `https://pastec.net/search?keyword=${item.jan}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500);
      const bodyText = await page.innerText('body');
      
      const matches = [...bodyText.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val > 50000 && val < 600000 && val > maxP) {
          maxP = val;
        }
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "モバステ", price: maxP, url });
        console.log(`  -> モバステ: ¥${maxP.toLocaleString()}`);
      }
    } catch (e) {
      console.log(`  モバステ Error: ${e.message}`);
    }

    // 3. 森森買取
    try {
      const url = `https://www.morimori-kaitori.jp/search?keyword=${item.jan}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500);
      const bodyText = await page.innerText('body');
      
      const matches = [...bodyText.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val > 50000 && val < 600000 && val > maxP) {
          maxP = val;
        }
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "森森買取", price: maxP, url });
        console.log(`  -> 森森買取: ¥${maxP.toLocaleString()}`);
      }
    } catch (e) {
      console.log(`  森森買取 Error: ${e.message}`);
    }

    await page.waitForTimeout(1000);
  }

  await browser.close();

  // 保存先ディレクトリ作成
  const outDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outPath = path.join(outDir, 'prices.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`Saved to ${outPath}`);
}

run();
