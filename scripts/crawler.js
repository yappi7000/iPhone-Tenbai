const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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

    // 1. モバステ（最優先）
    try {
      const page = await context.newPage();
      const url = `https://pastec.net/search?keyword=${item.jan}`;
      await page.goto(url, { waitUntil: 'commit', timeout: 8000 });
      await page.waitForTimeout(1500);
      const bodyText = await page.innerText('body');
      await page.close();

      const matches = [...bodyText.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val > 50000 && val < 600000 && val > maxP) maxP = val;
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "モバステ", price: maxP, url });
        console.log(`  -> モバステ: ¥${maxP.toLocaleString()}`);
      }
    } catch (e) {
      console.log(`  モバステ Skip: ${e.message}`);
    }

    // 2. 森森買取
    try {
      const page = await context.newPage();
      const url = `https://www.morimori-kaitori.jp/search?keyword=${item.jan}`;
      await page.goto(url, { waitUntil: 'commit', timeout: 8000 });
      await page.waitForTimeout(1500);
      const bodyText = await page.innerText('body');
      await page.close();

      const matches = [...bodyText.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val > 50000 && val < 600000 && val > maxP) maxP = val;
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "森森買取", price: maxP, url });
        console.log(`  -> 森森買取: ¥${maxP.toLocaleString()}`);
      }
    } catch (e) {
      console.log(`  森森買取 Skip: ${e.message}`);
    }

    // 3. 買取商店（5秒スキップ）
    try {
      const page = await context.newPage();
      const url = `https://kaitorishouten.jp/item/search?q=${item.jan}`;
      await page.goto(url, { waitUntil: 'commit', timeout: 5000 });
      await page.waitForTimeout(1500);
      const bodyText = await page.innerText('body');
      await page.close();

      const matches = [...bodyText.matchAll(/(?:¥|￥)?\s*([1-9]\d{1,2}(?:,\d{3})+)\s*円?/g)];
      let maxP = 0;
      for (const m of matches) {
        const val = Number(m[1].replace(/,/g, ''));
        if (val > 50000 && val < 600000 && val > maxP) maxP = val;
      }
      if (maxP > 0) {
        results[item.jan].stores.push({ store: "買取商店", price: maxP, url });
        console.log(`  -> 買取商店: ¥${maxP.toLocaleString()}`);
      }
    } catch (e) {
      console.log(`  買取商店 Skip: ${e.message}`);
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
