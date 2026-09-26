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
