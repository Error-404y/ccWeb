import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sellerCatalog} from '../lib/seller-catalog.mjs';

const listing = (data = {}) => ({id:randomUUID(),name:'Print',quantity:2,price:'10.05',currency:'CHF',...data});

test('only the current approved revision replaces the visible shop listing',t=>{
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  const catalog=sellerCatalog(db,{reviewRequired:true,isSeller:id=>id==='seller',canView:()=>true});
  const item=listing({published:true,fulfillment:'delivery'});
  catalog.save('seller',item,true);
  assert.deepEqual(catalog.forContact('buyer','seller','contact').items,[]);
  const [first]=catalog.queue();
  catalog.save('seller',{...item,name:'Updated print'},true);
  const [latest]=catalog.queue();
  assert.throws(()=>catalog.review(first.id,true),{status:409});
  catalog.review(latest.id,false);
  assert.deepEqual(catalog.forContact('buyer','seller','contact').items,[]);
  assert.equal(catalog.list('seller',true).items[0].reviewStatus,'returned');
  catalog.save('seller',item,true);
  catalog.review(catalog.queue()[0].id,true);
  catalog.save('seller',{...item,quantity:8},true);
  assert.equal(catalog.forContact('buyer','seller','contact').items[0].quantity,2);
  catalog.review(catalog.queue()[0].id,true);
  assert.equal(catalog.forContact('buyer','seller','contact').items[0].quantity,8);
});

test('seller listing IDs are scoped to the owner and repeated actions do not create duplicates',t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const active = new Set(['seller-a','seller-b']);
  const catalog = sellerCatalog(db,{isSeller:id => active.has(id)});
  assert.deepEqual(catalog.list('seller-a'),{items:[]});
  const item = listing({name:' Print ',price:'10,05'});
  const visible = {id:item.id,name:'Print',quantity:2,priceMinor:1005,currency:'CHF',fulfillment:'unspecified',published:true};
  assert.deepEqual(catalog.save('seller-a',item),{items:[visible],notified:[]});
  assert.deepEqual(catalog.save('seller-a',item),{items:[visible],notified:[]});
  assert.deepEqual(catalog.save('seller-b',{...item,name:'Poster',currency:'EUR',price:'3.3'}),
    {items:[{...visible,name:'Poster',currency:'EUR',priceMinor:330}],notified:[]});
  assert.deepEqual(catalog.save('seller-a',{...item,quantity:0}),{items:[{...visible,quantity:0}],notified:[]});
  assert.deepEqual(catalog.remove('seller-b',item.id),{items:[]});
  assert.deepEqual(catalog.remove('seller-b',item.id),{items:[]});
  assert.deepEqual(catalog.list('seller-a'),{items:[{...visible,quantity:0}]});
  for (const owner of ['regular','seller-a']) {
    active.delete(owner);
    assert.throws(() => catalog.list(owner),{status:403});
    assert.throws(() => catalog.save(owner,item),{status:403});
    assert.throws(() => catalog.remove(owner,item.id),{status:403});
  }
  catalog.erase('seller-a');
  active.add('seller-a');
  assert.deepEqual(catalog.list('seller-a'),{items:[]});
});

test('private listing drafts are separate from the public catalog through publishing and editing',t=>{
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(`CREATE TABLE seller_catalog_items(owner TEXT,id TEXT,name TEXT,quantity INTEGER,price_minor INTEGER,currency TEXT,PRIMARY KEY(owner,id));
    INSERT INTO seller_catalog_items VALUES('seller','legacy','Legacy print',1,300,'EUR');`);
  const catalog=sellerCatalog(db,{isSeller:id=>id==='seller',canView:()=>true});
  const draft=listing({published:false,price:'',fulfillment:'unspecified'});
  const {items}=catalog.save('seller',draft,true);
  assert.deepEqual(items.map(item=>[item.name,item.priceMinor,item.fulfillment,item.published]),[
    ['Legacy print',300,'unspecified',true],['Print',null,'unspecified',false]
  ]);
  assert.equal(db.prepare('SELECT id FROM seller_catalog_items WHERE id=?').get(draft.id),undefined);
  assert.equal(catalog.forContact('buyer','seller','contact').items.length,1);
  assert.throws(()=>catalog.save('seller',{...draft,published:true},true),{status:400});
  assert.throws(()=>catalog.save('seller',{...draft,published:true,fulfillment:'pickup'},true),{status:400});
  assert.throws(()=>catalog.save('seller',{...draft,published:undefined,price:'10.05'}),{status:404});
  catalog.remove('seller',draft.id);
  assert.equal(catalog.list('seller',true).items.length,2);
  catalog.save('seller',{...draft,published:true,price:'10.05',fulfillment:'both'},true);
  assert.equal(db.prepare('SELECT id FROM seller_catalog_drafts WHERE id=?').get(draft.id),undefined);
  const publicItem=catalog.forContact('buyer','seller','contact').items.find(item=>item.id===draft.id);
  assert.equal(publicItem.fulfillment,'both');
  assert.equal(publicItem.priceMinor,1005);
  assert.equal(publicItem.published,true);
});

test('stock alerts are one-time and tied to an active buyer and the original contact',t=>{
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  const contact=randomUUID(), replacement=randomUUID(), canceled=randomUUID(), blocked=randomUUID();
  const eligible=new Map([['buyer',contact],['canceled',canceled],['blocked',blocked]]);
  let timestamp=1000;
  const catalog=sellerCatalog(db,{isSeller:id=>id==='seller',canView:(buyer,owner,link)=>eligible.get(buyer)===link,now:()=>timestamp});
  const item=listing({quantity:0,fulfillment:'pickup',published:true});
  catalog.save('seller',item,true);
  assert.throws(()=>catalog.watch('other','seller',contact,item.id),{status:404});
  catalog.watch('buyer','seller',contact,item.id);
  catalog.watch('buyer','seller',contact,item.id);
  catalog.watch('canceled','seller',canceled,item.id);
  catalog.watch('blocked','seller',blocked,item.id);
  catalog.dismiss('canceled',canceled,item.id);
  eligible.delete('blocked');
  assert.equal(catalog.forContact('buyer','seller',contact).items[0].watching,true);
  assert.deepEqual(catalog.save('seller',{...item,quantity:2},true).notified,['buyer']);
  assert.equal(catalog.alerts('buyer')[0].notified,1000);
  assert.deepEqual(catalog.alerts('blocked'),[]);
  const notice=catalog.latestNotice('buyer',new Set([contact]));
  assert.ok(notice);
  catalog.markSeen('other',notice);
  assert.equal(catalog.latestNotice('buyer',new Set([contact])),notice);
  catalog.markSeen('buyer',notice);
  assert.equal(catalog.latestNotice('buyer',new Set([contact])),null);
  assert.equal(catalog.alerts('buyer')[0].quantity,2);
  assert.throws(()=>catalog.watch('buyer','seller',contact,item.id),{status:409});
  assert.deepEqual(catalog.save('seller',{...item,quantity:3},true).notified,[]);
  assert.deepEqual(catalog.save('seller',item,true).notified,[]);
  catalog.watch('buyer','seller',contact,item.id);
  eligible.set('buyer',replacement);
  assert.equal(catalog.forContact('buyer','seller',replacement).items[0].watching,false);
  assert.deepEqual(catalog.save('seller',{...item,quantity:1},true).notified,[]);
  assert.deepEqual(catalog.alerts('buyer'),[]);
  catalog.save('seller',item,true);
  catalog.watch('buyer','seller',replacement,item.id);
  timestamp++;
  catalog.save('seller',{...item,published:false},true);
  assert.deepEqual(catalog.alerts('buyer'),[]);
  assert.deepEqual(catalog.save('seller',{...item,quantity:1},true).notified,[]);
  catalog.save('seller',item,true);
  catalog.watch('buyer','seller',replacement,item.id);
  assert.equal(catalog.alerts('buyer').length,1);
  catalog.erase('buyer');
  assert.deepEqual(catalog.alerts('buyer'),[]);
});

test('catalog validates exact prices, supported currency, and bounded item counts',t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const catalog = sellerCatalog(db,{isSeller:id => id === 'seller'});
  for (const fields of [{id:'missing'},{name:'   '},{name:'x'.repeat(81)},{name:'one\ntwo'},{quantity:-1},{quantity:1000001},
    {quantity:0.1},{quantity:'1'},{price:'0.001'},{price:'1e2'},{price:'-1'},{price:'10000000'},{price:1},{currency:'BTC'}]) {
    assert.throws(() => catalog.save('seller',listing(fields)),{status:400});
  }
  assert.deepEqual(catalog.list('seller'),{items:[]});
  const atLimit = listing({name:'Available',quantity:1_000_000,price:'9999999.99',currency:'USD'});
  const outOfStock = listing({name:'A first item',quantity:0,price:'0',currency:'GBP'});
  catalog.save('seller',outOfStock);
  assert.deepEqual(catalog.save('seller',atLimit).items.map(item => item.priceMinor),[999999999,0]);
  for (let i = 0; i < 98; i++) catalog.save('seller',listing());
  assert.throws(() => catalog.save('seller',listing()),{status:409});
  assert.equal(catalog.save('seller',{...atLimit,name:'Updated'}).items.length,100);
  assert.equal(catalog.remove('seller',outOfStock.id).items.length,99);
  assert.equal(catalog.save('seller',listing()).items.length,100);
});
