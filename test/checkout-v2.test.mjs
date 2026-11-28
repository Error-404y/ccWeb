import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {openAccounts} from '../lib/accounts.mjs';
import {initAccess,createInvoice,invoiceRow,invoiceStatus,submitPayment} from '../lib/access.mjs';
import {initPayments,createCryptoInvoice,existingCryptoInvoice,inspectTransaction,COINS} from '../lib/crypto-payments.mjs';

const now=Date.UTC(2026,10,28);
const key=n=>'QZO-'+n.repeat(48);
function setup(){const db=openAccounts(':memory:');initAccess(db);initPayments(db);return db;}
test('month checkout retry returns exactly the original quote, never the legacy price',()=>{
 const db=setup();try{
 const old=createInvoice(db,'monthly',null,now);
 const first=createCryptoInvoice(db,'month','BTC',100000,null,now,key('A'));
 const retry=createCryptoInvoice(db,'month','BTC',150000,null,now+5000,key('A'));
 assert.equal(first.usd,'5.99');assert.equal(old.euro,'19.99');
 assert.equal(retry.id,first.id);assert.equal(retry.amount,first.amount);assert.equal(retry.expires,first.expires);
 assert.equal(db.prepare('SELECT count(*) AS n FROM access_invoices').get().n,2);
 assert.throws(()=>existingCryptoInvoice(db,key('A'),'year','BTC',null,now));
 assert.throws(()=>existingCryptoInvoice(db,key('A'),'month','SOL',null,now));
 assert.throws(()=>existingCryptoInvoice(db,key('A'),'month','BTC','other',now));
 assert.equal(invoiceStatus(db,old.orderKey,now).usd,null);
 }finally{db.close();}
});
test('every plan is priced on the server and persists after expiry',()=>{
 const db=setup();try{
 for(const [plan,price] of [['week','1.99'],['month','5.99'],['year','69.99'],['lifetime','79.99']]){
  for(const coin of Object.keys(COINS)){
   const order=createCryptoInvoice(db,plan,coin,coin==='BTC'?100000:coin==='LTC'?100:150,null,now);
   assert.equal(order.usd,price);assert.equal(order.plan,plan);assert.equal(order.coin,coin);
   const restored=invoiceStatus(db,order.orderKey,now+31*60000);
   assert.equal(restored.state,'expired');assert.equal(restored.usd,price);assert.equal(restored.amount,order.amount);
  }
 }
 }finally{db.close();}
});
test('transaction submission retries are idempotent and cannot replace matched payments',()=>{
 const db=setup();try{
 const order=createCryptoInvoice(db,'month','LTC',100,null,now);
 const tx='a'.repeat(64);
 submitPayment(db,order.orderKey,tx,now+1000);
 submitPayment(db,order.orderKey,tx,now+5000);
 assert.equal(invoiceStatus(db,order.orderKey,now+5000).submitted,now+1000);
 db.prepare('UPDATE access_invoices SET confirmations=2 WHERE id=?').run(order.id);
 assert.throws(()=>submitPayment(db,order.orderKey,'b'.repeat(64),now+6000));
 assert.equal(invoiceStatus(db,order.orderKey,now+6000).confirmations,2);
 }finally{db.close();}
});
test('late block inclusion keeps original amount; insufficient or wrong amounts cannot activate',()=>{
 const db=setup();try{
 const order=createCryptoInvoice(db,'month','BTC',100000,null,now),txid='a'.repeat(64);
 submitPayment(db,order.orderKey,txid,now);
 const row=invoiceRow(db,order.orderKey);
 const tx={txid,blocktime:(now+3600000)/1000,confirmations:1,vout:[{n:0,value:row.amount_atomic/1e8,scriptPubKey:{address:row.wallet}}]};
 assert.equal(inspectTransaction(row,tx),null);assert.equal(inspectTransaction(row,tx,{partial:true}).confirmations,1);
 assert.equal(inspectTransaction(row,{...tx,confirmations:3}).confirmations,3);
 assert.equal(inspectTransaction(row,{...tx,confirmations:3,vout:[{...tx.vout[0],value:0.001}]}),null);
 }finally{db.close();}
});
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function journal(storage){
 const a=app.indexOf('function checkoutStorage('),b=app.indexOf('function showAccountRecovery(',a);
 return runInNewContext(app.slice(a,b)+'\n({readCheckout,saveCheckoutDraft,checkoutOrder,updateCheckoutOrder,savedInvoice,leaveInvoice,completeInvoice,rememberInvoice})',{localStorage:storage});
}
test('journal survives process restart, preserves selected plan and separates old orders',()=>{
 const map=new Map([['qzu-access',key('B')]]);
 const storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 let j=journal(storage);
 assert.equal(j.savedInvoice(false),'');assert.equal(j.readCheckout(false).orders[0].stage,'legacy');
 j.saveCheckoutDraft(false,'month','BTC');
 j.updateCheckoutOrder(false,key('A'),{stage:'intent',plan:'month',coin:'BTC',usd:'5.99'},true);
 j=journal(storage);
 assert.equal(j.savedInvoice(false),key('A'));assert.equal(j.checkoutOrder(false,key('A')).stage,'intent');
 assert.equal(j.readCheckout(false).draft.plan,'month');
 j.rememberInvoice(key('A'),false);assert.equal(j.checkoutOrder(false,key('A')).stage,'intent');
 j.updateCheckoutOrder(false,key('A'),{stage:'order',serverState:'submitted',txDraft:'c'.repeat(64)});
 j=journal(storage);assert.equal(j.checkoutOrder(false,key('A')).txDraft,'c'.repeat(64));
 j.leaveInvoice(false,key('A'));assert.equal(j.savedInvoice(false),'');
 assert.equal(j.readCheckout(false).orders.length,2);
 j.updateCheckoutOrder(false,key('A'),{},true);j.completeInvoice(false,key('A'));
 assert.equal(j.savedInvoice(false),'');assert.equal(j.checkoutOrder(false,key('A')).stage,'redeemed');
 assert.equal(j.readCheckout(true).orders.length,0);
});
test('polling responses are guarded against concurrent submit and activation',()=>{
 assert.ok(app.includes('observed===mutation'));assert.ok(app.includes('if(value)mutation++'));assert.ok(app.includes('requestKey:secret'));
});
