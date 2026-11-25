import test from 'node:test';
import assert from 'node:assert/strict';
import {Chats,INVITE_TTL,CHAT_TTL} from '../lib/chats.mjs';
import {openAccounts,createAccount,issuePin,usePin,requestReset,approveReset,findAccount} from '../lib/accounts.mjs';
test('active codes unique, renewal invalidates old code, expiry is manual',()=>{
 let now=0;const seq=['ABC234','ABC234','DEF567','GHI789'];const s=new Chats(()=>now,()=>seq.shift());
 const a=s.newCode('a'),b=s.newCode('b');assert.notEqual(a.code,b.code);
 const c=s.newCode('a');assert.throws(()=>s.connect('b',a.code));assert.equal(c.code,'GHI789');
 now=INVITE_TTL;assert.equal(s.inviteFor('a'),null);assert.throws(()=>s.connect('b',c.code));
});
test('chat lifetime fixed, messages authorized, same conversation deleted for both',()=>{
 let now=0;const s=new Chats(()=>now);const id=s.connect('b',s.newCode('a').code);
 assert.throws(()=>s.send('c',id,'no'));s.send('a',id,'hello');
 assert.equal(s.snapshot('b')[0].messages[0].mine,false);
 now=CHAT_TTL-1;s.send('b',id,'last');now=CHAT_TTL;
 assert.equal(s.snapshot('a').length,0);assert.equal(s.snapshot('b').length,0);
 assert.throws(()=>s.send('a',id,'late'));
});
test('emergency removes only involved rooms and own invite',()=>{
 const s=new Chats();const a=s.newCode('a'), b=s.newCode('b');
 s.connect('b',a.code);s.connect('c',a.code);const keep=s.connect('c',b.code);
 s.erase('a');assert.equal(s.snapshot('a').length,0);
 assert.deepEqual(s.snapshot('b').map(r=>r.id),[keep]);assert.equal(s.inviteFor('a'),null);
});
test('PIN is issued once, single-use, developer-approved replacement',()=>{
 const db=openAccounts(':memory:'),a=createAccount(db);
 assert.equal(findAccount(db,a.token).id,a.id);
 const pin=issuePin(db,a.id);assert.match(pin,/^\d{6}$/);assert.equal(issuePin(db,a.id),null);
 assert.equal(usePin(db,a.id,pin),'ok');assert.equal(usePin(db,a.id,pin),'unavailable');
 const ref=requestReset(db,a.id);assert.equal(requestReset(db,a.id),ref);
 assert.equal(approveReset(db,'wrong'),false);assert.equal(approveReset(db,ref),true);
 assert.match(issuePin(db,a.id),/^\d{6}$/);db.close();
});
test('PIN has a persistent retry lock',()=>{
 const db=openAccounts(':memory:'),a=createAccount(db);const pin=issuePin(db,a.id);
 const wrong=pin==='000000'?'000001':'000000';
 for(let i=0;i<5;i++)assert.equal(usePin(db,a.id,wrong,100),'invalid');
 assert.equal(usePin(db,a.id,pin,101),'locked');
 assert.equal(usePin(db,a.id,pin,100+15*60_000),'ok');db.close();
});
