(async function () {
  'use strict';
  const core = window.BuybackCatalog;
  const $ = id => document.getElementById(id);
  const labels = {games:'🎮 ゲーム機',cards:'🃏 トレーディングカード',cameras:'📷 カメラ',appliances:'🏠 家電',other:'📦 その他'};
  const yen = n => '¥' + n.toLocaleString('ja-JP');
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = value => {try {const u = new URL(value); return u.protocol === 'https:' ? u.href : '#';} catch {return '#';}};
  const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) + ' JST' : '未取得';
  let category = '', products = [], prices = {}, selected = null, error = '', loaded = false;
  let listScroll = 0;
  function quoteRows(p) {return Array.isArray(prices[p.id]) ? prices[p.id] : [];}
  function condition(p) {return p.condition === 'sealed_box' ? '未開封BOX・シュリンクあり' : '新品（詳細条件は各店で確認）';}
  function selectCategory(value) {
    category = value;
    document.querySelectorAll('[data-catalog-category]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.catalogCategory === value)));
    $('iphonePanel').hidden = value !== 'iphone';
    $('catalogPanel').hidden = value === 'iphone';
    if (value !== 'iphone') {selected = null; $('catalogDetail').hidden = true; $('catalogList').hidden = false; renderList();}
  }
  document.querySelectorAll('[data-catalog-category]').forEach(b => b.addEventListener('click', () => selectCategory(b.dataset.catalogCategory)));
  function renderList() {
    $('catalogTitle').textContent = labels[category] || 'ジャンル別 買取ランキング';
    $('catalogCategoryNote').textContent = category === 'cards' ? '初期対応は未開封BOX・シュリンクあり。シングルカード、鑑定品、シュリンクなしは比較対象に含めていません。' : '登録商品の店舗別買取価格を比較。新品・同一JANの価格を表示します。';
    if (!loaded) {$('catalogProducts').innerHTML = '<p class="catalog-empty">読み込み中…</p>'; return;}
    if (error) {$('catalogProducts').innerHTML = '<p class="catalog-empty catalog-error">' + escape(error) + '</p>'; return;}
    let found = core.search(products, $('catalogQuery').value, category);
    found.sort((a,b) => $('catalogSort').value === 'name' ? a.name.localeCompare(b.name,'ja') : ((core.ranking(quoteRows(b))[0]?.price || 0) - (core.ranking(quoteRows(a))[0]?.price || 0)) || a.name.localeCompare(b.name,'ja'));
    $('catalogCount').textContent = found.length + '商品 ／ 登録商品内を検索';
    $('catalogProducts').innerHTML = found.length ? found.map(p => {
      const ranks = core.ranking(quoteRows(p));
      const best = ranks[0];
      return `<button type="button" class="catalog-product" data-product="${escape(p.id)}"><span class="catalog-tag">${escape(condition(p))}</span><strong>${escape(p.name)}</strong><span class="catalog-muted">JAN ${escape(p.jan)}</span><span class="catalog-price">${best ? yen(best.price) : '価格未取得'}</span><span class="catalog-muted">${best ? escape(best.store) + ' ／ 比較可能 ' + ranks.length + '店' : '商品を開いて取得状況を確認'} →</span></button>`;
    }).join('') : '<div class="catalog-empty">該当する登録商品がありません。<br>別の商品名・JANで検索するか、別のジャンルを選んでください。</div>';
  }
  $('catalogQuery').addEventListener('input', renderList);
  $('catalogSort').addEventListener('change', renderList);
  $('catalogProducts').addEventListener('click', e => {
    const button = e.target.closest('[data-product]');
    if (!button) return;
    selected = products.find(p => p.id === button.dataset.product);
    listScroll = window.scrollY;
    $('catalogList').hidden = true; $('catalogDetail').hidden = false;
    $('catalogDetailTitle').textContent = selected.name;
    $('catalogDetailMeta').textContent = 'JAN ' + selected.jan + ' ／ ' + condition(selected);
    let saved = {};
    try {saved = JSON.parse(localStorage.getItem('buyback-costs:' + selected.id)) || {};} catch {}
    for (const key of ['cost','shipping','fees']) $('catalog-' + key).value = saved[key] ?? (key === 'cost' ? '' : '0');
    renderDetail();
    $('catalogDetailTitle').focus();
  });
  $('catalogBack').addEventListener('click', () => {
    const id = selected?.id; selected = null;
    $('catalogDetail').hidden = true; $('catalogList').hidden = false; renderList();
    const button = Array.from(document.querySelectorAll('[data-product]')).find(b=>b.dataset.product===id);
    button?.focus({preventScroll:true}); window.scrollTo(0,listScroll);
  });
  function renderDetail() {
    if (!selected) return;
    const ranks = core.ranking(quoteRows(selected));
    const costs = Object.fromEntries(['cost','shipping','fees'].map(k => [k,$('catalog-' + k).value]));
    const best = ranks[0];
    const result = best ? core.profit(best.price, costs.cost, costs.shipping, costs.fees) : null;
    $('catalogProfit').textContent = !best ? '比較可能な価格がありません' : result === null ? '仕入れ価格を入力してください' : (result >= 0 ? '+' : '−') + yen(Math.abs(result));
    $('catalogProfit').classList.toggle('catalog-error', result !== null && result < 0);
    $('catalogBest').textContent = best ? '最高買取 ' + yen(best.price) + ' ／ ' + best.store : '取得できた価格だけを順位に反映します';
    let previous = null, rank = 0;
    const rankingHtml = ranks.map((row,i) => {
      if (row.price !== previous) rank = i + 1;
      previous = row.price;
      const net = core.profit(row.price,costs.cost,costs.shipping,costs.fees);
      return `<div class="catalog-store"><span class="catalog-rank">${rank}</span><div><div class="catalog-store-name">${escape(row.store)}</div><div class="catalog-store-note">取得 ${escape(time(row.observed_at))}</div>${row.note ? '<div class="catalog-store-note">' + escape(row.note) + '</div>' : ''}<a href="${escape(safeUrl(row.url))}" target="_blank" rel="noopener noreferrer">公式の価格・買取条件を確認 ↗</a></div><div class="catalog-store-price">${yen(row.price)}${net !== null ? '<div class="catalog-store-note">手残り試算 ' + (net>=0?'+':'−') + yen(Math.abs(net)) + '</div>' : ''}</div></div>`;
    }).join('');
    const excluded = quoteRows(selected).filter(r=>!core.validQuote(r));
    const statuses = {not_found:'対象条件の価格なし',ambiguous:'価格を特定できず',error:'取得失敗'};
    $('catalogRanking').innerHTML = (rankingHtml || '<p class="catalog-empty">現在、比較できる価格を取得できていません。</p>') + excluded.map(r => `<div class="catalog-store"><span>—</span><div><span class="catalog-store-name">${escape(r.store)}</span><div class="catalog-store-note">${r.status==='ok'?'価格が古いため順位から除外':escape(statuses[r.status] || '未取得')} ／ 確認 ${escape(time(r.checked_at))}</div><a href="${escape(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">公式サイトで確認 ↗</a></div><span class="catalog-status">順位対象外</span></div>`).join('');
  }
  for (const k of ['cost','shipping','fees']) $('catalog-' + k).addEventListener('input', () => {
    if (!selected) return;
    const values = Object.fromEntries(['cost','shipping','fees'].map(key=>[key,$('catalog-'+key).value]));
    try {localStorage.setItem('buyback-costs:'+selected.id,JSON.stringify(values));} catch {}
    renderDetail();
  });
  try {
    const results = await Promise.all(['data/catalog.json','data/catalog_prices.json'].map(async url => {
      const r = await fetch(url, {cache:'no-cache'}); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }));
    if (!Array.isArray(results[0].products) || !results[1].products) throw new Error('Invalid catalog');
    products = results[0].products; prices = results[1].products;
  } catch {error = '商品データを読み込めませんでした。時間をおいてページを再読み込みしてください。';}
  loaded = true; renderList();
  setInterval(() => {if (selected) renderDetail(); else if (!$('catalogPanel').hidden) renderList();}, 60000);
})();
