import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {generateKeyPairSync, randomBytes, randomUUID, sign} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {openAccounts, createAccount, digest} from '../lib/accounts.mjs';
import {accessKeyInventory, applyRenewal, createSupportKey, generatePlanKeys, initAccess, redeemAccess} from '../lib/access.mjs';
import {complianceStore} from '../lib/compliance.mjs';
import {initPayments} from '../lib/crypto-payments.mjs';
import {deviceProfiles, initDevices} from '../lib/devices.mjs';

function testDevice() {
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const point=keys.publicKey.export({format:'jwk'});
  const bytes=Buffer.concat([Buffer.from([4]),Buffer.from(point.x,'base64url'),Buffer.from(point.y,'base64url')]);
  const fingerprint=digest(bytes);
  let unlock='';
  return {fingerprint,async fetch(origin,path,payload){
    const method=payload===undefined?'GET':'POST', body=payload===undefined?'':JSON.stringify(payload);
    const at=String(Date.now()), nonce=randomBytes(16).toString('hex');
    const message=JSON.stringify(['qzu-device-v1',method,path,at,nonce,unlock,body]);
    const response=await globalThis.fetch(origin+path,{method,body:method==='POST'?body:undefined,headers:{
      'X-QZU':'1','X-QZU-Unlock':unlock,'X-QZU-Device':bytes.toString('base64'),'X-QZU-Time':at,'X-QZU-Nonce':nonce,
      'X-QZU-Signature':sign('sha256',Buffer.from(message),keys.privateKey).toString('base64'),'Content-Type':'application/json'
    }});
    const value=await response.json();
    if(path==='/api/login/setup'&&response.ok)unlock=value.token;
    return {status:response.status,value};
  }};
}

test('key inventory paginates stable rows sharing a timestamp', () => {
  const db = openAccounts(':memory:');
  try {
    initAccess(db);
    generatePlanKeys(db, 'LT', 100, 'developer', 1000);
    const extra = generatePlanKeys(db, 'LT', 1, 'developer', 1000).keys[0];
    const first = accessKeyInventory(db);
    const second = accessKeyInventory(db,'',{after:first.nextCursor});
    assert.equal(first.items.length,100);
    assert.equal(second.items.length,1);
    assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,101);
    assert.deepEqual(first.counts,{unused:101,redeemed:0,revoked:0});
    assert.equal(accessKeyInventory(db, extra.key).items[0].id, extra.id);
    db.prepare('DELETE FROM access_invoices WHERE id=?').run(first.items.at(-1).id);
    assert.equal(accessKeyInventory(db,'',{after:first.nextCursor}).items[0].id,second.items[0].id);
  } finally {
    db.close();
  }
});

test('device profiles accept the registered app identity and reset on device changes', () => {
  const db = openAccounts(':memory:');
  try {
    initDevices(db);
    const id = createAccount(db,'a'.repeat(64)).id;
    const profiles = deviceProfiles(db,()=>1000);
    const account = db.prepare('SELECT id,device_id FROM accounts WHERE id=?');
    const update = db.prepare('UPDATE accounts SET device_id=? WHERE id=?');
    assert.equal(profiles.update(account.get(id),'wrong','android'),false);
    assert.equal(profiles.update(account.get(id),'a'.repeat(64),'android',{model:'Pixel 10',osVersion:'16',appVersion:'0.17.9'}),true);
    profiles.update(account.get(id),'a'.repeat(64),'android',{model:'\u202eInvalid'});
    assert.equal(profiles.get(id).model,'Pixel 10');
    assert.equal(profiles.get(id).source,'app-reported');
    update.run('b'.repeat(64),id);
    assert.equal(profiles.get(id).model,null);
    profiles.update(account.get(id),'b'.repeat(64),'ios');
    assert.deepEqual(profiles.get(id),{platform:'ios',model:null,osVersion:null,appVersion:null,
      fingerprint:'b'.repeat(64),registeredAt:1000,lastSeenAt:1000,source:'signed-session'});
  } finally {
    db.close();
  }
});

test('Control reports audit submitted chat access and key removal preserves the paid ledger', {timeout:30000}, async t => {
  const dir = mkdtempSync(join(tmpdir(),'qzu-control-'));
  const database = join(dir,'accounts.sqlite');
  const db = openAccounts(database);
  initDevices(db);
  initAccess(db);
  initPayments(db);
  const adminKey = createSupportKey(db);
  const [used, renewal, unused, paid, protectedKey] = generatePlanKeys(db,'1M',5).keys;
  const targetDevice=testDevice(), reporterDevice=testDevice(), otherDevice=testDevice();
  const target = redeemAccess(db,used.key,Date.now(),targetDevice.fingerprint).id;
  applyRenewal(db,renewal.key,target);
  const other = redeemAccess(db,paid.key,Date.now(),reporterDevice.fingerprint).id;
  const seller = redeemAccess(db,protectedKey.key,Date.now(),otherDevice.fingerprint).id;
  db.prepare("UPDATE accounts SET access_plan='seller' WHERE id=?").run(seller);
  db.prepare("UPDATE access_invoices SET generated=0, coin='LTC', usd_cents=599, txid=?, vout=1, verified_at=? WHERE id=?")
    .run('f'.repeat(64),Date.now(),paid.id);
  deviceProfiles(db).update({id:target,device_id:targetDevice.fingerprint},targetDevice.fingerprint,'android',{model:'Test phone',osVersion:'16',appVersion:'0.17.9'});
  const reports = complianceStore(db);
  const messageId = randomUUID(), now = Date.now();
  const context = [{id:messageId,at:now,sender:'Reported account',text:'Submitted chat excerpt',source:'reporter',reported:true}];
  const report = reports.report(other,target,randomUUID(),'Spam or scam','Reporter statement',messageId,context,'direct',
    {messageId,kind:'image',mime:'image/png',body:Buffer.from('fixture'),source:'reporter',at:now}).id;
  const agedReport = complianceStore(db,()=>now-91*86400000).report(other,target,randomUUID(),'Other').id;
  db.close();

  const listener = net.createServer();
  listener.listen(0,'127.0.0.1');
  await once(listener,'listening');
  const port = listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const origin = 'http://127.0.0.1:'+port;
  const server = spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',PORT:String(port),HOST:'127.0.0.1',
    QZU_DB:database,QZU_ADMIN_DIR:join(dir,'admin'),QZU_MOBILE_ONLY:'true'},stdio:['ignore','pipe','pipe']});
  const exited = once(server,'exit');
  let output = '';
  server.stdout.on('data',chunk=>output+=chunk);
  server.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{server.kill();await exited;rmSync(dir,{recursive:true,force:true});});
  for (let i=0;i<100;i++) {
    try { if ((await fetch(origin+'/healthz')).ok) break; } catch {}
    if (i===99 || server.exitCode!==null) throw Error('Fixture server failed to start: '+output);
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  let cookie = '';
  async function control(path, payload) {
    const response = await fetch(origin+'/api/control/'+path,{method:payload===undefined?'GET':'POST',
      headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)','X-QZU':'1','Content-Type':'application/json',Cookie:cookie},
      body:payload===undefined?undefined:JSON.stringify(payload)});
    const auth = response.headers.get('Set-Cookie');
    if (auth) cookie = auth.split(';')[0];
    return {status:response.status,value:response.headers.get('Content-Type')?.includes('json')?await response.json():await response.text()};
  }
  const evidence = 'reports/'+report+'/evidence';
  const reportPath = '/api/reports/mine/'+report;
  assert.equal((await control(evidence)).status,401);
  assert.equal((await control('reports/follow-up',{id:report,requestId:randomUUID(),text:'Request'})).status,401);
  assert.equal((await control('keys/purge-used/preview',{})).status,401);
  assert.equal((await reporterDevice.fetch(origin,reportPath)).status,423);
  for(const device of [targetDevice,reporterDevice,otherDevice]){
    assert.equal((await device.fetch(origin,'/api/login/setup',{pin:'146298'})).status,200);
  }
  assert.equal((await control('login',{key:adminKey,pin:''})).status,200);
  const overview = (await control('overview')).value.totals;
  assert.deepEqual(overview.payments,{submitted:0,confirmed:1,verifiedUsdCents:599,confirmedLegacyEurCents:0});
  assert.equal(overview.accounts.retired,1);
  const {record} = (await control('cases/report/'+report)).value;
  assert.deepEqual(record.snapshot,{messageCount:1,hasAttachment:true});
  assert.equal(record.evidence,'Reporter statement');
  assert.equal(record.context,undefined);
  assert.equal(record.reportedAccount.id,target);
  assert.equal(record.reportedAccount.device.model,'Test phone');
  assert.equal(record.reporterAccount.id,other);
  const {items:[listed]} = (await control('reports')).value;
  assert.deepEqual(listed.snapshot,record.snapshot);
  assert.equal(listed.context,undefined);
  assert.deepEqual((await control(evidence)).value.context,context);
  assert.equal((await control('reports/media/'+report)).value,'fixture');
  assert.equal((await control('reports/'+agedReport+'/evidence')).status,404);
  assert.deepEqual((await control('audit?type=report')).value.items.map(row=>row.action),['reports/evidence-attachment','reports/evidence-view']);
  assert.equal((await control('accounts?q='+report)).value.items[0].id,target);
  const reportState=async()=> (await reporterDevice.fetch(origin,reportPath)).value;
  const received=await reportState();
  assert.deepEqual(Object.keys(received).sort(),['awaitingReply','closedAt','followUps','id','reason','receivedAt','reviewedAt','status']);
  assert.equal(received.status,'received');
  assert.equal(received.reviewedAt,null);
  assert.equal((await targetDevice.fetch(origin,reportPath)).status,404);
  assert.equal((await otherDevice.fetch(origin,reportPath)).status,404);
  assert.equal((await reporterDevice.fetch(origin,'/api/reports/mine/'+agedReport)).status,404);
  const followUp={id:report,requestId:randomUUID(),text:'What happened before the reported message?'};
  assert.equal((await reporterDevice.fetch(origin,'/api/control/reports/follow-up',followUp)).status,403);
  assert.equal((await control('cases/report/'+report,{action:'claim'})).status,200);
  const reviewing=await reportState();
  assert.equal(reviewing.status,'in-review');
  assert.ok(reviewing.reviewedAt>=received.receivedAt);
  assert.equal((await control('reports/follow-up',followUp)).status,200);
  assert.equal((await control('reports/follow-up',followUp)).status,200);
  assert.equal((await control('reports/follow-up',{...followUp,requestId:randomUUID()})).status,409);
  const awaiting=await reportState();
  assert.equal(awaiting.awaitingReply,true);
  assert.equal(awaiting.followUps[0].request,followUp.text);
  assert.equal(awaiting.followUps[0].requested_by,undefined);
  assert.equal((await reporterDevice.fetch(origin,'/api/state')).value.pendingReportFollowups,1);
  const reply={requestId:followUp.requestId,text:'They sent the same offer twice.'};
  assert.equal((await targetDevice.fetch(origin,reportPath+'/reply',reply)).status,404);
  assert.equal((await otherDevice.fetch(origin,reportPath+'/reply',reply)).status,404);
  assert.equal((await reporterDevice.fetch(origin,reportPath+'/reply',reply)).status,200);
  assert.equal((await reporterDevice.fetch(origin,reportPath+'/reply',reply)).status,200);
  assert.equal((await reporterDevice.fetch(origin,reportPath+'/reply',{...reply,text:'Replacement'})).status,409);
  assert.equal((await control('cases/report/'+report)).value.record.followUps[0].reply,reply.text);
  assert.equal((await reporterDevice.fetch(origin,'/api/state')).value.pendingReportFollowups,0);
  assert.equal((await control('reports/resolve',{id:report,action:'dismiss',notes:'Internal review note'})).status,200);
  const closed=await reportState();
  assert.equal(closed.status,'closed');
  assert.equal(closed.reviewedAt,reviewing.reviewedAt);
  assert.ok(closed.closedAt>=closed.reviewedAt);
  assert.equal(JSON.stringify(closed).includes('Internal review note'),false);
  assert.equal((await control('reports/follow-up',{...followUp,requestId:randomUUID()})).status,409);
  const preview = (await control('keys/purge-used/preview',{})).value;
  const {previewToken,...counts} = preview;
  assert.deepEqual(counts,{keys:3,accounts:2,retainedPayments:1});
  assert.equal((await control('keys/purge-used',{confirmation:'typo',previewToken})).status,400);
  const confirmation = 'REMOVE USED KEYS AND ACCOUNTS';
  assert.equal((await control('keys/purge-used',{confirmation,previewToken:'stale'})).status,409);
  assert.equal((await control('keys?q='+used.id)).value.items.length,1);
  assert.deepEqual((await control('keys/purge-used',{confirmation,previewToken})).value,{removedKeys:3,deletedAccounts:2,retainedPayments:1});
  assert.equal((await reporterDevice.fetch(origin,reportPath)).status,401);
  assert.equal((await control('keys/purge-used',{confirmation,previewToken})).status,409);
  assert.deepEqual((await control('keys')).value.items.map(row=>row.id).sort(),[unused.id,protectedKey.id].sort());
  assert.equal((await control('accounts/'+target)).status,404);
  assert.equal((await control('accounts/'+seller)).status,200);
  assert.equal((await control('overview')).value.totals.payments.verifiedUsdCents,599);
  const cleanupAudit=(await control('audit?type=key&outcome=success')).value.items.find(item=>item.action==='keys/purge-used');
  assert.equal(cleanupAudit.detail,'3 keys removed, 2 accounts deleted, 1 payment record kept');
  const after = openAccounts(database);
  try {
    const row = after.prepare('SELECT * FROM access_invoices WHERE id=?').get(paid.id);
    assert.equal(row.txid,'f'.repeat(64));
    assert.equal(row.vout,1);
    assert.ok(row.key_erased);
    assert.notEqual(row.secret,digest(paid.key));
    assert.equal(row.redeemed_account,null);
    assert.equal(after.prepare('SELECT 1 FROM device_profiles WHERE account=?').get(target),undefined);
  } finally {
    after.close();
  }
});
