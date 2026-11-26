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
});
test('Android-only push rejects iOS and removes invalid tokens',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,pin_state TEXT,access_plan TEXT,paid_until INTEGER);INSERT INTO accounts VALUES('a','ready','lifetime',NULL)");
 const service=privatePush(db,{firebase:async()=>({unregistered:true})});
 assert.deepEqual(service.platforms,['android']);
 assert.throws(()=>service.register('a','ios','a'.repeat(64)));
 service.register('a','android','a'.repeat(64));service.notify(['a']);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(service.registered('a'),false);db.close();
});
