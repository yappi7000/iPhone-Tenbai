(function (root) {
  'use strict';
  const normalize = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  function search(products, query, category) {
    const terms = normalize(query).split(' ').filter(Boolean);
    return products.filter(p => (!category || p.category === category) && terms.every(t => normalize(p.name + ' ' + p.jan).includes(t)));
  }
  function validQuote(row, now = Date.now()) {
    const age = now - Date.parse(row.observed_at);
    return row.status === 'ok' && Number.isSafeInteger(row.price) && row.price > 0 && Number.isFinite(age) && age >= -300000 && age <= 36 * 3600000;
  }
  function ranking(rows, now) {
    return rows.filter(r => validQuote(r, now)).sort((a, b) => b.price - a.price || a.store.localeCompare(b.store, 'ja'));
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
  const api = {normalize, search, validQuote, ranking, moneyInput, profit};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BuybackCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis);
