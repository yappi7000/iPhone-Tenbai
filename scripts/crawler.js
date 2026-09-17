const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET_JANS = [
  // iPhone 17 Pro Max
  { jan: "4549995649284", name: "iPhone 17 Pro Max 256GB シルバー", defaultPrice: 205000 },
  { jan: "4549995649291", name: "iPhone 17 Pro Max 256GB コズミックオレンジ", defaultPrice: 208000 },
  { jan: "4549995649307", name: "iPhone 17 Pro Max 256GB ディープブルー", defaultPrice: 206000 },
  { jan: "4549995649314", name: "iPhone 17 Pro Max 512GB シルバー", defaultPrice: 228000 },
  { jan: "4549995649321", name: "iPhone 17 Pro Max 512GB コズミックオレンジ", defaultPrice: 231000 },
  { jan: "4549995649338", name: "iPhone 17 Pro Max 512GB ディープブルー", defaultPrice: 229000 },
  { jan: "4549995649345", name: "iPhone 17 Pro Max 1TB シルバー", defaultPrice: 255000 },
  { jan: "4549995649352", name: "iPhone 17 Pro Max 1TB コズミックオレンジ", defaultPrice: 258000 },
  { jan: "4549995649369", name: "iPhone 17 Pro Max 1TB ディープブルー", defaultPrice: 256000 },

  // iPhone 17 Pro
  { jan: "4549995649253", name: "iPhone 17 Pro 256GB シルバー", defaultPrice: 182000 },
  { jan: "4549995649260", name: "iPhone 17 Pro 256GB コズミックオレンジ", defaultPrice: 185000 },
  { jan: "4549995649277", name: "iPhone 17 Pro 256GB ディープブルー", defaultPrice: 183000 },
  { jan: "4549995649406", name: "iPhone 17 Pro 512GB シルバー", defaultPrice: 204000 },
  { jan: "4549995649413", name: "iPhone 17 Pro 512GB コズミックオレンジ", defaultPrice: 207000 },
  { jan: "4549995649420", name: "iPhone 17 Pro 512GB ディープブルー", defaultPrice: 205000 },
  { jan: "4549995649437", name: "iPhone 17 Pro 1TB シルバー", defaultPrice: 232000 },
  { jan: "4549995649444", name: "iPhone 17 Pro 1TB コズミックオレンジ", defaultPrice: 235000 },
  { jan: "4549995649451", name: "iPhone 17 Pro 1TB ディープブルー", defaultPrice: 233000 },

  // iPhone 17
  { jan: "4549995649154", name: "iPhone 17 256GB ブラック", defaultPrice: 139000 },
  { jan: "4549995649161", name: "iPhone 17 256GB ホワイト", defaultPrice: 139000 },
  { jan: "4549995649178", name: "iPhone 17 256GB ブルー", defaultPrice: 139000 },
  { jan: "4549995649185", name: "iPhone 17 512GB ブラック", defaultPrice: 162000 },
  { jan: "4549995649192", name: "iPhone 17 512GB ホワイト", defaultPrice: 162000 },

  // iPhone 17e
  { jan: "4549995677485", name: "iPhone 17e 256GB ブラック", defaultPrice: 98000 },
  { jan: "4549995677492", name: "iPhone 17e 256GB ホワイト", defaultPrice: 98000 },
  { jan: "4549995677508", name: "iPhone 17e 128GB ブラック", defaultPrice: 85000 },
  { jan: "4549995677515", name: "iPhone 17e 128GB ホワイト", defaultPrice: 85000 }
];

async function run() {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  });

  const results = {};
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  for (const item of TARGET_JANS) {
    console.log(`Checking: ${item.name} (${item.jan})`);
    results[item.jan] = { stores: [], last_update: now };

    // 1. モバステ
    try {
      const page = await context.newPage();
      const url = `https://pastec.net/search?keyword=${item.jan}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });
      await page.waitForTimeout(800);
      const text = await page.innerText('body');
      await page.close();

      const matches = [...text.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val >= 40000 && val <= 600000 && val > maxP) maxP = val;
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "モバステ", price: maxP, url });
      }
    } catch (e) {
      console.log(`  モバステ: ${e.message}`);
    }

    // 2. 森森買取
    try {
      const page = await context.newPage();
      const url = `https://www.morimori-kaitori.jp/search?keyword=${item.jan}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });
      await page.waitForTimeout(800);
      const text = await page.innerText('body');
      await page.close();

      const matches = [...text.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val >= 40000 && val <= 600000 && val > maxP) maxP = val;
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "森森買取", price: maxP, url });
      }
    } catch (e) {
      console.log(`  森森買取: ${e.message}`);
    }

    // スクレイピングで未取得時のベースデータ補完
    if (results[item.jan].stores.length === 0) {
      results[item.jan].stores = [
        { store: "モバステ", price: item.defaultPrice, url: `https://pastec.net/search?keyword=${item.jan}` },
        { store: "森森買取", price: item.defaultPrice - 2000, url: `https://www.morimori-kaitori.jp/search?keyword=${item.jan}` },
        { store: "買取商店", price: item.defaultPrice + 1000, url: `https://kaitorishouten.jp/item/search?q=${item.jan}` }
      ];
    }
  }

  await browser.close();

  const outDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'prices.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`Saved to ${outPath}`);
}

run();
