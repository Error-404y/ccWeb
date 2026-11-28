import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {sellerCatalog} from '../lib/seller-catalog.mjs';

const listing = (data = {}) => ({id:randomUUID(),name:'Print',quantity:2,price:'10.05',currency:'CHF',...data});

test('seller listing IDs are scoped to the owner and repeated actions do not create duplicates',t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const active = new Set(['seller-a','seller-b']);
  const catalog = sellerCatalog(db,{isSeller:id => active.has(id)});
  assert.deepEqual(catalog.list('seller-a'),{items:[]});
  const item = listing({name:' Print ',price:'10,05'});
  const visible = {id:item.id,name:'Print',quantity:2,priceMinor:1005,currency:'CHF'};
  assert.deepEqual(catalog.save('seller-a',item),{items:[visible]});
  assert.deepEqual(catalog.save('seller-a',item),{items:[visible]});
  assert.deepEqual(catalog.save('seller-b',{...item,name:'Poster',currency:'EUR',price:'3.3'}),
    {items:[{...visible,name:'Poster',currency:'EUR',priceMinor:330}]});
  assert.deepEqual(catalog.save('seller-a',{...item,quantity:0}),{items:[{...visible,quantity:0}]});
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
