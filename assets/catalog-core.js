(function (root) {
  'use strict';
  const normalize = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const compact = s => normalize(s).replace(/[\s‐‑−–—-]/g, '');
  function search(products, query, category) {
    const terms = normalize(query).split(' ').filter(Boolean);
    return products.filter(p => {
      const fields = [p.name, p.jan, p.model, ...(p.aliases || [])].map(compact);
      return (!category || p.category === category) && terms.every(t => fields.some(f => f.includes(compact(t))));
    });
  }
  function storeSearchLinks(query) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const encoded = encodeURIComponent(q);
    return [
      ['買取ルデヤ','https://kaitori-rudeya.com/search/index/'],
      ['買取wiki','https://kaitori.wiki/search?keyword='],
      ['森森買取','https://www.morimori-kaitori.jp/search?sk='],
      ['買取ホムラ','https://kaitori-homura.com/products?q%5Bname_or_jan_code_cont%5D='],
      ['携帯空間','https://www.keitaispace.co.jp/product/?kw='],
      ['買取商店','https://www.kaitorishouten-co.jp/products/list?q=']
    ].map(([store, base]) => ({store, url: base + encoded}));
  }
  function validQuote(row, now = Date.now()) {
    const age = now - Date.parse(row.observed_at);
    return row.status === 'ok' && Number.isSafeInteger(row.price) && row.price > 0 && Number.isFinite(age) && age >= -300000 && age <= 36 * 3600000;
  }
  function ranking(rows, now) {
    return rows.filter(r => validQuote(r, now)).sort((a, b) => b.price - a.price || a.store.localeCompare(b.store, 'ja'));
  }
  function topProducts(products, prices, limit = 5, now = Date.now()) {
    return products.filter(p => p.kind === 'single_card').map(p => ({product:p, best:ranking(prices[p.id] || [], now)[0]}))
      .filter(x => x.best).sort((a,b) => b.best.price - a.best.price || a.product.name.localeCompare(b.product.name,'ja')).slice(0,limit);
  }
  function moneyInput(value) {
    if (String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 && n <= 100000000 ? n : null;
  }
  function profit(price, cost, shipping, fees) {
    const inputs = [cost, shipping, fees].map(moneyInput);
    return inputs.includes(null) ? null : price - inputs[0] - inputs[1] - inputs[2];
  }
  const api = {normalize, search, storeSearchLinks, validQuote, ranking, topProducts, moneyInput, profit};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuybackCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
