import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {openAccounts} from '../lib/accounts.mjs';
import {initDevices} from '../lib/devices.mjs';
import {initAccess,invoiceStatus,redeemAccess,submitPayment} from '../lib/access.mjs';
import {initPayments,createCryptoInvoice,COINS,verifyCryptoInvoice} from '../lib/crypto-payments.mjs';
import {initPaymentTickets,paymentTickets} from '../lib/payment-tickets.mjs';
const start=Date.UTC(2026,10,28),H=3600000;
function setup(){const db=openAccounts(':memory:');initDevices(db);initAccess(db);initPayments(db);initPaymentTickets(db);return db;}
test('ticket rejection closes chat, remains visible 12 hours, and new case retains original invoice',()=>{
 const db=setup();let now=start;try{
 const o=createCryptoInvoice(db,'month','LTC',100,null,now,null,true),t=paymentTickets(db,()=>now),first=t.open(o.id);
 assert.equal(t.open(o.id).id,first.id);assert.equal(t.view(first.id).status,'open');t.review(first.id,'admin-a');assert.equal(t.view(first.id).status,'review');
 const requestId=randomUUID();t.send(first.id,'customer',{text:'Payment question',requestId},o.id);t.send(first.id,'customer',{text:'Payment question',requestId},o.id);assert.equal(t.view(first.id).messages.length,1);
 t.reject(first.id,'admin-b','Wrong transaction ID');assert.equal(t.view(first.id).status,'rejected');assert.equal(t.view(first.id).closed,true);
 assert.throws(()=>t.send(first.id,'customer',{text:'Hello',requestId:randomUUID()},o.id));
 assert.equal(t.open(o.id).id,first.id);now+=1000;const second=t.open(o.id,{fresh:true});assert.notEqual(second.id,first.id);assert.equal(t.open(o.id,{fresh:true}).id,second.id);
 assert.equal(t.view(second.id).usd,'5.99');assert.equal(t.view(second.id).messages.length,0);assert.equal(t.list().length,2);
 now=start+12*H;assert.equal(t.list().length,1);assert.throws(()=>t.view(first.id));assert.equal(t.view(first.id,o.id,o.orderKey).status,'rejected');
 assert.equal(invoiceStatus(db,o.orderKey,now).usd,'5.99');
 }finally{db.close();}
});
test('ticket ownership and verified release are enforced; completion closes customer composer',()=>{
 const db=setup();try{
 const a=createCryptoInvoice(db,'week','SOL',150,null,start,null,true),b=createCryptoInvoice(db,'year','BTC',100000,null,start,null,true);
 const t=paymentTickets(db,()=>start),c=t.open(a.id);assert.throws(()=>t.view(c.id,b.id,b.orderKey));assert.throws(()=>t.send(c.id,'customer',{text:'bad',requestId:randomUUID()},b.id));assert.throws(()=>t.release(c.id,'admin'));
 db.prepare("UPDATE access_invoices SET state='confirmed',verified_at=?,txid=? WHERE id=?").run(start,'a'.repeat(64),a.id);
 assert.equal(invoiceStatus(db,a.orderKey,start).activationKey,null);assert.throws(()=>t.reject(c.id,'admin','bad'));
 t.release(c.id,'admin');t.release(c.id,'admin');const result=t.view(c.id,a.id,a.orderKey);
 assert.equal(result.status,'completed');assert.equal(result.closed,true);assert.match(result.activationKey,/^QZU-[A-F0-9]{48}$/);assert.equal(t.view(c.id).activationKey,null);
 assert.equal(db.prepare("SELECT count(*) n FROM access_audit WHERE action='release-payment-key'").get().n,1);
 assert.throws(()=>t.send(c.id,'customer',{text:'closed',requestId:randomUUID()},a.id));redeemAccess(db,result.activationKey,start,'new-device');assert.throws(()=>redeemAccess(db,result.activationKey,start,'another-device'));
 }finally{db.close();}
});
test('proof uploads reject unsupported image types and do not establish payment',()=>{
 const db=setup();try{const o=createCryptoInvoice(db,'month','LTC',100,null,start,null,true),t=paymentTickets(db,()=>start),c=t.open(o.id);assert.throws(()=>t.send(c.id,'customer',{proof:Buffer.from('<svg/>').toString('base64'),requestId:randomUUID()},o.id));assert.throws(()=>t.release(c.id,'admin'));}finally{db.close();}
});
test('public BTC explorer checks mainnet, exact output and confirmation depth',async()=>{
 const db=setup(),prev=process.env.QZU_BTC_RPC_URL,pub=process.env.QZU_PUBLIC_PAYMENT_VERIFICATION;delete process.env.QZU_BTC_RPC_URL;process.env.QZU_PUBLIC_PAYMENT_VERIFICATION='true';
 try{const o=createCryptoInvoice(db,'month','BTC',100000,null,start,null,true),txid='a'.repeat(64);submitPayment(db,o.orderKey,txid,start);
 const row=db.prepare('SELECT * FROM access_invoices WHERE id=?').get(o.id);
 const fetcher=async url=>({ok:true,text:async()=>url.endsWith('/block-height/0')?'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':'102',json:async()=>({txid,status:{confirmed:true,block_height:100,block_time:start/1000},vout:[{value:row.amount_atomic,scriptpubkey_address:COINS.BTC.address}]})});
 assert.equal(await verifyCryptoInvoice(db,o.id,fetcher,start+1000),true);assert.equal(invoiceStatus(db,o.orderKey,start).activationKey,null);
 }finally{if(prev===undefined)delete process.env.QZU_BTC_RPC_URL;else process.env.QZU_BTC_RPC_URL=prev;if(pub===undefined)delete process.env.QZU_PUBLIC_PAYMENT_VERIFICATION;else process.env.QZU_PUBLIC_PAYMENT_VERIFICATION=pub;db.close();}
});
test('customer and admin interfaces include ticket lifecycle and viewport anchoring',()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),admin=readFileSync(new URL('../public/control.js',import.meta.url),'utf8');
 assert.ok(app.includes('Close Ticket'));assert.ok(app.includes('ticketStatus'));assert.ok(app.includes('ticketId'));assert.ok(app.includes('requestAnimationFrame'));assert.ok(admin.includes('Open Tickets'));assert.ok(admin.includes('Completed Tickets'));assert.ok(admin.includes('payment-tickets/reject'));
});
