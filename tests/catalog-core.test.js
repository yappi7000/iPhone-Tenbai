const {test} = require('node:test');
const assert = require('node:assert/strict');
const c = require('../assets/catalog-core');
const now = Date.parse('2026-09-26T08:00:00Z');
const fresh = (store,price) => ({store,price,status:'ok',observed_at:'2026-09-26T07:00:00Z'});
test('rank only fresh successful numeric observations; preserve ties',()=>{
 const rows=[fresh('A',200),fresh('B',200),fresh('C',100),{...fresh('old',999),observed_at:'2026-09-20T00:00:00Z'},{...fresh('failed',999),status:'error'},fresh('bad','999'),{...fresh('future',999),observed_at:'2027-01-01T00:00:00Z'}];
 assert.deepEqual(c.ranking(rows,now).map(r=>r.store),['A','B','C']);
 assert.equal(rows[3].price,999);
});
test('search handles full-width and multiple words and category',()=>{
 const products=[{name:'Nintendo Switch 2 日本国内専用版',jan:'4902370553024',category:'games'},{name:'Switch カメラ',jan:'123',category:'cameras'}];
 assert.equal(c.search(products,'Ｓｗｉｔｃｈ ２','games').length,1);
 assert.equal(c.search(products,'４９０２３７０５５３０２４','games').length,1);
 assert.equal(c.search(products,'Switch','cards').length,0);
});
test('net profit handles empty inputs, zero, losses, invalid fees',()=>{
 assert.equal(c.profit(10000,'','0','0'),null);
 assert.equal(c.profit(10000,'0','0','0'),10000);
 assert.equal(c.profit(10000,'9000','800','300'),-100);
 assert.equal(c.profit(10000,'9000','-1','0'),null);
 assert.equal(c.profit(10000,'9000','1.5','0'),null);
});
test('Android names, Japanese aliases, compact model numbers and variants',()=>{
 const products=[
  {name:'Google Pixel 9a 128GB Obsidian SIMフリー',jan:'0840353922303',category:'other',model:'Pixel 9a',aliases:['ピクセル9a','グーグル']},
  {name:'Google Pixel 9a 256GB Obsidian SIMフリー',jan:'0840353922518',category:'other',model:'Pixel 9a',aliases:['ピクセル9a','グーグル']},
  {name:'arrows We2 F-52E docomo ネイビーグリーン',jan:'4942857239126',category:'other',model:'F-52E',aliases:['アローズWe2','ドコモ']}
 ];
 assert.equal(c.search(products,'ピクセル９ａ １２８ＧＢ','other')[0].jan,'0840353922303');
 assert.equal(c.search(products,'pixel9a','other').length,2);
 assert.equal(c.search(products,'F52E ドコモ','other')[0].jan,'4942857239126');
 assert.equal(c.search(products,'arrowsWe2','other').length,1);
 assert.equal(c.search(products,'Pixel 9a 512GB','other').length,0);
 assert.equal(c.search(products,'pixel9a','games').length,0);
 assert.equal(c.search(products,'未知の機種','other').length,0);
});
test('store searches encode the entire query without injecting URL parameters',()=>{
 const query='Pixel 9a & q=別機種 # <script>';
 const links=c.storeSearchLinks(query);
 assert.equal(links.length,6);
 assert.equal(c.storeSearchLinks('  ').length,0);
 for(const link of links){
  const u=new URL(link.url);
  assert.equal(u.protocol,'https:');
  assert.equal(u.hash,'');
  assert.ok(link.url.endsWith(encodeURIComponent(query)));
 }
});
test('best five uses highest fresh store offer per single-card edition only',()=>{
 const products=Array.from({length:7},(_,i)=>({id:'p'+i,name:'card'+i,kind:'single_card'}));
 products.push({id:'box',name:'BOX',kind:'card_pack'},{id:'reference',name:'Trophy',kind:'card_reference'});
 const prices=Object.fromEntries(products.map((p,i)=>[p.id,[fresh('A',(i+1)*100),fresh('B',(i+1)*200)]]));
 prices.p6=[{...fresh('old',9999),observed_at:'2026-09-20T00:00:00Z'}];
 prices.p5=[{...fresh('failed',9999),status:'error'}];
 const ranked=c.topProducts(products,prices,5,now);
 assert.equal(ranked.length,5);
 assert.deepEqual(ranked.map(x=>x.product.id),['p4','p3','p2','p1','p0']);
 assert.equal(ranked[0].best.price,1000);
 assert.equal(c.topProducts(products,{},5,now).length,0);
});
test('anniversary aliases and numbered single cards search without JAN',()=>{
 const products=[{name:'30th CELEBRATION BOX',category:'cards',aliases:['ポケモン30周年','ポケカ30周年']},{name:'リーリエ SR',model:'SM4+ 119/114',category:'cards'}];
 assert.equal(c.search(products,'ポケモン ３０周年','cards').length,1);
 assert.equal(c.search(products,'119/114','cards')[0].name,'リーリエ SR');
});
