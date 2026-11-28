import test from 'node:test';
import assert from 'node:assert/strict';
import {openAccounts,createAccount,setLogin,findAccount} from '../lib/accounts.mjs';
import {initDevices,findDeviceAccount,deviceProfiles} from '../lib/devices.mjs';
import {DEVICE_CHANGE_RETENTION,deviceChanges} from '../lib/device-changes.mjs';
import {initActivity} from '../lib/activity.mjs';
import {initAccess,createSupportKey,rotateSupportKey,releaseSupportKey,invoiceRow,invoiceStatus,submitPayment,approvePayment,redeemAccess,applyRenewal} from '../lib/access.mjs';
import {initPayments,createCryptoInvoice,inspectTransaction,verifyCryptoInvoice,COINS} from '../lib/crypto-payments.mjs';
import {initControl,issueRecovery,recoverAccount,createControlSessions,desktopControlAllowed,accountAction,archiveControlRecord,controlPayments,controlAccounts} from '../lib/control.mjs';
import {complianceStore} from '../lib/compliance.mjs';
import {feedbackStore} from '../lib/feedback.mjs';
import {initPaymentTickets,paymentTickets} from '../lib/payment-tickets.mjs';
import {Chats} from '../lib/chats.mjs';
import {randomUUID} from 'node:crypto';
const now=Date.UTC(2026,10,28);
function setup(){const db=openAccounts(':memory:');initDevices(db);initAccess(db);initPayments(db);initControl(db);complianceStore(db);return db;}
test('crypto checkout quotes USD plan, unique amount, and rejects wrong outputs or insufficient confirmations',()=>{
 const db=setup();try{
 const a=createCryptoInvoice(db,'week','BTC',100000,null,now),b=createCryptoInvoice(db,'week','BTC',100000,null,now);
 assert.equal(a.usd,'1.99');assert.notEqual(a.amount,b.amount);assert.equal(a.activationKey,null);
 const txid='a'.repeat(64);submitPayment(db,a.orderKey,txid,now);
 const row=invoiceRow(db,a.orderKey);const tx={txid,blocktime:now/1000,confirmations:3,vout:[{n:0,value:row.amount_atomic/1e8,scriptPubKey:{address:row.wallet}}]};
 assert.deepEqual(inspectTransaction(row,tx),{confirmations:3,vout:0});
 assert.equal(inspectTransaction(row,{...tx,confirmations:2}),null);
 assert.equal(inspectTransaction(row,{...tx,vout:[{n:0,value:tx.vout[0].value,scriptPubKey:{address:'wrong'}}]}),null);
 assert.throws(()=>approvePayment(db,row.id));
 }finally{db.close();}
});
test('verified payment releases deterministic single-use key without storing plaintext',async()=>{
 const db=setup(),old=process.env.QZU_BTC_RPC_URL;process.env.QZU_BTC_RPC_URL='https://rpc.example.test';
 try{
 const invoice=createCryptoInvoice(db,'week','BTC',100000,null,now),txid='a'.repeat(64);
 submitPayment(db,invoice.orderKey,txid,now);const row=invoiceRow(db,invoice.orderKey);
 const fetcher=async(_url,options)=>({ok:true,json:async()=>({result:JSON.parse(options.body).method==='getblockhash'?'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f':{txid,blocktime:now/1000,confirmations:3,vout:[{n:0,value:row.amount_atomic/1e8,scriptPubKey:{address:row.wallet}}]}})});
 assert.equal(await verifyCryptoInvoice(db,row.id,fetcher,now+1000),true);
 const key=invoiceStatus(db,invoice.orderKey,now+1000).activationKey;
 assert.match(key,/^QZU-[A-F0-9]{48}$/);assert.equal(invoiceRow(db,key).activation_key,null);
 assert.equal(invoiceStatus(db,invoice.orderKey,now+1000).activationKey,key);
 const account=redeemAccess(db,key,now+1000,'device-a');assert.equal(findAccount(db,account.token).paid_until,now+1000+7*86400000);
 assert.throws(()=>redeemAccess(db,key,now+2000,'device-b'));
 }finally{if(old===undefined)delete process.env.QZU_BTC_RPC_URL;else process.env.QZU_BTC_RPC_URL=old;db.close();}
});
test('recovery requires PIN and one-time code, retains entitlement, invalidates old device',()=>{
 const db=setup();try{
 const a=createAccount(db,'old-device');setLogin(db,a.id,'123456');db.prepare("UPDATE accounts SET access_plan='year',paid_until=? WHERE id=?").run(now+365*86400000,a.id);
 const {recoveryCode}=issueRecovery(db,a.id,'123456',now);
 assert.throws(()=>recoverAccount(db,recoveryCode,'654321','new-device',now+1));
 const result=recoverAccount(db,recoveryCode,'123456','new-device',now+2);assert.equal(result.id,a.id);assert.equal(findDeviceAccount(db,'old-device'),null);assert.equal(findDeviceAccount(db,'new-device').paid_until,now+365*86400000);
 assert.equal(findAccount(db,a.token),null);assert.throws(()=>recoverAccount(db,recoveryCode,'123456','other-device',now+3));
 }finally{db.close();}
});
test('device changes are atomic, keep the alarm until review, and disappear on account deletion',()=>{
 const db=setup();
 try{
  initActivity(db);
  let time=now, reviews=0;
  const changes=deviceChanges(db,()=>time), profiles=deviceProfiles(db,()=>time);
  const {id}=createAccount(db,'first-device');
  const other=createAccount(db,'unrelated-device');
  setLogin(db,id,'312456');
  const alarm=()=>controlAccounts(db,id,'',time)[0].deviceAlarm;
  const observe=(fingerprint,details)=>profiles.update(findDeviceAccount(db,fingerprint),fingerprint,'ios',details);
  observe('first-device',{model:'iPhone16,2',osVersion:'27.0',appVersion:'0.17.10'});
  observe('first-device',{model:'iPhone16,2',osVersion:'27.0.1'});
  assert.equal(alarm(),false);
  assert.deepEqual(changes.history(id),[]);
  const {recoveryCode}=issueRecovery(db,id,'312456',time);
  assert.throws(()=>recoverAccount(db,recoveryCode,'654321','second-device',++time),{status:403});
  assert.throws(()=>recoverAccount(db,recoveryCode,'312456','first-device',++time),{status:409});
  assert.equal(alarm(),false);
  db.exec("CREATE TRIGGER block_device_change BEFORE INSERT ON account_device_changes BEGIN SELECT RAISE(ABORT,'device history write failed'); END");
  assert.throws(()=>recoverAccount(db,recoveryCode,'312456','second-device',++time),/device history write failed/);
  assert.equal(findDeviceAccount(db,'first-device').id,id);
  assert.equal(findDeviceAccount(db,'second-device'),null);
  db.exec('DROP TRIGGER block_device_change');
  recoverAccount(db,recoveryCode,'312456','second-device',++time);
  const [first]=changes.history(id);
  assert.equal(alarm(),true);
  assert.equal(first.previousFingerprint,'first-device');
  assert.equal(first.currentFingerprint,'second-device');
  assert.equal(first.previousDevice.model,'iPhone 15 Pro Max');
  assert.equal(first.previousDevice.osVersion,'27.0.1');
  assert.equal(first.reviewedAt,null);
  assert.throws(()=>changes.review(other.id,first.id,()=>reviews++),{status:404});
  assert.throws(()=>changes.review(id,first.id,()=>{throw Error('audit write failed');}),/audit write failed/);
  assert.equal(alarm(),true);
  const next=issueRecovery(db,id,'312456',time).recoveryCode;
  recoverAccount(db,next,'312456','third-device',++time);
  const [second]=changes.history(id);
  assert.equal(second.currentFingerprint,'third-device');
  changes.review(id,first.id,()=>reviews++);
  changes.review(id,first.id,()=>reviews++);
  assert.equal(reviews,1);
  assert.equal(changes.history(id)[0].id,second.id);
  assert.equal(alarm(),true);
  time+=DEVICE_CHANGE_RETENTION;
  changes.sweep();
  assert.equal(alarm(),true);
  assert.deepEqual(changes.history(id).map(row=>row.id),[second.id]);
  changes.review(id,second.id,()=>reviews++);
  assert.equal(alarm(),false);
  assert.equal(changes.history(id)[0].reviewedAt,time);
  db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  assert.deepEqual(changes.history(id),[]);
 }finally{db.close();}
});
test('desktop admin keys do not consume or transfer mobile slots, and reject normal keys',()=>{
 const db=setup();try{
 let time=now;const key=createSupportKey(db,now),sessions=createControlSessions(db,()=>time);
 assert.throws(()=>sessions.login('QZU-'+ 'A'.repeat(48)));
 assert.throws(()=>sessions.login('QZU-ADMIN-'+ 'A'.repeat(48)));
 const {token,id}=sessions.login(key,'');assert.equal(sessions.check(token).id,id);assert.deepEqual(sessions.activeDesktopIds(),[id]);
 const slot=db.prepare('SELECT redeemed,account FROM support_keys').get();
 assert.equal(slot.redeemed,null);assert.equal(slot.account,id);
 const a=redeemAccess(db,key,now+1,'admin-device');assert.equal(a.id,id);assert.equal(sessions.check(token),null);
 setLogin(db,a.id,'123456');assert.throws(()=>sessions.login(key,''));
 const linked=sessions.login(key,'123456');assert.equal(sessions.check(linked.token).id,id);
 assert.equal(findDeviceAccount(db,'admin-device').id,id);
 releaseSupportKey(db,id);assert.equal(sessions.check(linked.token),null);
 const fresh=sessions.login(key,'');time+=15*60000;assert.equal(sessions.check(fresh.token),null);
 const again=sessions.login(key,'');const replacement=rotateSupportKey(db,key);assert.equal(sessions.check(again.token),null);assert.throws(()=>sessions.login(key,''));const updated=sessions.login(replacement,'');assert.equal(updated.id,id);db.prepare('DELETE FROM support_keys').run();assert.equal(sessions.check(updated.token),null);
 }finally{db.close();}
});
test('Control Center accepts desktop Windows and macOS browser identifiers and rejects mobile identifiers',()=>{
 assert.equal(desktopControlAllowed('Mozilla/5.0 (Windows NT 10.0; Win64; x64)','?0','"Windows"'),true);
 assert.equal(desktopControlAllowed('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'),true);
 assert.equal(desktopControlAllowed('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile'),false);
 assert.equal(desktopControlAllowed('Mozilla/5.0 (Linux; Android 15) Mobile'),false);
 assert.equal(desktopControlAllowed('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)','?1'),false);
 assert.equal(desktopControlAllowed('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)','','"Android"'),false);
 assert.equal(desktopControlAllowed(''),false);
});

test('archive only accepts terminal records, separates lists and restores without deleting records',()=>{
 const db=setup();try{
 const c=complianceStore(db,()=>now),f=feedbackStore(db,()=>now);initPaymentTickets(db);const t=paymentTickets(db,()=>now);
 const a=createAccount(db,'reporter'),b=createAccount(db,'reported'),r=c.report(a.id,b.id,'room','Other','Test',null,[],'unknown');
 const item=f.submit('Feedback',true),o=createCryptoInvoice(db,'week','BTC',100000,null,now,null,true),ticket=t.open(o.id);
 for(const [category,id] of [['reports',r.id],['feedback',item.id],['payment-tickets',ticket.id],['payments',o.id]])assert.throws(()=>archiveControlRecord(db,category,id,'admin',false,now));
 c.resolve(r.id,'dismiss','admin','solved');f.status(true,item.id,'solved','admin');t.send(ticket.id,'customer',{text:'test',requestId:randomUUID()},o.id);t.reject(ticket.id,'admin','Incorrect payment');
 for(const [category,id] of [['reports',r.id],['feedback',item.id],['payment-tickets',ticket.id]])archiveControlRecord(db,category,id,'admin',false,now);
 assert.equal(c.list(true).length,0);assert.equal(c.list(true,true)[0].id,r.id);
 assert.equal(f.list(true).length,0);assert.equal(f.list(true,Number.MAX_SAFE_INTEGER,true)[0].id,item.id);
 assert.equal(t.list().length,0);assert.equal(t.list(true)[0].id,ticket.id);assert.equal(t.view(ticket.id,o.id,o.orderKey).messages.length,1);
 for(const [category,id] of [['reports',r.id],['feedback',item.id],['payment-tickets',ticket.id]])archiveControlRecord(db,category,id,'admin',true,now);
 assert.equal(c.list(true).length,1);assert.equal(f.list(true).length,1);assert.equal(t.list().length,1);
 db.prepare("UPDATE access_invoices SET state='rejected' WHERE id=?").run(o.id);
 archiveControlRecord(db,'payments',o.id,'admin',false,now);assert.equal(controlPayments(db).length,0);assert.equal(controlPayments(db,true)[0].id,o.id);
 }finally{db.close();}
});
test('solved and rejected support cases archive only for assigned admin and reopen on new customer message',()=>{
 const db=setup();try{
 const chats=new Chats(()=>now);chats.attachSupportStore(db);const id=chats.openMobileSupport('customer','agent',true);
 chats.send('customer',id,'Help');assert.throws(()=>chats.finishSupport('agent',id,'archive'));assert.throws(()=>chats.finishSupport('other',id,'solve'));
 chats.finishSupport('agent',id,'solve');chats.finishSupport('agent',id,'archive');assert.equal(chats.finishedSupport('agent').length,0);assert.equal(chats.finishedSupport('agent',true)[0].messages[0].text,'Help');
 chats.send('customer',id,'More help');assert.equal(chats.finishedSupport('agent',true).length,0);assert.equal(chats.supportRequests('agent',true)[0].id,id);
 }finally{db.close();}
});

test('expired pending invoices can be archived and a late valid submission returns to the working list',()=>{
 const db=setup();try{
 const o=createCryptoInvoice(db,'week','BTC',100000,null,now,null,true),later=now+3600000;
 assert.throws(()=>archiveControlRecord(db,'payments',o.id,'admin',false,now));
 archiveControlRecord(db,'payments',o.id,'admin',false,later);
 assert.equal(controlPayments(db,true)[0].id,o.id);assert.equal(invoiceStatus(db,o.orderKey,later).state,'expired');
 submitPayment(db,o.orderKey,'b'.repeat(64),later);assert.equal(controlPayments(db)[0].id,o.id);assert.equal(controlPayments(db,true).length,0);
 }finally{db.close();}
});
