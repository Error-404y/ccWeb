import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {generateKeyPairSync,sign,randomBytes,randomUUID} from 'node:crypto';
import {openAccounts} from '../lib/accounts.mjs';
import {initDevices} from '../lib/devices.mjs';
import {initAccess,createSupportKey,generatePlanKeys} from '../lib/access.mjs';
const desktopUA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const mobileUA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile';
async function port(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const p=server.address().port;await new Promise(resolve=>server.close(resolve));return p;}
function signedClient(origin){
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),j=pair.publicKey.export({format:'jwk'}),publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,'base64url'),Buffer.from(j.y,'base64url')]).toString('base64');
 let unlock='';
 return {async call(path,data){const method=data===undefined?'GET':'POST',body=data===undefined?'':JSON.stringify(data),timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex'),signature=sign('sha256',Buffer.from(JSON.stringify(['qzu-device-v1',method,path,timestamp,nonce,unlock,body])),pair.privateKey).toString('base64');
  const response=await fetch(origin+path,{method,body:method==='POST'?body:undefined,headers:{'User-Agent':mobileUA,'Content-Type':'application/json','X-QZU':'1','X-QZU-Device':publicKey,'X-QZU-Signature':signature,'X-QZU-Time':timestamp,'X-QZU-Nonce':nonce,'X-QZU-Unlock':unlock}});
  const value=await response.json();if(value.token)unlock=value.token;return {status:response.status,value};
 }};
}
test('live HTTP server: desktop authorization, seller activation, announcements and user ticket round trip',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qzu-v17-')),path=join(dir,'accounts.sqlite'),p=await port(),origin='http://127.0.0.1:'+p;
 const db=openAccounts(path);initDevices(db);initAccess(db);const adminKey=createSupportKey(db),normalKey=generatePlanKeys(db,'LT').keys[0].key;db.close();
 const child=spawn(process.execPath,['server.mjs'],{env:{...process.env,NODE_ENV:'test',QZU_DB:path,QZU_ADMIN_DIR:join(dir,'admin'),QZU_MOBILE_ONLY:'true',QZU_ACCESS_REQUIRED:'true',PORT:String(p),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 let cookie='';async function admin(route,data,ua=desktopUA,auth=true){const response=await fetch(origin+route,{method:data===undefined?'GET':'POST',body:data===undefined?undefined:JSON.stringify(data),headers:{'User-Agent':ua,'Content-Type':'application/json','X-QZU':'1',...(auth&&cookie?{Cookie:cookie}:{})}});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return {status:response.status,value:await response.json().catch(()=>null)};}
 try{
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).ok)break;}catch{}if(child.exitCode!==null||i===99)throw Error('Server failed to start: '+output);await new Promise(r=>setTimeout(r,50));}
  assert.equal((await fetch(origin+'/control',{headers:{'User-Agent':mobileUA}})).status,403);
  const controlPage=await fetch(origin+'/control',{headers:{'User-Agent':desktopUA}});
  assert.equal(controlPage.status,200);
  const controlMarkup=await controlPage.text();
  for(const [,src] of controlMarkup.matchAll(/<script src="([^"]+)"/g)){
   const asset=await fetch(new URL(src,origin));
   assert.equal(asset.status,200,src+' must load with mobile-only mode enabled');
   assert.match(asset.headers.get('content-type')||'',/javascript/,src);
  }
  assert.equal((await admin('/api/control/sellers',undefined,desktopUA,false)).status,401);
  assert.equal((await admin('/api/control/login',{key:normalKey,pin:''})).status,403);
  assert.equal((await admin('/api/control/login',{key:adminKey,pin:''})).status,200);
  assert.equal((await admin('/api/control/sellers',undefined,mobileUA)).status,403);
  const generated=await admin('/api/control/sellers/generate',{});assert.equal(generated.status,200);
  const seller=signedClient(origin),customer=signedClient(origin);
  for(const [c,key] of [[seller,generated.value.key],[customer,normalKey]]){
   assert.equal((await c.call('/api/session',{accessKey:key})).status,200);
   const login=await c.call('/api/login/setup',{pin:'123456'});assert.equal(login.status,200);
   assert.equal((await c.call('/api/terms/accept',{version:1})).status,200);
  }
  const list=(await admin('/api/control/sellers')).value.items;assert.equal(list.length,1);const id=list[0].account;
  assert.equal((await admin('/api/control/sellers/verify',{id,verified:true})).status,200);
  const state=await seller.call('/api/state');assert.equal(state.value.sellerVerified,true);assert.equal(state.value.invite.code,list[0].code);
  assert.equal((await seller.call('/api/official/publish',{text:'not admin'})).status,403);
  const {revision}= (await customer.call('/api/state?officialPage=1')).value;
  const live = customer.call('/api/state/live?officialPage=1&since='+revision);
  const announcement=await admin('/api/control/announcements/publish',{text:'Release notice'});assert.equal(announcement.status,200);
  assert.equal((await live).value.official.posts.at(-1).text,'Release notice');
  assert.equal((await customer.call('/api/state')).value.official.posts.at(-1).text,'Release notice');
  assert.equal((await admin('/api/control/announcements/delete',{id:announcement.value.id})).status,200);
  assert.equal((await customer.call('/api/state')).value.official.posts.length,0);
  const t=await customer.call('/api/tickets/open',{topic:'Request a Seller',text:'Hello',requestId:randomUUID()});assert.equal(t.status,200);const tid=t.value.id;
  assert.equal((await admin('/api/control/overview')).value.work.claimableTickets,1);
  assert.equal((await admin('/api/control/tickets?scope=claim')).value.items[0].id,tid);
  assert.equal((await seller.call('/api/tickets/state',{id:tid})).status,404);
  assert.equal((await admin('/api/control/tickets/action',{id:tid,action:'accept'})).status,200);
  const inbox=(await admin('/api/control/inbox')).value.work;
  assert.equal(inbox.claimableTickets,0);
  assert.equal(inbox.assignedTickets,1);
  assert.equal((await admin('/api/control/tickets/action',{id:tid,action:'assign',seller:id})).status,200);
  assert.equal((await seller.call('/api/tickets/send',{id:tid,text:'Seller reply',requestId:randomUUID()})).status,200);
  assert.equal((await customer.call('/api/tickets/state',{id:tid})).value.messages.at(-1).role,'verified-seller');
  assert.equal((await admin('/api/control/sellers/verify',{id,verified:false})).status,200);
  assert.equal((await customer.call('/api/tickets/state',{id:tid})).value.messages.at(-1).role,'seller');
  assert.equal((await admin('/api/control/tickets/action',{id:tid,action:'share',seller:id})).status,200);
  assert.equal((await customer.call('/api/tickets/state',{id:tid})).value.messages.at(-1).text,'Seller connection code: '+list[0].code);
  assert.equal((await admin('/api/control/tickets/action',{id:tid,action:'close'})).status,200);
  assert.equal((await customer.call('/api/tickets/send',{id:tid,text:'Closed',requestId:randomUUID()})).status,409);
  assert.equal((await admin('/api/control/tickets?archived=1')).value.items.length,1);
 }finally{if(child.exitCode===null){child.kill();await once(child,'exit');}rmSync(dir,{recursive:true,force:true});}
});
