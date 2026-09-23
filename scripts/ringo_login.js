const { chromium } = require('playwright');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(
  ROOT_DIR,
  '.auth',
  'ringonodorei'
);

const TOOL_URL =
  'https://' +
  'ringonodorei.com' +
  '/admin/purchase-price-tool';

(async () => {
  const context =
    await chromium.launchPersistentContext(
      AUTH_DIR,
      {
        headless: false
      }
    );

  const pages = context.pages();
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

  console.log('');
  console.log('==========================================');
  console.log('りんごの奴隷 ログイン更新');
  console.log('==========================================');
  console.log('');
  console.log(
    'ブラウザで通常どおりログインしてください。'
  );
  console.log(
    '買取価格表が表示されたら自動的に保存して終了します。'
  );

  const deadline =
    Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    const url = page.url();

    if (
      url.includes(
        '/admin/purchase-price-tool'
      )
    ) {
      const tableCount =
        await page
          .locator('table')
          .count()
          .catch(() => 0);

      if (tableCount > 0) {
        console.log('');
        console.log(
          '✅ ログイン状態を保存しました'
        );

        await context.close();
        process.exit(0);
      }
    }

    await page.waitForTimeout(1000);
  }

  console.error(
    '❌ 10分以内に買取価格表を確認できませんでした'
  );

  await context.close();
  process.exit(1);
})();
