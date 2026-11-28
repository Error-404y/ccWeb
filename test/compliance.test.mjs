import test from 'node:test';import assert from 'node:assert/strict';import {openAccounts,createAccount} from '../lib/accounts.mjs';import {initDevices} from '../lib/devices.mjs';import {initAccess} from '../lib/access.mjs';import {contactStore} from '../lib/contacts.mjs';import {initActivity} from '../lib/activity.mjs';import {officialStore} from '../lib/official.mjs';import {privatePush} from '../lib/push.mjs';import {complianceStore} from '../lib/compliance.mjs';
import {randomUUID} from 'node:crypto';
test('deletion code, terms, reports and account purge',()=>{const db=openAccounts(':memory:');initDevices(db);initAccess(db);initActivity(db);contactStore(db);officialStore(db);privatePush(db);const c=complianceStore(db);const a=createAccount(db,'a'),b=createAccount(db,'b');assert.throws(()=>c.accept(a.id,0));c.accept(a.id,1);const first=c.deletionCode(a.id),second=c.deletionCode(a.id);assert.equal(c.byDeletionCode(first),null);assert.equal(c.byDeletionCode(second),a.id);const r=c.report(a.id,b.id,'room','Spam or scam','test');assert.equal(c.list()[0].id,r.id);assert.equal(c.resolve(r.id,'suspend').target,b.id);assert.equal(c.suspended('b'),true);c.purge(a.id);assert.equal(c.byDeletionCode(second),null);assert.equal(db.prepare('SELECT id FROM accounts WHERE id=?').get(a.id),undefined);assert.equal(db.prepare('SELECT reporter FROM abuse_reports WHERE id=?').get(r.id).reporter,null);db.close();});
test('moderation records contextual evidence, supports temporary restrictions and reinstatement',()=>{const db=openAccounts(':memory:');initDevices(db);initAccess(db);initActivity(db);contactStore(db);officialStore(db);privatePush(db);let now=Date.now();const c=complianceStore(db,()=>now),a=createAccount(db,'a'),b=createAccount(db,'b');const report=c.report(a.id,b.id,'room','Harassment','details','m1',[{id:'m1',sender:'Reported account',at:now,reported:true,text:'selected',source:'reporter-submitted'}],'encrypted direct');assert.equal(c.list()[0].context[0].text,'selected');c.resolve(report.id,'suspend24h','admin','reviewed');assert.equal(c.list().length,0);assert.equal(c.list(true)[0].history[0].action,'suspend24h');assert.equal(c.suspended('b'),true);now+=86400001;c.sweep();assert.equal(c.suspended('b'),false);assert.equal(db.prepare('SELECT suspended FROM accounts WHERE id=?').get(b.id).suspended,0);c.reinstate(b.id,'admin','restored');assert.equal(c.list(true)[0].history[0].action,'reinstate');db.close();});

test('report attachments are scoped, stored outside report list and expire',()=>{const db=openAccounts(':memory:');initDevices(db);initAccess(db);initActivity(db);contactStore(db);officialStore(db);privatePush(db);let now=Date.now();const c=complianceStore(db,()=>now),a=createAccount(db,'a'),b=createAccount(db,'b');const report=c.report(a.id,b.id,'room','Harassment','','m',[],'encrypted direct',{messageId:'m',kind:'image',mime:'image/png',body:Buffer.from('test'),source:'reporter-submitted',at:now});assert.equal(c.list()[0].attachment.kind,'image');assert.equal(c.list()[0].attachment.body,undefined);assert.equal(Buffer.from(c.media(report.id).body).toString(),'test');now+=91*86400000;c.sweep();assert.equal(c.media(report.id),null);assert.equal(c.list().length,0);db.close();});

test('report follow-ups survive a restart and follow the report retention window',()=>{
  const db=openAccounts(':memory:');
  let now=Date.now();
  const a=createAccount(db),b=createAccount(db),admin=createAccount(db);
  let compliance=complianceStore(db,()=>now);
  try{
    const {id}=compliance.report(a.id,b.id,'room','Harassment');
    const requestId=randomUUID();
    compliance.followUps.request(id,admin.id,{requestId,text:'How many messages arrived?'});
    compliance=complianceStore(db,()=>now);
    const pending=compliance.followUps.get(a.id,id);
    assert.equal(pending.status,'in-review');
    assert.equal(pending.awaitingReply,true);
    assert.equal(compliance.followUps.pendingCount(a.id),1);
    assert.deepEqual(compliance.followUps.list(b.id),[]);
    now+=100;
    compliance.followUps.reply(a.id,id,{requestId,text:'Three.'});
    assert.equal(compliance.followUps.forStaff(id)[0].reply,'Three.');
    const orphan=compliance.report(a.id,b.id,'another room','Other').id;
    compliance.followUps.request(orphan,admin.id,{requestId:randomUUID(),text:'Can you clarify?'});
    db.prepare('DELETE FROM abuse_reports WHERE id=?').run(orphan);
    compliance.sweep();
    assert.deepEqual(compliance.followUps.forStaff(orphan),[]);
    now+=91*86400000;
    assert.throws(()=>compliance.followUps.get(a.id,id),{status:404});
    assert.throws(()=>compliance.followUps.request(id,admin.id,{requestId:randomUUID(),text:'Expired request'}),{status:404});
    compliance.sweep();
    assert.deepEqual(compliance.followUps.forStaff(id),[]);
  }finally{db.close();}
});
