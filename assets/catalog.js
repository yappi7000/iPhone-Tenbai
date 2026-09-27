(async function () {
  'use strict';
  const core = window.BuybackCatalog;
  const $ = id => document.getElementById(id);
  const labels = {games:'🎮 ゲーム機',cards:'🃏 トレーディングカード',cameras:'📷 カメラ',appliances:'🏠 家電',other:'📱 その他・Androidスマホ'};
  const yen = n => '¥' + n.toLocaleString('ja-JP');
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = value => {try {const u = new URL(value); return u.protocol === 'https:' ? u.href : '#';} catch {return '#';}};
  const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ja-JP', {timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) + ' JST' : '未取得';
  let category = '', products = [], prices = {}, selected = null, error = '', loaded = false;
  let listScroll = 0, cardView = 'packs', marketError = '', marketScope = '';
  const meta = p => p.jan ? 'JAN ' + p.jan : p.model || '版・状態を確認';
  function quoteRows(p) {return Array.isArray(prices[p.id]) ? prices[p.id] : [];}
  function condition(p) {return p.condition_label || (p.condition === 'sealed_set' ? '未開封セット' : p.kind === 'android' ? '新品・未使用（未開封条件は店舗別）' : p.condition === 'sealed_box' ? '未開封BOX・シュリンクあり' : '新品（詳細条件は各店で確認）');}
  function selectCategory(value) {
    if (value !== category) $('catalogQuery').value = '';
    category = value;
    document.querySelectorAll('[data-catalog-category]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.catalogCategory === value)));
    $('iphonePanel').hidden = value !== 'iphone';
    $('catalogPanel').hidden = value === 'iphone';
    if (value !== 'iphone') {selected = null; $('catalogDetail').hidden = true; $('catalogList').hidden = false; renderList();}
  }
  document.querySelectorAll('[data-catalog-category]').forEach(b => b.addEventListener('click', () => selectCategory(b.dataset.catalogCategory)));
  function renderList() {
    $('catalogTitle').textContent = labels[category] || 'ジャンル別 買取ランキング';
    $('catalogCategoryNote').textContent = category === 'other' ? 'Androidの商品名・型番・JANで検索できます。容量・色・販売元を選んで、登録商品の買取価格を比較してください。' : category === 'cards' ? '30周年のBOX・セット、シングルカードを検索できます。版・カード番号・状態別の公開買取価格です。' : '登録商品の店舗別買取価格を比較。新品・同一JANの価格を表示します。';
    $('catalogQuery').placeholder = category === 'other' ? '例：ピクセル9a、arrows We3、JANコード' : category === 'cards' ? '例：30周年、ポケモンイラストレーター、リーリエ' : '例：Switch 2、instax、JANコード';
    const brands = $('catalogAndroidBrands');
    brands.hidden = category !== 'other';
    brands.innerHTML = ['すべて','Pixel','arrows','AQUOS','Galaxy','OPPO','Xperia'].map(b => `<button type="button" data-android-query="${b === 'すべて' ? '' : b}" aria-pressed="${core.normalize($('catalogQuery').value) === (b === 'すべて' ? '' : core.normalize(b))}">${b}</button>`).join('');
    $('catalogCardViews').hidden = category !== 'cards';
    $('catalogCardViews').innerHTML = [['packs','BOX・セット'],['anniversary','30周年'],['singles','シングル'],['top','買取ベスト5'],['all','すべて']].map(([value,label]) => `<button type="button" data-card-view="${value}" aria-pressed="${cardView===value}">${label}</button>`).join('');
    $('catalogMarketNote').hidden = category !== 'cards';
    $('catalogMarketNote').textContent = (cardView === 'top' ? '買取ベスト5（取得済みシングル）。' : '') + (['packs','anniversary'].includes(cardView) ? 'BOX・セットは7店舗を取得対象にし、同じJANと対象条件を確認できた価格を比較します。' : (marketScope || 'シングルカードは取得できた公開買取価格で比較します。')) + (marketError && !['packs','anniversary'].includes(cardView) ? ' ' + marketError : '') + ' 発売前の商品は価格を順位に含めません。';
    $('catalogSort').disabled = category === 'cards' && cardView === 'top';
    $('catalogStoreSearch').hidden = true;
    if (!loaded) {$('catalogProducts').innerHTML = '<p class="catalog-empty">読み込み中…</p>'; return;}
    if (error) {$('catalogProducts').innerHTML = '<p class="catalog-empty catalog-error">' + escape(error) + '</p>'; return;}
    let found = core.search(products, $('catalogQuery').value, category);
    if (category === 'cards') {
      if (cardView === 'packs') found = found.filter(p => !['single_card','card_reference'].includes(p.kind));
      if (cardView === 'anniversary') found = found.filter(p => p.tags?.includes('anniversary30'));
      if (cardView === 'singles') found = found.filter(p => ['single_card','card_reference'].includes(p.kind));
      if (cardView === 'top') found = core.topProducts(found,prices).map(x => x.product);
    }
    if (!(category === 'cards' && cardView === 'top')) found.sort((a,b) => $('catalogSort').value === 'name' ? a.name.localeCompare(b.name,'ja') : ((core.ranking(quoteRows(b))[0]?.price || 0) - (core.ranking(quoteRows(a))[0]?.price || 0)) || a.name.localeCompare(b.name,'ja'));
    $('catalogCount').textContent = found.length + '商品 ／ 登録商品内を検索';
    $('catalogProducts').innerHTML = found.length ? found.map(p => {
      const ranks = core.ranking(quoteRows(p));
      const best = ranks[0];
      return `<button type="button" class="catalog-product" data-product="${escape(p.id)}"><span class="catalog-tag">${escape(condition(p))}</span><strong>${category === 'cards' && cardView === 'top' ? '🏆 ' + (found.findIndex(x => core.ranking(quoteRows(x))[0]?.price === best?.price) + 1) + '位　' : ''}${escape(p.name)}</strong><span class="catalog-muted">${escape(meta(p))}${p.available_from ? ' ／ 発売予定 ' + escape(p.available_from) : ''}</span><span class="catalog-price">${best ? yen(best.price) : quoteRows(p).some(r => r.status === 'unreleased') ? '発売前・価格対象外' : '価格未取得'}</span><span class="catalog-muted">${best ? escape(best.store) + ' ／ 比較可能 ' + ranks.length + '店' : '商品を開いて取得状況を確認'} →</span></button>`;
    }).join('') : '<div class="catalog-empty">該当する登録商品がありません。<br>' + ($('catalogQuery').value.trim() ? '機種名だけで検索するか、下の公式検索で確認してください。' : '別のジャンルを選んでください。') + '</div>';
    const links = core.storeSearchLinks($('catalogQuery').value);
    if (category === 'cards' && $('catalogQuery').value.trim()) links.unshift({store:'カードラッシュ（買取）',url:'https://cardrush.media/pokemon/buying_prices?name='+encodeURIComponent($('catalogQuery').value.trim())});
    if (links.length) {
      $('catalogStoreSearch').hidden = false;
      $('catalogStoreSearch').innerHTML = '<strong>この名前・JANで各店を検索</strong><p class="catalog-help">未登録の商品・別の容量や色は、公式サイトで確認できます。ここからの検索結果はランキングには反映されません。</p><div class="catalog-search-links">' + links.map(l => `<a href="${escape(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${escape(l.store)} ↗</a>`).join('') + '</div>';
    }
  }
  $('catalogAndroidBrands').addEventListener('click', e => {
    const button = e.target.closest('[data-android-query]');
    if (!button) return;
    $('catalogQuery').value = button.dataset.androidQuery;
    renderList(); $('catalogQuery').focus({preventScroll:true});
  });
  $('catalogCardViews').addEventListener('click', e => {
    const button = e.target.closest('[data-card-view]'); if (!button) return;
    cardView = button.dataset.cardView; $('catalogQuery').value = ''; renderList();
  });
  $('catalogQuery').addEventListener('input', () => {if(category === 'cards') cardView='all'; renderList();});
  $('catalogSort').addEventListener('change', renderList);
  $('catalogProducts').addEventListener('click', e => {
    const button = e.target.closest('[data-product]');
    if (!button) return;
    selected = products.find(p => p.id === button.dataset.product);
    listScroll = window.scrollY;
    $('catalogList').hidden = true; $('catalogDetail').hidden = false;
    $('catalogDetailTitle').textContent = selected.name;
    $('catalogDetailMeta').textContent = meta(selected) + ' ／ ' + condition(selected);
    $('catalogAndroidCondition').hidden = selected.kind !== 'android';
    $('catalogCardCondition').hidden = selected.category !== 'cards';
    $('catalogCardCondition').textContent = selected.reference_note || (selected.kind === 'single_card' ? '未鑑定カードの公開買取価格です。版・カード番号・未開封の有無を確認してください。PSAなどの鑑定品、オークション落札額、推定価格、キャンペーン加算は順位に含みません。' : 'セット内容・BOX／セットの単位・シュリンクや未開封の条件を各店で確認してください。');
    if (selected.official_source || selected.identity_source) $('catalogCardCondition').innerHTML += ` <a href="${escape(safeUrl(selected.official_source || selected.identity_source))}" target="_blank" rel="noopener noreferrer">商品・版の参照情報 ↗</a>`;
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
    const statuses = {unreleased:'発売前・順位対象外',not_found:'対象条件の価格なし',ambiguous:'価格を特定できず',error:'取得失敗'};
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
  try {
    const response = await fetch('data/pokemon_market.json', {cache:'no-cache'});
    if (!response.ok) throw new Error('HTTP '+response.status);
    const market = await response.json();
    if (!Array.isArray(market.products)) throw new Error('Invalid single-card data');
    for (const p of market.products) {products.push(p); prices[p.id] = Array.isArray(p.quotes) ? p.quotes : [];}
    marketScope = market.scope || '';
    if (market.errors?.length) marketError = '一部の取得先でエラーがあり、取得できた価格だけを表示しています。';
  } catch {marketError = 'シングルカードの価格データが未取得です。更新後に再読み込みしてください。';}
  loaded = true; renderList();
  setInterval(() => {if (selected) renderDetail(); else if (!$('catalogPanel').hidden) renderList();}, 60000);
})();
