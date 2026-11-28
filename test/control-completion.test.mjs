import test from 'node:test';
import assert from 'node:assert/strict';
import {openAccounts,createAccount,setLogin,findAccount} from '../lib/accounts.mjs';
import {initDevices,findDeviceAccount} from '../lib/devices.mjs';
import {initAccess,createSupportKey,rotateSupportKey,releaseSupportKey,invoiceRow,invoiceStatus,submitPayment,approvePayment,redeemAccess,applyRenewal} from '../lib/access.mjs';
import {initPayments,createCryptoInvoice,inspectTransaction,verifyCryptoInvoice,COINS} from '../lib/crypto-payments.mjs';
import {initControl,issueRecovery,recoverAccount,createControlSessions,desktopControlAllowed,accountAction} from '../lib/control.mjs';
import {complianceStore} from '../lib/compliance.mjs';
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
test('desktop admin keys do not consume or transfer mobile slots, and reject normal keys',()=>{
 const db=setup();try{
 let time=now;const key=createSupportKey(db,now),sessions=createControlSessions(db,()=>time);
 assert.throws(()=>sessions.login('QZU-'+ 'A'.repeat(48)));
 assert.throws(()=>sessions.login('QZU-ADMIN-'+ 'A'.repeat(48)));
 const {token,id}=sessions.login(key,'');assert.equal(sessions.check(token).id,id);
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
