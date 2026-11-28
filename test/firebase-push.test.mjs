import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { firebaseDelivery } from '../lib/firebase-push.mjs';
import { privatePush } from '../lib/push.mjs';
test('FCM uses scoped signed OAuth, cached token and generic notification only',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const calls=[];
 const deliver=firebaseDelivery({type:'service_account',project_id:'example-project',client_email:'service@example.test',private_key:privateKey.export({format:'pem',type:'pkcs8'})},{now:()=>1000000,request:async(url,options)=>{
  calls.push({url,options});
  if(url.includes('oauth2.'))return {ok:true,json:async()=>({access_token:'test-token',expires_in:3600})};
  return {ok:true};
 }});
 await Promise.all([deliver('token1'),deliver('token2')]);
 assert.equal(calls.length,3);
 const [head,body,sig]=calls[0].options.body.get('assertion').split('.');
 assert.ok(verify('RSA-SHA256',Buffer.from(head+'.'+body),publicKey,Buffer.from(sig,'base64url')));
 assert.equal(JSON.parse(Buffer.from(body,'base64url')).scope,'https://www.googleapis.com/auth/firebase.messaging');
 const message=JSON.parse(calls[1].options.body).message;
 assert.deepEqual(message.notification,{title:'qzu.',body:'New activity. Open qzu. to view.'});
 assert.equal(message.data,undefined);
 assert.equal(message.android.ttl,'60s');
 assert.equal(calls[1].options.headers.Authorization,'Bearer test-token');
 await deliver('token1',1,{version:'0.17.16'});
 const update=JSON.parse(calls.at(-1).options.body).message;
 assert.equal(update.notification.title,'New update available');
 assert.deepEqual(update.data,{kind:'app-update',version:'0.17.16'});
 assert.equal(update.android.notification.tag,'qzu_update');
});
test('Android-only push rejects iOS and removes invalid tokens',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,pin_state TEXT,access_plan TEXT,paid_until INTEGER,access_revoked INTEGER DEFAULT 0,suspended INTEGER DEFAULT 0,suspended_until INTEGER);INSERT INTO accounts(id,pin_state,access_plan,paid_until) VALUES('a','ready','lifetime',NULL)");
 const service=privatePush(db,{firebase:async()=>({unregistered:true})});
 assert.deepEqual(service.platforms,['android']);
 assert.throws(()=>service.register('a','ios','a'.repeat(64)));
 service.register('a','android','a'.repeat(64));service.notify(['a']);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(service.registered('a'),false);db.close();
});

test('push self test exposes only safe diagnostic result',async()=>{const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,pin_state TEXT,access_plan TEXT,paid_until INTEGER,access_revoked INTEGER DEFAULT 0,suspended INTEGER DEFAULT 0,suspended_until INTEGER);INSERT INTO accounts(id,pin_state,access_plan,paid_until) VALUES('a','ready','lifetime',NULL)");let count;const service=privatePush(db,{firebase:async(token,n)=>{count=n;return {ok:true};},unread:()=>5});assert.deepEqual(await service.test('a'),{result:'not-registered'});service.register('a','android','a'.repeat(64));assert.deepEqual(await service.test('a'),{result:'accepted'});assert.equal(count,5);assert.equal(service.diagnostic('a').result,'accepted');db.close();});

test('release alerts reach older direct Android builds once per version',async t=>{
 const db=new DatabaseSync(':memory:');
 t.after(()=>db.close());
 db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,pin_state TEXT DEFAULT 'active',access_plan TEXT DEFAULT 'lifetime',
   paid_until INTEGER,access_revoked INTEGER DEFAULT 0,suspended INTEGER DEFAULT 0,suspended_until INTEGER);
   INSERT INTO accounts(id) VALUES ('direct'),('play'),('current'),('legacy'),('suspended');
   UPDATE accounts SET suspended=1 WHERE id='suspended';`);
 const deliveries=[];
 const push=privatePush(db,{firebase:async(token,count,update)=>{deliveries.push({token,update});return {ok:true};}});
 const direct={distribution:'direct',version:'0.17.15'};
 push.register('direct','android','a'.repeat(64),direct);
 push.register('play','android','b'.repeat(64),{...direct,distribution:'google-play'});
 push.register('current','android','c'.repeat(64),{...direct,version:'0.17.16'});
 push.register('legacy','android','d'.repeat(64));
 push.register('suspended','android','e'.repeat(64),direct);
 await push.announceRelease('0.17.16');
 await push.announceRelease('0.17.16');
 assert.deepEqual(deliveries,[{token:'a'.repeat(64),update:{version:'0.17.16'}}]);
});
