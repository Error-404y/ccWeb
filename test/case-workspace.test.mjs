import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openAccounts, createAccount } from '../lib/accounts.mjs';
import { initAccess } from '../lib/access.mjs';
import { initControl } from '../lib/control.mjs';
import { initActivity, recordActivity } from '../lib/activity.mjs';
import { initDevices } from '../lib/devices.mjs';
import { initPayments } from '../lib/crypto-payments.mjs';
import { initPaymentTickets } from '../lib/payment-tickets.mjs';
import { complianceStore } from '../lib/compliance.mjs';
import { adminAudit } from '../lib/admin-audit.mjs';
import { caseWorkspace } from '../lib/case-workspace.mjs';
import { userTickets } from '../lib/user-tickets.mjs';
import { Chats } from '../lib/chats.mjs';

const day=86400000;

function setup(){
  const db=openAccounts(':memory:');
  initAccess(db);initPayments(db);initControl(db);initActivity(db);initPaymentTickets(db);initDevices(db);
  let time=Date.UTC(2026,10,28);
  const now=()=>time;
  const first=createAccount(db).id, second=createAccount(db).id, owner=createAccount(db).id, peer=createAccount(db).id;
  const admins=new Set([first,second]),isAdmin=id=>admins.has(id);
  const reports=complianceStore(db,now),audit=adminAudit(db,now),tickets=userTickets(db,{now,isAdmin});
  const chats=new Chats(now);chats.attachSupportStore(db);
  const supportId=chats.openMobileSupport(owner,first);
  const support=(actor,id)=>id===supportId&&actor===first?{status:'pending',accountId:owner,assignee:first,closed:false,archived:false}:null;
  const supportForAccount=(actor,id)=>actor===first&&id===owner?[{id:supportId,type:'support',title:'Support conversation',status:'pending',at:now()}]:[];
  const desk=caseWorkspace(db,{audit,reports,isAdmin,support,supportForAccount,now});
  return {db, first, second, owner, peer, admins, reports, audit, tickets, supportId, desk, now, advance:n=>time+=n};
}

test('case ownership, report links and authenticated account lookup share a safe audit trail',()=>{
  const {db,first,second,owner,peer,admins,reports,audit,supportId,desk,now}=setup();
  try{
    const report=reports.report(peer,owner,randomUUID(),'Spam or scam','Submitted evidence').id;
    assert.throws(()=>desk.view(owner,'report',report),{status:403});
    assert.throws(()=>desk.view(second,'support',supportId),{status:404});
    assert.equal(desk.accountForReference(second,supportId),null);
    assert.equal(desk.accountForReference(first,supportId),owner);
    assert.equal(desk.accountForReference(first,report),owner);
    recordActivity(db,owner,'Unlock successful',now());
    const result=desk.account(first,'desktop',owner);
    assert.deepEqual(result.activity.map(event=>event.event),['Unlock successful']);
    assert.deepEqual(new Set(result.cases.map(entry=>entry.type)),new Set(['support','report']));
    assert.ok(!Object.hasOwn(result.account,'token'));
    assert.ok(!Object.hasOwn(result.account,'device_id'));
    assert.equal(desk.account(second,'mobile',owner).cases.some(entry=>entry.type==='support'),false);
    assert.equal(desk.act(first,'desktop','report',report,{action:'claim'}).assignedToMe,true);
    assert.throws(()=>desk.act(second,'desktop','report',report,{action:'claim'}),{status:409});
    assert.throws(()=>desk.requireAssignedOrUnclaimed(second,'report',report),{status:409});
    const withNote=desk.act(first,'desktop','report',report,{action:'note',note:'Internal review summary'});
    assert.equal(withNote.record.evidence,'Submitted evidence');
    assert.ok(withNote.events.some(event=>event.note==='Internal review summary'));
    assert.ok(!JSON.stringify(audit.list({type:'report'})).includes('Internal review summary'));
    assert.equal(audit.list({type:'report',outcome:'rejected'}).length,1);
    admins.delete(first);
    assert.equal(desk.act(second,'desktop','report',report,{action:'claim'}).assignedToMe,true);
    assert.equal(desk.act(second,'desktop','report',report,{action:'unassign'}).assignee,null);
    desk.eraseAccount(owner);
    assert.equal(desk.view(second,'report',report).events.some(event=>event.note),false);
    assert.equal(audit.accountActivity(owner).length,0);
  }finally{db.close();}
});

test('ticket replies remain private, acknowledgements are idempotent and closed case notes expire',()=>{
  const {db,first,owner,peer,tickets,desk,advance}=setup();
  try{
    const ticket=tickets.open(owner,'Account issue','Initial request',randomUUID());
    assert.equal(tickets.unread(owner),null);
    tickets.adminAction(ticket.id,first,'accept');
    const firstReply=tickets.send(ticket.id,first,true,'First reply',randomUUID()).messages.at(-1).id;
    assert.deepEqual({...tickets.unread(owner)},{ticketId:ticket.id,messageId:firstReply});
    assert.equal(tickets.unread(peer),null);
    assert.throws(()=>tickets.markRead(ticket.id,peer,firstReply),{status:404});
    assert.throws(()=>tickets.markRead(ticket.id,owner,randomUUID()),{status:404});
    assert.deepEqual(tickets.markRead(ticket.id,owner,firstReply),{ok:true});
    tickets.markRead(ticket.id,owner,firstReply);
    assert.equal(tickets.unread(owner),null);
    const secondReply=tickets.send(ticket.id,first,true,'Second reply',randomUUID()).messages.at(-1).id;
    assert.equal(tickets.view(ticket.id,owner).unreadReply,secondReply);
    assert.equal(tickets.view(ticket.id,owner).replyStatus,'reply');
    desk.act(first,'desktop','ticket',ticket.id,{action:'note',note:'Private ticket note'});
    assert.ok(!JSON.stringify(tickets.view(ticket.id,owner)).includes('Private ticket note'));
    tickets.adminAction(ticket.id,first,'close');
    assert.equal(tickets.receipts(owner)[0].id,ticket.id);
    assert.equal(tickets.unread(owner),null);
    advance(8*day);
    assert.equal(desk.view(first,'ticket',ticket.id).events.some(event=>event.note),false);
    desk.sweep();tickets.sweep();
    assert.equal(tickets.receipts(owner).length,0);
    assert.equal(db.prepare('SELECT count(*) AS total FROM admin_case_notes').get().total,0);
    assert.equal(db.prepare('SELECT count(*) AS total FROM user_ticket_reads').get().total,0);
  }finally{db.close();}
});
