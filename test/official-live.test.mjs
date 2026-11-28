import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {officialStore} from '../lib/official.mjs';
import {feedbackStore} from '../lib/feedback.mjs';
import {createLiveWakeup,versionedState} from '../lib/live.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {Chats} from '../lib/chats.mjs';
import {privatePush} from '../lib/push.mjs';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('official posts persist and read cursors are independent, monotonic and admin-only',()=>{
  const db=new DatabaseSync(':memory:');let channel=officialStore(db,()=>100);
  assert.throws(()=>channel.publish('Not authorized'));
  assert.throws(()=>channel.publish(' ',true));
  const first=channel.publish('Hello everyone',true).id;
  assert.equal(channel.snapshot('a').unread,true);
  assert.equal(channel.snapshot('b').posts[0].text,'Hello everyone');
  channel.mark('a',first);
  assert.equal(channel.snapshot('a').unread,false);
  assert.equal(channel.snapshot('b').unread,true);
  const second=channel.publish('Second post',true).id;
  channel.mark('a',second);channel.mark('a',first);
  assert.equal(channel.snapshot('a').seen,second);
  assert.throws(()=>channel.mark('a',second+1));
  channel=officialStore(db);assert.equal(channel.snapshot('new').posts.length,2);
  db.close();
});
test('state revision ignores clocks and changes on messages or deletion',()=>{
  const a=versionedState({now:1,rooms:[{id:'a'}],official:{unread:false}});
  assert.equal(versionedState({now:2,rooms:[{id:'a'}],official:{unread:false}},a.revision).unchanged,true);
  assert.notEqual(versionedState({now:3,rooms:[],official:{unread:false}},a.revision).revision,a.revision);
  assert.notEqual(versionedState({now:3,rooms:[{id:'a'}],official:{unread:true}},a.revision).revision,a.revision);
});
test('paged announcements span the read boundary and allow both directions of history',()=>{
  const db=new DatabaseSync(':memory:');
  const channel=officialStore(db);
  for(let id=1;id<=120;id++)channel.publish('Announcement '+id,true);
  channel.mark('reader',50);
  channel.remove(51,true);
  const feed=channel.snapshot('reader',{paged:true});
  assert.equal(feed.unreadCount,69);
  assert.equal(feed.posts[0].id,21);
  assert.equal(feed.posts[30].id,52);
  assert.equal(feed.posts.at(-1).id,81);
  assert.equal(feed.hasOlder,true);
  assert.equal(feed.hasNewer,true);
  const previous=channel.history(feed.posts[0].id,{paged:true});
  const next=channel.history(feed.posts.at(-1).id,{forward:true});
  assert.equal(previous.posts.at(-1).id,20);
  assert.equal(previous.hasOlder,false);
  assert.equal(next.posts[0].id,82);
  assert.equal(next.hasNewer,false);
  assert.equal(next.deletedRevision,feed.deletedRevision);
  assert.equal(channel.recent().posts.length,40);
  assert.equal(channel.snapshot('reader').posts.length,119);
  db.close();
});
test('live wakeups coalesce writes and skip removed subscribers',async()=>{
  const changes=createLiveWakeup(5),checks=[];
  changes.subscribe(()=>checks.push('active'));
  const unsubscribe=changes.subscribe(()=>checks.push('closed'));
  changes.changed();changes.changed();unsubscribe();
  await delay(25);
  assert.deepEqual(checks,['active']);
});
test('code lifetime choices',()=>{
  let now=100;const chats=new Chats(()=>now);
  assert.throws(()=>chats.newCode('a',60));
  assert.equal(chats.newCode('a',5).expires,now+300000);
  assert.equal(chats.newCode('a',15).expires,now+900000);
});

test('private push relay only sends generic payload and respects opt out',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,pin_state TEXT,access_plan TEXT,paid_until INTEGER);INSERT INTO accounts VALUES('a','ready','lifetime',NULL),('b','ready','lifetime',NULL)");
  const calls=[];const service=privatePush(db,{url:'https://relay.example/push',secret:'example',fetch:async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:true};}});
  service.register('a','ios','a'.repeat(64));service.register('b','android','b'.repeat(64));
  assert.throws(()=>service.register('b','ios','a'.repeat(64)));
  service.notify(['a']);service.notify(['a']);await Promise.resolve();
  assert.deepEqual(calls,[{platform:'ios',token:'a'.repeat(64),title:'qzu.',body:'New activity. Open qzu. to view.'}]);
  service.remove('b');service.broadcast('a');await Promise.resolve();assert.equal(calls.length,1);
  db.close();
});
test('room deletion scrubs stale server references',()=>{
  const chats=new Chats(),id=chats.connectPair('a','b');chats.send('a',id,'secret');
  const old=chats.rooms.get(id),message=old.messages[0];
  chats.remove('a',id);assert.equal(message.text,'');assert.equal(old.messages.length,0);assert.equal(chats.snapshot('b').length,0);
});
test('backup excludes support content and push tokens while preserving account and official data',()=>{
  const dir=mkdtempSync(join(tmpdir(),'qzu-backup-'));
  try{
    const input=join(dir,'source.sqlite'),output=join(dir,'backup.sqlite');
    const db=new DatabaseSync(input);
    db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES('a');CREATE TABLE mobile_support_rooms(id TEXT PRIMARY KEY,body TEXT);INSERT INTO mobile_support_rooms VALUES('r','sensitive-support-text');CREATE TABLE push_devices(account TEXT PRIMARY KEY,token TEXT);INSERT INTO push_devices VALUES('a','sensitive-push-token')");
    const feedback=feedbackStore(db);
    const entry=feedback.submit('sensitive-feedback',true);
    feedback.status(true,entry.id,'help','admin','sensitive-feedback-note');
    db.exec("CREATE TABLE report_collaboration (note TEXT);INSERT INTO report_collaboration VALUES ('sensitive-moderation-note')");
    db.exec(`CREATE TABLE report_followups (reply_text TEXT); INSERT INTO report_followups VALUES ('sensitive-reporter-reply');
      CREATE TABLE seller_stock_alerts (buyer TEXT); INSERT INTO seller_stock_alerts VALUES ('sensitive-stock-watcher');
      CREATE TABLE seller_catalog_drafts (name TEXT); INSERT INTO seller_catalog_drafts VALUES ('sensitive-listing-draft')`);
    officialStore(db,()=>100).publish('Official post',true);db.close();
    execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/privacy-backup.mjs',import.meta.url)),output],{env:{...process.env,QZU_DB:input}});
    const copy=new DatabaseSync(output,{readOnly:true});
    assert.equal(copy.prepare('SELECT count(*) AS n FROM accounts').get().n,1);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM official_posts').get().n,1);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM mobile_support_rooms').get().n,0);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM push_devices').get().n,0);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM feedback_events').get().n,0);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM report_collaboration').get().n,0);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM report_followups').get().n,0);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM seller_stock_alerts').get().n,0);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM seller_catalog_drafts').get().n,0);
    copy.close();
    const bytes=readFileSync(output);
    for(const content of ['sensitive-support-text','sensitive-push-token','sensitive-feedback','sensitive-feedback-note',
      'sensitive-moderation-note','sensitive-reporter-reply','sensitive-stock-watcher','sensitive-listing-draft'])assert.equal(bytes.includes(content),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
