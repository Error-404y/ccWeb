import {adminAudit} from './lib/admin-audit.mjs';
import express from 'express';
import {desktopMessenger} from './lib/desktop-messenger.mjs';
import {sellerStore} from './lib/sellers.mjs';
import {userTickets} from './lib/user-tickets.mjs';
import {createMonitoring} from './lib/monitoring.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { initActivity, recordActivity, listActivity, pruneActivity } from './lib/activity.mjs';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { Chats } from './lib/chats.mjs';
import { officialStore } from './lib/official.mjs';
import { feedbackStore } from './lib/feedback.mjs';
import { prekeyStore } from './lib/prekeys.mjs';
import { privatePush } from './lib/push.mjs';
import { loadFirebaseDelivery } from './lib/firebase-push.mjs';
import { versionedState } from './lib/live.mjs';
import { contactStore } from './lib/contacts.mjs';
import { openAccounts, createAccount, findAccount, issuePin, usePin, requestReset, setLogin, verifyLogin, changeLogin, validPin, markRequestSent, connectionBlocks } from './lib/accounts.mjs';

import { initAccess, accessStatus, createInvoice, invoiceStatus, invoiceRow, redeemAccess, redeemReviewAccess, validReviewKey, applyRenewal, submitPayment, releaseSupportKey } from './lib/access.mjs';
import {initControl,createControlSessions,desktopControlAllowed,issueRecovery,recoverAccount,controlOverview,controlAccounts,accountAction,controlPayments,controlAudit,archiveControlRecord} from './lib/control.mjs';
import {listAccessKeys,generatePlanKeys,replaceUnusedKey,revokeAccessKey} from './lib/access.mjs';
import {initPayments,COINS,createCryptoInvoice,existingCryptoInvoice,quotePrice,paymentURI,rpcConfigured,verifyCryptoInvoice,verifyNetwork} from './lib/crypto-payments.mjs';
import {initPaymentTickets,paymentTickets} from './lib/payment-tickets.mjs';
import { initDevices, findDeviceAccount, deviceVerifier } from './lib/devices.mjs';
import { Unlocks } from './lib/unlocks.mjs';
import { sendReset, sendFeedback, sendPayment } from './lib/discord.mjs';
import { handleAdminCommand } from './lib/admin.mjs';
import { startAdminSocket } from './lib/admin-socket.mjs';
import {complianceStore,TERMS_VERSION} from './lib/compliance.mjs';

process.umask(0o077);
const root = dirname(fileURLToPath(import.meta.url));
const app = express(), db = openAccounts();
initAccess(db);initPayments(db);initControl(db);initPaymentTickets(db);
const tickets=paymentTickets(db);tickets.sweep();setInterval(()=>tickets.sweep(),3600000).unref();
initDevices(db);
initActivity(db);
pruneActivity(db);
setInterval(() => pruneActivity(db), 3600000).unref();
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const devices = deviceVerifier();
const blocks = connectionBlocks(db);
const chats = new Chats(Date.now, undefined, blocks);
chats.attachSupportStore(db);
const official=officialStore(db),feedback=feedbackStore(db),liveWaiters=new Map();
const push=privatePush(db,{url:process.env.QZU_PUSH_RELAY_URL,secret:process.env.QZU_PUSH_RELAY_SECRET,firebase:loadFirebaseDelivery(process.env.QZU_FIREBASE_CREDENTIALS),unread:account=>chats.snapshot(account).reduce((n,room)=>n+room.messages.filter(m=>m.unread).length,0)});
const compliance=complianceStore(db);const prekeys=prekeyStore(db);chats.prekeys=prekeys;prekeys.sweep();setInterval(()=>prekeys.sweep(),3600000).unref();compliance.sweep();setInterval(()=>compliance.sweep(),3600000).unref();
let liveTotal=0;
const contacts = contactStore(db);
chats.contacts = contacts;
const unlocks = new Unlocks(), sendingResets = new Map();
const controlSessions=createControlSessions(db),auditLedger=adminAudit(db);
const sellers=sellerStore(db);chats.sellerInvites=sellers;chats.profileRole=id=>sellers.role(id);sellers.sync(chats);
const isTicketAdmin=id=>Boolean(db.prepare("SELECT 1 FROM accounts a JOIN support_keys k ON k.account=a.id WHERE a.id=? AND a.access_plan='admin' AND a.access_revoked=0 AND (a.suspended=0 OR a.suspended_until<=?) AND k.expires>?").get(id,Date.now(),Date.now()));
const desktopChats=desktopMessenger(db,chats,isTicketAdmin);chats.profileRole=id=>desktopChats.role(id)||sellers.role(id);chats.profileName=id=>chats.profileRole(id)==='admin'?'qzu-Support':sellers.name(id);chats.adminAccount=id=>desktopChats.role(id)==='admin'?desktopChats.principal(id).admin:chats.profileRole(id)==='admin'?id:null;chats.desktopPrincipal=id=>Boolean(desktopChats.principal(id));chats.validParticipant=id=>desktopChats.valid(id);
const helpTickets=userTickets(db,{isSeller:id=>sellers.isActive(id),isAdmin:isTicketAdmin,role:id=>sellers.role(id),name:id=>sellers.name(id)});helpTickets.sweep();setInterval(()=>{helpTickets.sweep();sellers.sync(chats);},60000).unref();
const notifyHelp=(id,actor)=>push.notify(helpTickets.recipients(id).filter(x=>x!==actor));
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.PUBLIC_ORIGIN) throw new Error('Set PUBLIC_ORIGIN to your HTTPS origin.');
const publicOrigin = process.env.PUBLIC_ORIGIN;
const mobileOnly = process.env.QZU_MOBILE_ONLY === 'true' || (production && process.env.QZU_MOBILE_ONLY !== 'false');
chats.requireEncryptedDirect = mobileOnly;
const nativeOrigins = new Set(['capacitor://localhost', 'https://localhost']);
const desktopRequest=req=>!req.get('x-qzu-device')&&!nativeOrigins.has(req.get('origin'))&&desktopControlAllowed(req.get('user-agent')||'',req.get('sec-ch-ua-mobile')||'',req.get('sec-ch-ua-platform')||'');
if (production && !publicOrigin.startsWith('https://')) throw new Error('HTTPS required.');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
const monitoring=createMonitoring({write:line=>console.log(line)});
app.use(monitoring.middleware);
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (nativeOrigins.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-QZU, X-QZU-Unlock, X-QZU-Device, X-QZU-Signature, X-QZU-Time, X-QZU-Nonce');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use((req, res, next) => express.json({
  limit: ['/api/message', '/api/encryption/message','/api/encryption/once/send','/api/report','/api/access/ticket/send','/api/control/chats/media/send'].includes(req.path) ? '3mb' : '12kb',
  verify: (req, res, buffer) => { req.rawBody = buffer.toString('utf8'); }
})(req, res, next));
const cookieName = production ? '__Host-qzu': 'qzu';
const readToken = req => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
const limits = new Map();

function rate(key, max, period) {
  const now = Date.now(), old = limits.get(key);
  const bucket = old && old.until > now ? old: {
    count: 0,
    until: now + period
  };
  limits.set(key, bucket);
  return++bucket.count <= max;
}
const timer = setInterval(() => {
  chats.sweep();
  unlocks.sweep();
  devices.sweep();
  const now = Date.now();
  for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
}, 1000);
timer.unref();
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.get('origin');
    const allowed = publicOrigin || req.protocol + '://' + req.get('host');
    if (req.get('x-qzu') !== '1' || (origin && origin !== allowed && !nativeOrigins.has(origin))) return res.status(403).json({
      error: 'Request rejected.'
    });
  }
  if (!rate('ip:' + req.ip, 600, 60_000)) return res.status(429).json({
    error: 'Try again shortly.'
  });
  if (/^\/control(?:\/|$)/i.test(req.path)&&!req.get('x-qzu-device')) {
    if(!desktopRequest(req))return res.status(403).json({error:'Control Center is available on Windows and Mac computers only.'});
    return next();
  }
  if (req.get('x-qzu-device')) {
    req.deviceId = devices.authenticate({
      publicKey: req.get('x-qzu-device'), signature: req.get('x-qzu-signature'), timestamp: req.get('x-qzu-time'), nonce: req.get('x-qzu-nonce'),
      method: req.method, path: req.originalUrl, body: req.rawBody || '', unlock: req.get('x-qzu-unlock') || ''
    });
    if (!req.deviceId) return res.status(401).json({ error: 'Device verification failed.' });
    req.account = findDeviceAccount(db, req.deviceId);
  } else {
    if (mobileOnly) return res.status(403).json({ error: 'Use the qzu. mobile app.' });
    req.account = findAccount(db, readToken(req));
    if (req.account?.device_id) return res.status(403).json({ error: 'Use your registered device.' });
  }
  next();
});
const accessRequired = process.env.QZU_ACCESS_REQUIRED !== 'false';
const paymentRate = (name, max) => (req, res, next) => rate(name + ':' + req.ip, max, 60_000) ? next() : res.status(429).json({ error: 'Try again shortly.' });
let paymentBusy = false;
async function paymentLoop() {
  if (paymentBusy) return;
  paymentBusy = true;
  try {
    const pending=db.prepare("SELECT id,coin FROM access_invoices WHERE coin IS NOT NULL AND state='submitted' AND submitted>? ORDER BY COALESCE(last_checked,0),submitted LIMIT 20").all(Date.now()-7*86400000);
    for(const row of pending)if(rpcConfigured(row.coin))await verifyCryptoInvoice(db,row.id).catch(()=>{});
    if (process.env.QZU_PAYMENT_WEBHOOK) {
      const rows = db.prepare("SELECT id,plan,sats,eur_cents,usd_cents,coin,verified_at FROM access_invoices WHERE state='confirmed' AND notified=0 LIMIT 20").all();
      for (const row of rows) {
        await sendPayment(row);
        db.prepare('UPDATE access_invoices SET notified=1 WHERE id=?').run(row.id);
      }
    }
  } catch {} finally { paymentBusy = false; }
}
setInterval(paymentLoop, 15_000).unref();

async function checkoutQR(invoice,row){
 if(invoice.state!=='pending')return null;
 if(row.coin)return QRCode.toDataURL(paymentURI(row),{width:320,margin:3});
 return null;
}
app.get('/api/access/methods',paymentRate('methods',30),(req,res)=>res.json({coins:Object.keys(COINS).map(coin=>({coin,name:COINS[coin].name,available:rpcConfigured(coin)}))}));
app.post('/api/access/invoice',paymentRate('invoice',5),async(req,res)=>{
 const {plan,coin,renewal,accepted,requestKey,ticketFlow}=req.body||{};
 if(accepted!==true)return res.status(400).json({error:'Accept the displayed payment terms first.'});
 let account=null;
 if(renewal===true||plan==='renewal'){
  if(!req.account||!unlocks.check(req.account.id,req.get('x-qzu-unlock'))||!['monthly','week','month','year'].includes(req.account.access_plan)||req.account.access_revoked)return res.status(403).json({error:'Unlock your eligible account first.'});
  account=req.account.id;
 }
 let invoice;
 if(coin){
  if(!Object.hasOwn(COINS,coin))return res.status(400).json({error:'Choose a payment network.'});
  if(requestKey)invoice=existingCryptoInvoice(db,requestKey,plan,coin,account);
  if(!invoice){
    if(!rpcConfigured(coin))return res.status(503).json({error:'Payment network not configured. No payment has been requested.'});
    const [,price]=await Promise.all([verifyNetwork(coin),quotePrice(coin)]);
    invoice=createCryptoInvoice(db,plan,coin,price,account,Date.now(),requestKey||null,ticketFlow===true);
  }
 }else{
  return res.status(426).json({error:'Update qzu. to create a new USD-priced order. Existing orders can still be recovered.'});
 }
 res.json({...invoice,qr:await checkoutQR(invoice,invoiceRow(db,invoice.orderKey))});
});
app.post('/api/access/status',paymentRate('invoice-status',30),async(req,res)=>{
 const row=invoiceRow(db,req.body?.key);
 if(row.account&&(!req.account||req.account.id!==row.account||!unlocks.check(req.account.id,req.get('x-qzu-unlock'))))return res.status(403).json({error:'Unlock your account.'});
 const invoice=invoiceStatus(db,req.body.key);
 res.json({...invoice,qr:await checkoutQR(invoice,row)});
});
app.post('/api/access/submit',paymentRate('payment-submit',8),(req,res)=>{
 const row=invoiceRow(db,req.body?.key);
 if(row.account&&(!req.account||req.account.id!==row.account||!unlocks.check(req.account.id,req.get('x-qzu-unlock'))))return res.status(403).json({error:'Unlock your account.'});
 res.json(submitPayment(db,req.body.key,req.body.txid));
});
function ticketOrder(req){
 const key=req.body?.key;
 if(typeof key!=='string'||!/^QZO-[A-F0-9]{48}$/.test(key))throw Object.assign(Error('Order reference required.'),{status:403});
 const row=invoiceRow(db,key);
 if(row.account&&(!req.account||req.account.id!==row.account||!unlocks.check(req.account.id,req.get('x-qzu-unlock'))))throw Object.assign(Error('Unlock your account.'),{status:403});
 if(req.deviceId&&compliance.suspended(req.deviceId))throw Object.assign(Error('Device access suspended.'),{status:403});
 if(!rate('ticket:'+row.id,100,60000))throw Object.assign(Error('Try again shortly.'),{status:429});
 return row;
}
function notifyPaymentAdmins(){push.notify(db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired' AND device_id IS NOT NULL").all().map(a=>a.id));}
app.post('/api/access/ticket/open',paymentRate('ticket-open',10),(req,res)=>{const r=ticketOrder(req),t=tickets.open(r.id,{fresh:req.body?.fresh===true});if(t.created===t.updated&&!t.closed)notifyPaymentAdmins();res.json(tickets.view(t.id,r.id,req.body.key));});
app.post('/api/access/ticket/state',paymentRate('ticket-state',60),(req,res)=>{const r=ticketOrder(req);res.json(tickets.view(req.body?.ticketId,r.id,req.body.key));});
app.post('/api/access/ticket/send',paymentRate('ticket-send',20),(req,res)=>{const r=ticketOrder(req);tickets.send(req.body?.ticketId,'customer',req.body,r.id);notifyPaymentAdmins();res.json(tickets.view(req.body.ticketId,r.id,req.body.key));});
app.post('/api/access/ticket/proof',paymentRate('ticket-proof',20),(req,res)=>{const r=ticketOrder(req),proof=tickets.proof(req.body?.ticketId,req.body?.message,r.id);if(!proof)return res.sendStatus(404);res.json({data:Buffer.from(proof).toString('base64')});});
app.post('/api/access/ticket/transaction',paymentRate('ticket-transaction',8),(req,res)=>{const r=ticketOrder(req),t=tickets.view(req.body?.ticketId,r.id);if(t.closed)return res.status(409).json({error:'Ticket closed.'});submitPayment(db,req.body.key,req.body.txid);res.json(tickets.view(t.id,r.id,req.body.key));});
app.post('/api/access/renew', paymentRate('renewal', 10), (req, res) => {
  if (!req.account || !unlocks.check(req.account.id, req.get('x-qzu-unlock'))) return res.status(403).json({ error: 'Unlock your account.' });
  res.json(applyRenewal(db, req.body?.key, req.account.id));
});

const controlCookie=production?'__Host-qzu-control':'qzu-control';
const readControl=req=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(controlCookie+'='))?.slice(controlCookie.length+1);
const controlCookieOptions={httpOnly:true,secure:production,sameSite:'strict',path:'/'};
const controlRate=(req,res,next)=>rate('control:'+req.ip,120,60000)?next():res.status(429).json({error:'Try again shortly.'});
app.post('/api/control/login',controlRate,(req,res)=>{
 if(req.deviceId)return res.status(403).json({error:'Use your unlocked admin account.'});
 if(!rate('control-login:'+req.ip,5,60000))return res.status(429).json({error:'Try again shortly.'});
 const result=controlSessions.login(req.body?.key,req.body?.pin);
 res.cookie(controlCookie,result.token,{...controlCookieOptions,maxAge:8*3600000});res.json({ok:true});
});
app.use('/api/control',(req,res,next)=>{
 if(req.deviceId){
  if(!req.account||req.account.access_plan!=='admin'||!isTicketAdmin(req.account.id)||!accessStatus(req.account).active)return res.status(403).json({error:'Admin account required.'});
  if(!unlocks.check(req.account.id,req.get('x-qzu-unlock')))return res.status(423).json({error:'Locked.'});
  if(req.account.terms_required&&req.account.terms_version!==TERMS_VERSION)return res.status(403).json({error:'Accept the current Terms of Service first.'});
  if(/^\/(?:chats(?:\/|$)|logout$)/i.test(req.path))return res.status(403).json({error:'Use your native messenger.'});
 }else{req.account=controlSessions.check(readControl(req));if(!req.account)return res.status(401).json({error:'Sign in with your admin key.'});}
 if(!rate('control-admin:'+req.account.id,120,60000))return res.status(429).json({error:'Try again shortly.'});
 auditLedger.capture(req,res);next();
});
app.post('/api/control/logout',(req,res)=>{controlSessions.revoke(readControl(req));res.clearCookie(controlCookie,controlCookieOptions);res.json({ok:true});});
const adminPrincipals=id=>[id,db.prepare('SELECT principal FROM desktop_messenger WHERE admin=?').get(id)?.principal].filter(Boolean);
const deletionInbox=id=>[...chats.supportDeletions(id,true),...adminPrincipals(id).flatMap(p=>chats.directDeletionRequests(p))];
const notifyDeletionAdmin=peer=>push.notify([desktopChats.principal(peer)?.admin||peer]);
function approveDeletion(admin,id){const principal=adminPrincipals(admin).find(p=>chats.directDeletionRequests(p).some(d=>d.id===id));if(principal){const result=chats.approveDirectDeletion(principal,id);push.notify([result.requester]);return {ok:true};}const recipients=chats.rooms.get(id)?.users.filter(x=>x!==admin)||[];const result=chats.approveSupportDeletion(admin,id,true);push.notify(recipients);return result;}
const supportInboxCount=id=>new Set([...chats.supportRequests(id,true),...deletionInbox(id)].map(r=>r.id)).size;
app.get('/api/control/overview',(req,res)=>res.json({...controlOverview(db),paymentTickets:tickets.counts().open,supportRequests:supportInboxCount(req.account.id)}));
app.get('/api/control/monitoring',(req,res)=>res.json({...monitoring.snapshot(),version,environment:production?'production':'development',activeDesktopSessions:controlSessions.activeDesktopIds().length,liveRequests:liveTotal,paymentTickets:tickets.counts().open,supportRequests:supportInboxCount(req.account.id)}));
app.get('/api/control/inbox',(req,res)=>res.json({version,environment:production?'production':'development',paymentTickets:tickets.counts().open,supportRequests:supportInboxCount(req.account.id),userTickets:helpTickets.count(),adminId:req.account.id}));
app.get('/api/control/accounts',(req,res)=>res.json({items:controlAccounts(db,req.query.q||'',req.query.after||'')}));
app.get('/api/control/keys',(req,res)=>res.json({items:listAccessKeys(db,req.query.q||'')}));
app.post('/api/control/keys/generate',(req,res)=>res.json(generatePlanKeys(db,req.body?.plan,req.body?.count,req.account.id)));
app.post('/api/control/keys/replace',(req,res)=>res.json(replaceUnusedKey(db,req.body?.id,req.account.id)));
app.post('/api/control/keys/revoke',(req,res)=>res.json(revokeAccessKey(db,req.body?.id,req.account.id,req.body?.reason)));
app.post('/api/control/accounts/action',(req,res)=>{const b=req.body||{},result=accountAction(db,b.id,req.account.id,b.action,b.reason,b.plan);if(b.action==='revoke'){unlocks.revokeAll(b.id);push.remove(b.id);chats.hidePresence(b.id);}res.json(result);});
app.get('/api/control/payments',(req,res)=>res.json({items:controlPayments(db,req.query.archived==='1')}));
app.get('/api/control/payment-tickets',(req,res)=>res.json({items:tickets.list(req.query.archived==='1')}));
app.post('/api/control/payment-tickets/state',(req,res)=>res.json(tickets.view(req.body?.id)));
app.post('/api/control/payment-tickets/send',(req,res)=>{tickets.send(req.body?.id,req.account.id,{text:req.body?.text,requestId:req.body?.requestId});res.json(tickets.view(req.body?.id));});
app.post('/api/control/payment-tickets/proof',(req,res)=>{const proof=tickets.proof(req.body?.id,req.body?.message);if(!proof)return res.sendStatus(404);res.json({data:Buffer.from(proof).toString('base64')});});
app.post('/api/control/payment-tickets/verify',async(req,res)=>{const id=req.body?.id,t=tickets.view(id);if(t.state==='submitted')await verifyCryptoInvoice(db,t.invoiceId);res.json(tickets.view(id));});
app.post('/api/control/payment-tickets/release',(req,res)=>{tickets.release(req.body?.id,req.account.id);res.json(tickets.view(req.body?.id));});
app.post('/api/control/payment-tickets/review',(req,res)=>{tickets.review(req.body?.id,req.account.id);res.json(tickets.view(req.body?.id));});
app.post('/api/control/payment-tickets/reject',(req,res)=>{tickets.reject(req.body?.id,req.account.id,req.body?.reason);res.json(tickets.view(req.body?.id));});
app.post('/api/control/payment-tickets/close',(req,res)=>{tickets.close(req.body?.id,req.account.id);res.json(tickets.view(req.body?.id));});
app.get('/api/control/support',(req,res)=>{
 const archived=req.query.archived==='1',id=req.account.id;
 res.json({requests:archived?[]:chats.supportRequests(id,true),deletions:archived?[]:deletionInbox(id),rooms:archived?[]:chats.snapshot(id).filter(r=>r.support&&r.supportAgent&&r.supportStatus==='accepted').map(r=>({id:r.id,expires:r.expires,deletionRequested:r.deletionRequested,messages:r.messages.slice(-50).map(m=>({mine:m.mine,at:m.at,text:m.deleted?'Deleted message':m.once||m.burnSeconds?'Temporary message':m.kind==='text'?m.text:'Attachment',sender:m.sender}))})),finished:chats.finishedSupport(id,archived)});
});
app.post('/api/control/support/delete',(req,res)=>{const id=req.body?.id;if(req.body?.confirmed!==true)return res.status(400).json({error:'Confirmation required.'});res.json(approveDeletion(req.account.id,id));});
app.post('/api/control/support/delete-direct',(req,res)=>{const id=req.body?.id,room=chats.rooms.get(id);if(req.body?.confirmed!==true||!room||room.supportAgent!==req.account.id)return res.status(403).json({error:'Assigned support conversation and confirmation required.'});const recipients=room.users.filter(x=>x!==req.account.id);chats.remove(req.account.id,id,true);push.notify(recipients);res.json({ok:true});});
app.post('/api/control/support/delete-contact',(req,res)=>{const id=req.body?.id,room=chats.rooms.get(id);if(req.body?.confirmed!==true||!room||room.supportAgent!==req.account.id)return res.status(403).json({error:'Assigned support conversation and confirmation required.'});const recipients=room.users.filter(x=>x!==req.account.id);const result=chats.deleteSupportContact(req.account.id,id,true);push.notify(recipients);res.json(result);});
app.post('/api/control/support/finish',(req,res)=>res.json(chats.finishSupport(req.account.id,req.body?.id,req.body?.action)));
app.post('/api/control/archive',(req,res)=>{const b=req.body||{};if(b.category==='support')return res.json(chats.finishSupport(req.account.id,b.id,b.restore===true?'restore':'archive'));res.json(archiveControlRecord(db,b.category,b.id,req.account.id,b.restore===true));});
app.post('/api/control/support/respond',(req,res)=>res.json(chats.respondSupport(req.account.id,req.body?.id,req.body?.action,true)));
app.post('/api/control/support/send',(req,res)=>{const room=chats.requireRoom(req.account.id,req.body?.id);if(room.supportAgent!==req.account.id||room.supportStatus!=='accepted'||typeof req.body?.text!=='string')return res.status(403).json({error:'Assigned support conversation required.'});const result=chats.send(req.account.id,room.id,req.body.text);push.notify(room.users.filter(id=>id!==req.account.id));res.json({ok:true});});
app.get('/api/control/audit',(req,res)=>res.json({items:auditLedger.list({q:req.query.q||'',before:req.query.before===undefined?Number.MAX_SAFE_INTEGER:Number(req.query.before)}),legacy:controlAudit(db)}));
app.get('/api/control/reports',(req,res)=>res.json({items:compliance.list(true,req.query.archived==='1')}));
app.get('/api/control/reports/media/:id',(req,res)=>{const m=compliance.media(req.params.id);if(!m)return res.sendStatus(404);res.set('Cache-Control','no-store').type(m.mime).send(Buffer.from(m.body));});
app.post('/api/control/reports/collaborate',(req,res)=>{const b=req.body||{},result=compliance.collaborate(b.id,req.account.id,b.status,b.note??'');if(b.status==='help')push.notify(db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired' AND id<>?").all(req.account.id).map(a=>a.id));res.json(result);});
app.post('/api/control/reports/resolve',(req,res)=>{const b=req.body||{},result=compliance.resolve(b.id,b.action,req.account.id,b.notes??'');if(result.warn){chats.sendAdmin(result.warn,'Moderation warning\\nYour account has received a warning. Please follow the Terms of Service.');push.notify([result.warn]);}if(result.target){chats.erase(result.target);push.remove(result.target);unlocks.revokeAll(result.target);}res.json({ok:true});});
app.get('/api/control/feedback',(req,res)=>res.json({items:feedback.list(true,req.query.before===undefined?Number.MAX_SAFE_INTEGER:Number(req.query.before),req.query.archived==='1')}));
app.post('/api/control/feedback/status',(req,res)=>{const b=req.body||{},result=feedback.status(true,b.id,b.status,req.account.id,b.note??'');if(b.status==='help')push.notify(db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired' AND id<>?").all(req.account.id).map(a=>a.id));res.json(result);});
app.post('/api/control/chats/identity',(req,res)=>res.json(desktopChats.bind(req.account.id,req.body?.record)));
app.get('/api/control/chats',(req,res)=>res.json(desktopChats.state(req.account.id)));
app.post('/api/control/chats/reset',(req,res)=>{if(req.body?.confirmed!==true)return res.status(400).json({error:'Confirmation required.'});res.json(desktopChats.reset(req.account.id));});
app.post('/api/control/chats/connect',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id);sellers.sync(chats);chats.sweep();const code=String(req.body?.code||'').trim().toUpperCase(),invite=chats.codes.get(code);if(!invite||invite.group||!desktopChats.valid(invite.user))return res.status(404).json({error:'Direct connection code unavailable.'});res.json(chats.requestConnection(p.principal,code,req.body?.nickname));});
app.post('/api/control/chats/respond',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{},request=chats.requests.get(b.id);if(request?.group)return res.status(403).json({error:'Direct chats only.'});res.json(chats.respondConnection(p.principal,b.id,b.accept===true,b.nickname));});
app.post('/api/control/chats/contact',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id);res.json({id:chats.openContact(p.principal,req.body?.id)});});
app.post('/api/control/chats/contact/delete',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{};if(b.confirmed!==true)return res.status(400).json({error:'Confirmation required.'});const peer=contacts.peer(p.principal,b.id),result=chats.removeContact(p.principal,b.id);push.notify([peer]);res.json(result);});
app.post('/api/control/chats/delete',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{};if(b.confirmed!==true)return res.status(400).json({error:'Confirmation required.'});const room=chats.requireRoom(p.principal,b.id);if(room.group||room.admin||room.support||!room.encryption)return res.status(403).json({error:'Private encrypted chat required.'});const recipients=room.users.filter(x=>x!==p.principal);chats.remove(p.principal,b.id,true);push.notify(recipients);res.json({ok:true});});
app.post('/api/control/chats/key',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id);res.json(chats.publishRoomKey(p.principal,req.body?.id,p.device,req.body?.record));});
app.post('/api/control/chats/confirm',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{};if(typeof b.code!=='string')return res.status(400).json({error:'Safety code required.'});res.json(chats.confirmRoomKey(p.principal,b.id,b.code,true));});
app.post('/api/control/chats/send',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{},sent=chats.sendEncrypted(p.principal,b.id,b.cipher,'text',null,b.requestId??null);if(!sent?.duplicate)notifyRoom(p.principal,b.id);res.json(typeof sent==='string'?{id:sent}:sent);});
app.post('/api/control/chats/media/send',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{};if(!['image','audio'].includes(b.kind))return res.status(400).json({error:'Invalid attachment.'});const id=chats.sendEncrypted(p.principal,b.id,b.cipher,b.kind,null,null,b.once===true);notifyRoom(p.principal,b.id);res.json({id});});
app.post('/api/control/chats/media',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{};res.json(chats.getEncryptedMedia(p.principal,b.id,b.messageId));});
app.post('/api/control/chats/once',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{};res.json(chats.openOnce(p.principal,b.id,b.messageId,false,true));});
app.post('/api/control/chats/once/send',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{},id=chats.sendEncrypted(p.principal,b.id,b.cipher,'text',null,null,true);notifyRoom(p.principal,b.id);res.json({id});});
app.post('/api/control/chats/receipts',(req,res)=>{const p=desktopChats.requireIdentity(req.account.id),b=req.body||{};chats.requireRoom(p.principal,b.id);const ids=Array.isArray(b.ids)?b.ids.slice(0,50):[];chats.acknowledge(p.principal,[{id:b.id,delivered:ids,read:ids,seen:ids}]);res.json({ok:true});});
app.get('/api/control/sellers',(req,res)=>res.json({items:sellers.list(chats)}));
app.post('/api/control/sellers/generate',(req,res)=>res.json(sellers.generateKey(req.account.id)));
app.post('/api/control/sellers/rotate',(req,res)=>res.json(sellers.rotate(req.body?.id,chats,req.account.id)));
app.post('/api/control/sellers/access',(req,res)=>{const b=req.body||{};if(!sellers.isSeller(b.id)||typeof b.suspended!=='boolean')return res.status(404).json({error:'Seller unavailable.'});const result=accountAction(db,b.id,req.account.id,b.suspended?'revoke':'restore','Seller access management');if(b.suspended){unlocks.revokeAll(b.id);push.remove(b.id);chats.hidePresence(b.id);}sellers.sync(chats);res.json(result);});
app.post('/api/control/sellers/verify',(req,res)=>res.json(sellers.verify(req.body?.id,req.body?.verified,req.account.id)));
app.get('/api/control/announcements',(req,res)=>res.json(req.query.before?official.history(Number(req.query.before)):official.snapshot(req.account.id)));
app.post('/api/control/announcements/publish',(req,res)=>{const result=official.publish(req.body?.text,true);push.broadcast(req.account.id);res.json(result);});
app.post('/api/control/announcements/delete',(req,res)=>res.json(official.remove(req.body?.id,true)));
app.get('/api/control/ticket-admins',(req,res)=>res.json({items:db.prepare("SELECT id FROM accounts WHERE access_plan='admin'").all().filter(a=>a.id!==req.account.id&&isTicketAdmin(a.id)).map(a=>({id:a.id}))}));
app.get('/api/control/tickets',(req,res)=>res.json({items:helpTickets.list(req.account.id,true,req.query.archived==='1')}));
app.post('/api/control/tickets/state',(req,res)=>res.json(helpTickets.view(req.body?.id,req.account.id,true)));
app.post('/api/control/tickets/send',(req,res)=>{const b=req.body||{},t=helpTickets.send(b.id,req.account.id,true,b.text,b.requestId);notifyHelp(t.id,req.account.id);res.json(t);});
app.post('/api/control/tickets/action',(req,res)=>{const b=req.body||{},code=b.action==='share'?sellers.ensureCode(b.seller,chats)?.code:null,t=helpTickets.adminAction(b.id,req.account.id,b.action,b.seller,code);if(b.action!=='delete')notifyHelp(t.id,req.account.id);res.json(t);});
app.use('/api/control',(req,res)=>res.status(404).json({error:'Unknown control endpoint.'}));
app.post('/api/access/recover',paymentRate('recover',5),(req,res)=>{
 if(!req.deviceId||req.account||req.body?.confirmed!==true)return res.status(403).json({error:'Unregistered mobile device and confirmation required.'});
 const result=recoverAccount(db,req.body?.code,req.body?.pin,req.deviceId);
 unlocks.revokeAll(result.id);push.remove(result.id);prekeys.remove(result.id);chats.erase(result.id);chats.hidePresence(result.id);
 res.json({ok:true,needsSetup:false});
});
app.post('/api/session', (req, res) => {
  if (!req.account) {
    if(compliance.suspended(req.deviceId))return res.status(403).json({error:'Device access suspended.'});
    if (!rate('new:' + req.ip, 20, 60 * 60_000)) return res.status(429).json({
      error: 'Try again later.'
    });
    if ((accessRequired || req.deviceId) && !req.body?.accessKey) return res.json({ accessRequired: true });
    const review = validReviewKey(req.body?.accessKey);
    const { token, id } = review ? redeemReviewAccess(db,req.body.accessKey,req.deviceId,{key:process.env.QZU_REVIEW_KEY,pin:process.env.QZU_REVIEW_PIN}) : accessRequired || req.deviceId ? redeemAccess(db, req.body.accessKey, Date.now(), req.deviceId || null) : createAccount(db);
    compliance.requireTerms(id);
    if (!req.deviceId) res.cookie(cookieName, token, {
      httpOnly: true,
      secure: production,
      sameSite: 'strict',
      path: '/',
      maxAge: 365 * 24 * 60 * 60_000
    });
    req.account = {
      id,
      login_hash: review ? true : null
    };
  }
  res.json({
    needsSetup: !req.account.login_hash
  });
});
app.use('/api', (req, res, next) => req.account ? next(): res.status(401).json({
  error: 'Session unavailable.'
}));
const guard = (name, max, period) => (req, res, next) => rate(name + ':' + req.account.id, max, period) ? next(): res.status(429).json({
  error: 'Try again shortly.'
});

function loginError(res, result) {
  return res.status(result === 'locked' ? 429: 400).json({
    error: result === 'locked' ? 'Try again in 15 minutes.': result === 'same-emergency' ? 'Choose a different PIN.': 'Incorrect or unavailable PIN.'
  });
}
app.post('/api/login/setup', guard('login-setup', 5, 60_000), (req, res) => {
  if (!validPin(req.body?.pin) || !setLogin(db, req.account.id, req.body.pin)) return res.status(400).json({
    error: 'Choose a different PIN or unlock.'
  });
  recordActivity(db, req.account.id, 'PIN created');
  if (!chats.inviteFor(req.account.id)) chats.newCode(req.account.id);
  res.json({
    token: unlocks.issue(req.account.id,Boolean(req.deviceId&&req.body?.keepUnlocked===true)),
    access: accessStatus(req.account),termsVersion:TERMS_VERSION,termsAccepted:req.account.terms_version===TERMS_VERSION,suspended:Boolean(req.account.suspended&&(!req.account.suspended_until||req.account.suspended_until>Date.now()))
  });
});
app.post('/api/login/unlock', guard('unlock', 10, 60_000), (req, res) => {
  const result = verifyLogin(db, req.account.id, req.body?.pin);
  recordActivity(db, req.account.id, result === 'ok' ? 'Unlock successful' : result === 'locked' ? 'Unlock temporarily blocked' : 'Unlock rejected');
  if (result !== 'ok') return loginError(res, result);
  res.json({
    token: unlocks.issue(req.account.id,Boolean(req.deviceId&&req.body?.keepUnlocked===true)),
    access: accessStatus(req.account),termsVersion:TERMS_VERSION,termsAccepted:req.account.terms_version===TERMS_VERSION,suspended:Boolean(req.account.suspended&&(!req.account.suspended_until||req.account.suspended_until>Date.now()))
  });
});
app.post('/api/login/lock', (req, res) => {
  unlocks.revoke(req.account.id, req.get('x-qzu-unlock'));
  res.json({
    ok: true
  });
});
app.post('/api/login/emergency', guard('pin-use', 10, 15 * 60_000), (req, res) => {
  if (req.body?.confirmed !== true) {
    return res.status(400).json({ error: 'Confirm the deletion first.' });
  }

  const result = usePin(db, req.account.id, req.body?.pin);

  if (result !== 'ok') {
    return res.status(result === 'locked' ? 429 : 400).json({
      error: result === 'locked' ? 'Try again in 15 minutes.' : 'Invalid or unavailable emergency PIN.'
    });
  }

  chats.erase(req.account.id);prekeys.remove(req.account.id);
  push.remove(req.account.id);
  recordActivity(db, req.account.id, 'Emergency PIN used');
  unlocks.revokeAll(req.account.id);
  res.json({ ok: true });
});

function deleteAccount(id){controlSessions.revokeAccount(id);helpTickets.erase(id);sellers.erase(id,chats);desktopChats.erase(id);
  chats.erase(id);prekeys.remove(id);compliance.purge(id);official.erase(id);push.remove(id);unlocks.revokeAll(id);chats.hidePresence(id);
}
app.use('/api',(req,res,next)=>{
  if(!unlocks.check(req.account.id,req.get('x-qzu-unlock')))return res.status(423).json({error:'Locked.'});
  next();
});
app.post('/api/login/background-lock',guard('background-lock',10,60000),(req,res)=>{if(!req.deviceId||typeof req.body?.keepUnlocked!=='boolean')return res.status(400).json({error:'Registered device required.'});res.json({ok:unlocks.setIdle(req.account.id,req.get('x-qzu-unlock'),req.body.keepUnlocked)});});
app.post('/api/admin/logout',guard('admin-logout',5,60000),(req,res)=>{
  const a=req.account;
  if(a.access_plan!=='admin'||!req.deviceId||req.body?.confirmed!==true)return res.status(403).json({error:'Confirmed admin logout required.'});
  if(a.suspended&&(!a.suspended_until||a.suspended_until>Date.now()))return res.status(403).json({error:'Account suspended.'});
  if(!db.prepare('SELECT hash FROM support_keys WHERE account=? AND redeemed IS NOT NULL').get(a.id))return res.status(409).json({error:'Admin key unavailable.'});
  // Assigned support cases belong to the slot; personal conversations and device secrets do not.
  chats.erase(a.id,true);chats.hidePresence(a.id);prekeys.remove(a.id);push.remove(a.id);official.erase(a.id);unlocks.revokeAll(a.id);
  db.prepare('DELETE FROM blocks WHERE owner=? OR target=?').run(a.id,a.id);
  db.prepare('DELETE FROM security_activity WHERE owner=?').run(a.id);
  db.prepare('UPDATE accounts SET deletion_hash=NULL,terms_version=0 WHERE id=?').run(a.id);
  controlSessions.revokeAccount(a.id);res.json(releaseSupportKey(db,a.id));
});
app.post('/api/account/recovery-code',guard('recovery-code',5,60000),(req,res)=>res.json(issueRecovery(db,req.account.id,req.body?.pin)));
app.post('/api/account/deletion-code',guard('deletion-code',5,60000),(req,res)=>res.json({code:compliance.deletionCode(req.account.id)}));
app.post(['/api/account/delete','/api/logout'],guard('delete-account',3,60000),(req,res)=>{
  if(req.body?.confirmed!==true)return res.status(400).json({error:'Confirmation required.'});
  deleteAccount(req.account.id);
  res.clearCookie(cookieName,{httpOnly:true,secure:production,sameSite:'strict',path:'/'});
  res.json({ok:true});
});
app.post('/api/terms/accept',guard('terms',10,60000),(req,res)=>res.json(compliance.accept(req.account.id,req.body?.version)));
app.use('/api',(req,res,next)=>{
  if(req.account.suspended&&(!req.account.suspended_until||req.account.suspended_until>Date.now()))return res.status(403).json({error:'Account suspended.'});
  if(req.account.restricted_until>Date.now()&&req.method==='POST'&&['/message','/encryption/message','/encryption/once/send','/message/edit','/message/react','/encryption/reaction','/connect','/connection/respond','/group/create','/group/invite','/contacts/open','/invite','/tickets/open','/tickets/send'].includes(req.path))return res.status(403).json({error:'Messaging is temporarily restricted.'});
  if(!accessStatus(req.account).active)return res.status(402).json({error:'qzu-Access renewal required.'});
  if(req.account.terms_required&&req.account.terms_version!==TERMS_VERSION&&req.method==='POST'&&!['/privacy/invisible','/push/remove','/chat/delete','/block','/contacts/remove'].includes(req.path))return res.status(403).json({error:'Accept the current Terms of Service first.'});
  next();
});
app.get('/api/sellers/directory',guard('seller-directory',30,60000),(req,res)=>res.json({items:sellers.directory(req.account.id)}));
app.post('/api/sellers/profile',guard('seller-profile',10,60000),(req,res)=>res.json(sellers.rename(req.account.id,req.body?.name)));
app.post('/api/sellers/connect',guard('seller-connect',10,60000),(req,res)=>{if(!sellers.isActive(req.account.id)||!sellers.isActive(req.body?.id))return res.status(403).json({error:'Seller unavailable.'});if(req.account.restricted_until>Date.now())return res.status(403).json({error:'Messaging is temporarily restricted.'});const invite=sellers.ensureCode(req.body.id,chats);res.json(chats.requestConnection(req.account.id,invite.code,sellers.name(req.body.id)));});
app.get('/api/tickets',guard('user-tickets',60,60000),(req,res)=>res.json({items:helpTickets.list(req.account.id),completed:helpTickets.completions(req.account.id)}));
app.post('/api/tickets/open',guard('user-ticket-open',10,60000),(req,res)=>{if(req.account.access_plan==='admin')return res.status(403).json({error:'Use Control to manage tickets.'});const b=req.body||{},t=helpTickets.open(req.account.id,b.topic,b.text,b.requestId);notifyPaymentAdmins();res.json(t);});
app.post('/api/tickets/state',guard('user-ticket-state',60,60000),(req,res)=>res.json(helpTickets.view(req.body?.id,req.account.id)));
app.post('/api/tickets/send',guard('user-ticket-send',30,60000),(req,res)=>{const b=req.body||{},t=helpTickets.send(b.id,req.account.id,false,b.text,b.requestId);notifyHelp(t.id,req.account.id);if(!t.assigned)notifyPaymentAdmins();res.json(t);});
app.post('/api/report',guard('report',5,60000),(req,res)=>{
  const room=chats.requireRoom(req.account.id,req.body?.id);
  const messageId=req.body?.messageId;
  let target;
  if(messageId){const message=room.messages.find(m=>m.id===messageId&&!m.deleted);if(!message||message.sender===req.account.id)return res.status(400).json({error:'Message unavailable.'});target=message.sender;}
  else target=room.group?room.users.find(m=>m!==req.account.id&&room.labels.get(m)===req.body?.member):room.users.find(m=>m!==req.account.id);
  if(!target)return res.status(400).json({error:'Choose a contact.'});
  const items=req.body?.context??[];
  if(!Array.isArray(items)||items.length>24)return res.status(400).json({error:'Choose up to 24 messages.'});
  const selected=new Set();const context=[];for(const entry of items){const m=room.messages.find(x=>x.id===entry?.id&&!x.deleted&&!x.once&&!x.burnSeconds);if(!m||selected.has(m.id)||m.kind!=='text'||typeof entry.text!=='string'||entry.text.length>1000)return res.status(400).json({error:'Selected evidence is unavailable.'});selected.add(m.id);context.push({id:m.id,sender:m.sender===req.account.id?'Reporter':m.sender===target?'Reported account':'Other participant',at:m.at,reported:m.id===messageId,text:room.encryption?entry.text:m.text.slice(0,1000),source:room.encryption?'reporter-submitted':'server-confirmed'});}
  context.sort((a,b)=>a.at-b.at);
  let attachment=null;
  if(req.body?.attachment){
    const item=req.body.attachment,m=room.messages.find(x=>x.id===messageId&&!x.deleted&&!x.once&&!x.burnSeconds);
    if(!m||!['image','audio'].includes(m.kind))return res.status(400).json({error:'Reported attachment unavailable.'});
    const types=m.kind==='image'?['image/jpeg','image/png','image/webp']:['audio/mp4','audio/webm','audio/ogg'];
    if(!types.includes(item.mime)||typeof item.data!=='string'||item.data.length>Math.ceil(2*1024*1024/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.data))return res.status(400).json({error:'Invalid evidence attachment.'});
    const bytes=Buffer.from(item.data,'base64');if(!bytes.length||bytes.length>2*1024*1024||bytes.toString('base64')!==item.data)return res.status(400).json({error:'Invalid evidence attachment.'});
    if(!room.encryption&&(!m.media||m.media.mime!==item.mime||!m.media.bytes.equals(bytes)))return res.status(400).json({error:'Evidence does not match the message.'});
    attachment={messageId:m.id,kind:m.kind,mime:item.mime,body:bytes,source:room.encryption?'reporter-submitted':'server-confirmed',at:m.at};
  }
  const result=compliance.report(req.account.id,target,room.id,req.body?.reason,req.body?.evidence??'',messageId||null,context,room.encryption?'encrypted direct':room.group?'group':room.support?'support':'direct',attachment);
  const admin=db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired'").all().map(a=>a.id);push.notify(admin);res.json(result);
});
app.get('/api/admin/reports',guard('report-list',30,60000),(req,res)=>{if(req.account.access_plan!=='admin')return res.sendStatus(403);res.json({items:compliance.list(true)});});
app.get('/api/admin/reports/media/:id',guard('report-media',40,60000),(req,res)=>{if(req.account.access_plan!=='admin')return res.sendStatus(403);const media=compliance.media(req.params.id);if(!media)return res.sendStatus(404);res.set('Cache-Control','no-store').type(media.mime).send(Buffer.from(media.body));});
app.post('/api/admin/reports/collaborate',guard('report-collaborate',30,60000),(req,res)=>{if(req.account.access_plan!=='admin')return res.sendStatus(403);const result=compliance.collaborate(req.body?.id,req.account.id,req.body?.status,req.body?.note??'');if(req.body?.status==='help')push.notify(db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired' AND id<>?").all(req.account.id).map(a=>a.id));res.json(result);});
app.post('/api/admin/reports/resolve',guard('report-resolve',20,60000),(req,res)=>{if(req.account.access_plan!=='admin')return res.sendStatus(403);const result=compliance.resolve(req.body?.id,req.body?.action,req.account.id,req.body?.notes??'');if(result.warn){chats.sendAdmin(result.warn,'Moderation warning\nYour account has received a warning. Please follow the Terms of Service.');push.notify([result.warn]);}if(result.target){chats.erase(result.target);push.remove(result.target);unlocks.revokeAll(result.target);}res.json({ok:true});});
app.post('/api/admin/reports/reinstate',guard('reinstate',20,60000),(req,res)=>{if(req.account.access_plan!=='admin')return res.sendStatus(403);res.json(compliance.reinstate(req.body?.target,req.account.id,req.body?.notes??''));});
const activeSupportAccounts=()=>{
 const mobile=db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND access_revoked=0 AND pin_state!='retired' AND login_hash IS NOT NULL AND device_id IS NOT NULL AND (suspended=0 OR suspended_until<=?)").all(Date.now()).map(a=>a.id);
 return [...new Set([...mobile,...controlSessions.activeDesktopIds()])].map(id=>({id}));
};
const supportAccount=(user=null)=>{
  const agents=activeSupportAccounts().filter(agent=>agent.id!==user);
  if(user){
    const existing=[...chats.rooms.values()].find(room=>room.supportAgent&&room.users.includes(user)&&agents.some(agent=>agent.id===room.supportAgent));
    if(existing)return agents.find(agent=>agent.id===existing.supportAgent);
  }
  const load=id=>[...chats.rooms.values()].filter(room=>room.supportAgent===id).length;
  return agents.sort((a,b)=>load(a.id)-load(b.id)||a.id.localeCompare(b.id))[0];
};
app.post('/api/support/open', guard('support-open', 10, 60000), (req,res) => {
  const existing=contacts.list(req.account.id).find(c=>chats.profileRole(contacts.peer(req.account.id,c.id))==='admin');if(existing)return res.json({id:chats.openContact(req.account.id,existing.id)});
  const agent=supportAccount(req.account.id);
  if(!agent||agent.id===req.account.id)return res.status(404).json({error:'Support unavailable.'});
  const before=chats.supportConversation(req.account.id,agent.id);const id=chats.openMobileSupport(req.account.id,agent.id);if(!before)push.notify([agent.id]);res.json({id});
});
app.post('/api/support/contact/delete',guard('support-contact-delete',20,60000),(req,res)=>{const id=req.body?.id,room=chats.rooms.get(id);if(req.body?.confirmed!==true||!room||!room.users.includes(req.account.id))return res.status(403).json({error:'Confirmation required.'});if(room.supportAgent===req.account.id&&isTicketAdmin(req.account.id)){const peer=room.users.find(x=>x!==req.account.id),result=chats.deleteSupportContact(req.account.id,id,true);push.notify([peer]);return res.json(result);}const duplicate=room.deletionKind==='contact';const result=chats.requestSupportContactDeletion(req.account.id,id);if(!duplicate)push.notify([room.supportAgent]);res.json(result);});
app.post('/api/support/delete',guard('support-delete',20,60000),(req,res)=>{if(req.account.access_plan!=='admin'||req.body?.confirmed!==true)return res.status(403).json({error:'Confirmed support admin required.'});const result=approveDeletion(req.account.id,req.body.id);auditLedger.record(req.account.id,'mobile','support/delete','support',req.body.id);res.json(result);});
app.post('/api/support/respond', guard('support-respond', 40, 60000), (req,res) => {
  if(req.account.access_plan!=='admin')return res.status(403).json({error:'Support admin required.'});
  res.json(chats.respondSupport(req.account.id,req.body?.id,req.body?.action,true));
});
app.post('/api/contacts/open', guard('contacts-open', 30, 60000), (req,res) => res.json({id:chats.openContact(req.account.id,req.body?.id)}));
app.post('/api/contacts/update', guard('contacts-update', 30, 60000), (req,res) => res.json(chats.updateContact(req.account.id,req.body?.id,req.body||{})));
app.post('/api/contacts/remove', guard('contacts-remove', 20, 60000), (req,res) => {const peer=contacts.peer(req.account.id,req.body?.id),result=chats.removeContact(req.account.id,req.body.id,req.body.block===true);if(!result.duplicate)notifyDeletionAdmin(peer);if(req.account.access_plan==='admin'&&!result.requested)auditLedger.record(req.account.id,'mobile','contacts/remove','contact',req.body.id,peer);res.json(result);});
app.post('/api/login/change', guard('login-change', 10, 60_000), (req, res) => {
  const result = changeLogin(db, req.account.id, req.body?.current, req.body?.next);
  if (result !== 'ok') return loginError(res, result);
  recordActivity(db, req.account.id, 'Login PIN changed');
  unlocks.revokeAll(req.account.id);
  res.json({
    token: unlocks.issue(req.account.id)
  });
});
app.get('/api/security/activity', (req, res) => res.json({ events: listActivity(db, req.account.id) }));
function updateLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const releaseDirectory = resolve(process.env.QZU_RELEASE_DIR || resolve(root, 'data/releases'));
const apkName = 'qzu-' + version + '.apk';
const apkPath = resolve(releaseDirectory, apkName);
function androidUpdateLink() {
  return updateLink(process.env.QZU_ANDROID_UPDATE_URL) || (publicOrigin && existsSync(apkPath) ? updateLink(publicOrigin + '/downloads/' + apkName) : null);
}
app.get('/api/version', (req, res) => res.json({
  latest: version,
  notes: 'qzu. Admin & Seller Network: desktop admin messaging, seller verification, rotating codes and user tickets.',
  changes: ['Desktop admin messenger and announcements','Seller activation and verification','28-day seller codes','User tickets with seller assignment and archive'],
  downloads: { ios: updateLink(process.env.QZU_IOS_UPDATE_URL), android: androidUpdateLink() }
}));
app.post('/api/support/lifetime', guard('support-lifetime', 15, 60000), (req,res) => {
  if(req.account.access_plan!=='admin')return res.status(403).json({error:'Support admin required.'});
  res.json(chats.setSupportTimer(req.account.id,req.body?.id,req.body?.mode,true));
});
app.post('/api/chat/extend', guard('extend', 15, 60000), (req, res) => res.json(chats.extend(req.account.id, req.body?.id, req.body?.action, req.body?.requestId)));
app.post('/api/message/burn-open', guard('burn-open', 80, 60000), (req, res) => res.json(chats.openBurn(req.account.id, req.body?.id, req.body?.messageId, Boolean(req.account.invisible))));
app.post('/api/chat/fingerprint', guard('fingerprint', 15, 60000), (req, res) => {
  const room = chats.requireRoom(req.account.id, req.body?.id);
  if (room.group || room.admin || room.support || room.users.length !== 2) return res.status(400).json({ error: 'Direct device-bound chats only.' });
  const ids = room.users.map(id => db.prepare('SELECT device_id FROM accounts WHERE id=?').get(id)?.device_id);
  if (ids.some(id => !id || !/^[a-f0-9]{64}$/.test(id))) return res.status(400).json({ error: 'Both participants need registered mobile devices.' });
  res.json({ code: createHash('sha256').update('qzu-device-pair-v1:' + ids.sort().join(':')).digest('hex').toUpperCase() });
});
app.post('/api/encryption/prekeys',guard('prekeys',6,60000),(req,res)=>res.json(prekeys.register(req.account.id,req.deviceId,req.body?.items)));
app.post('/api/encryption/key', guard('encryption-key', 20, 60000), (req, res) => {
  res.json(chats.publishRoomKey(req.account.id, req.body?.id, req.deviceId, req.body?.record));
});
app.post('/api/encryption/confirm', guard('encryption-confirm', 20, 60000), (req, res) => {
  if(typeof req.body?.code!=='string')return res.status(400).json({error:'Update qzu. to verify the safety code.'});
  res.json(chats.confirmRoomKey(req.account.id, req.body?.id,req.body.code,req.body?.automatic===true));
});
app.post('/api/encryption/message', guard('encrypted-send', 80, 60000), (req, res) => {
  if (!req.deviceId) return res.status(403).json({ error: 'Registered mobile device required.' });
  const sent=chats.sendEncrypted(req.account.id, req.body?.id, req.body?.cipher, req.body?.kind,req.body?.replyCipher??null,req.body?.requestId??null);
  if(!sent?.duplicate)notifyRoom(req.account.id,req.body.id);
  res.json(typeof sent==='string'?{id:sent}:sent);
});
app.post('/api/encryption/once/send',guard('encrypted-send',80,60000),(req,res)=>{
  if(!req.deviceId)return res.status(403).json({error:'Registered mobile device required.'});
  const id=chats.sendEncrypted(req.account.id,req.body?.id,req.body?.cipher,req.body?.kind,null,null,true);
  notifyRoom(req.account.id,req.body.id);res.json({id});
});
app.post('/api/encryption/once/open',guard('open',80,60000),(req,res)=>{
  if(!req.deviceId)return res.status(403).json({error:'Registered mobile device required.'});
  res.json(chats.openOnce(req.account.id,req.body?.id,req.body?.messageId,Boolean(req.account.invisible),true));
});
app.post('/api/encryption/reaction',guard('encrypted-reaction',80,60000),(req,res)=>{if(!req.deviceId)return res.status(403).json({error:'Registered mobile device required.'});res.json(chats.reactEncrypted(req.account.id,req.body?.id,req.body?.messageId,req.body?.cipher));});
app.get('/api/encryption/media/:room/:message', guard('encrypted-media', 80, 60000), (req, res) => {
  if (!req.deviceId) return res.status(403).json({ error: 'Registered mobile device required.' });
  res.json(chats.getEncryptedMedia(req.account.id, req.params.room, req.params.message));
});
function stateData(a) {
  return {
    now: Date.now(),
    termsVersion:TERMS_VERSION,termsAccepted:a.terms_version===TERMS_VERSION,
    capabilities: { encryptedDirect: chats.requireEncryptedDirect, encryptedProtocol: 2, encryptedExtras:true, offlinePrekeys:true, queuedSends:true, encryptedOnce:true, live: true },
    prekeyCount:prekeys.count(a.id),
    official:official.snapshot(a.id),
    push:{available:push.enabled,platforms:push.platforms,registered:push.registered(a.id),diagnostic:push.diagnostic(a.id)},
    access: accessStatus(a),
    supportAgent: a.access_plan==='admin',
    seller:a.access_plan==='seller',sellerName:sellers.name(a.id),sellerVerified:sellers.role(a.id)==='verified-seller',
    supportAvailable: a.access_plan!=='admin' && Boolean(supportAccount()),
    supportRequests: a.access_plan==='admin' ? chats.supportRequests(a.id,true) : [],
    supportDeletions:a.access_plan==='admin'?deletionInbox(a.id):[],
    ...(a.access_plan==='admin'?{feedbackCount:feedback.count(true)}:{}),
    rooms: chats.snapshot(a.id),
    contacts: contacts.list(a.id).map(c=>({...c,peerRole:chats.profileRole(contacts.peer(a.id,c.id)),peerAdmin:chats.adminAccount(contacts.peer(a.id,c.id)),peerName:chats.profileName(contacts.peer(a.id,c.id))})),
    requests: chats.connectionRequests(a.id),
    invite: chats.ensureInvite(a.id),
    pinState: a.pin_state,
    invisible: Boolean(a.invisible),
    resetPending: Boolean(a.request),
    resetDelivered: Boolean(a.request && a.request_sent)
  };
}
app.get('/api/state',(req,res)=>{
  chats.markPresent(req.account.id,Boolean(req.account.invisible));
  res.json(versionedState(stateData(req.account)));
});
app.get('/api/state/live',guard('live',180,60000),(req,res,next)=>{
  const since=req.query.since,id=req.account.id,token=req.get('x-qzu-unlock');
  if(typeof since!=='string'||!/^[a-f0-9]{64}$/.test(since))return res.status(400).json({error:'Invalid state revision.'});
  chats.markPresent(id,Boolean(req.account.invisible));
  const immediate=versionedState(stateData(req.account),since);
  if(!immediate.unchanged||liveTotal>=300||(liveWaiters.get(id)||0)>=2)return res.json(immediate);
  liveTotal++;liveWaiters.set(id,(liveWaiters.get(id)||0)+1);
  const deadline=Date.now()+4500;
  let timer,closed=false;
  const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);liveTotal--;const count=liveWaiters.get(id)-1;if(count)liveWaiters.set(id,count);else liveWaiters.delete(id);};
  res.once('close',cleanup);
  timer=setInterval(()=>{
    if(closed)return;
    try{
      if(!unlocks.check(id,token)){cleanup();return res.status(423).json({error:'Locked.'});}
      const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
      if(!account||account.pin_state==='retired'||!accessStatus(account).active){cleanup();return res.status(402).json({error:'Access unavailable.'});}
      const current=versionedState(stateData(account),since);
      if(!current.unchanged||Date.now()>=deadline){cleanup();res.json(current);}
    }catch(error){cleanup();next(error);}
  },500);
});
app.post('/api/official/publish',guard('official-publish',10,60000),(req,res)=>{
  const result=official.publish(req.body?.text,req.account.access_plan==='admin');
  auditLedger.record(req.account.id,'mobile','announcements/publish','announcement',result.id);push.broadcast(req.account.id);
  res.json(result);
});
app.post('/api/official/delete',guard('official-delete',20,60000),(req,res)=>{const result=official.remove(req.body?.id,req.account.access_plan==='admin');auditLedger.record(req.account.id,'mobile','announcements/delete','announcement',req.body.id);res.json(result);});
app.post('/api/official/read',guard('official-read',60,60000),(req,res)=>res.json(official.mark(req.account.id,req.body?.id)));
app.get('/api/official/history',guard('official-history',30,60000),(req,res)=>res.json(official.history(Number(req.query.before))));
app.post('/api/push/register',guard('push-register',10,60000),(req,res)=>{
  if(!req.deviceId)return res.status(403).json({error:'Registered mobile device required.'});
  res.json(push.register(req.account.id,req.body?.platform,req.body?.token));
});
app.post('/api/push/test',guard('push-test',3,60000),async(req,res)=>res.json(await push.test(req.account.id)));
app.post('/api/push/remove',guard('push-remove',10,60000),(req,res)=>{push.remove(req.account.id);res.json({ok:true});});
app.post('/api/invite',guard('invite',15,60000),(req,res)=>res.json(chats.newCode(req.account.id,req.body?.minutes??10)));
app.get('/api/qr', async(req, res) => {
  const inv = chats.ensureInvite(req.account.id);
  const origin = publicOrigin || req.protocol + '://' + req.get('host');
  const image = await QRCode.toDataURL(origin + '/connect#' + inv.code, {
    width: 320,
    margin: 4,
    errorCorrectionLevel: 'M'
  });
  res.json({ image, code: inv.code, expires: inv.expires });
});
app.post('/api/connect/preview',guard('connect-preview',10,60000),(req,res)=>{const code=typeof req.body?.code==='string'?req.body.code.trim().toUpperCase():'';sellers.sync(chats);chats.sweep();const invite=chats.codes.get(code);if(!invite||invite.user===req.account.id||!desktopChats.valid(invite.user))return res.status(404).json({error:'Connection unavailable.'});res.json({admin:!invite.group&&chats.profileRole(invite.user)==='admin',group:Boolean(invite.group)});});
app.post('/api/connect', guard('connect', 10, 60_000), (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase(): '';
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({
    error: 'Enter a 6-character code.'
  });
  sellers.sync(chats);chats.sweep();
  const invite=chats.codes.get(code);
  if(invite&&!desktopChats.valid(invite.user))return res.status(404).json({error:'Connection unavailable.'});
  res.json(chats.requestConnection(req.account.id, code, req.body?.nickname));
});
function notifyRoom(sender,id){
  const room=chats.rooms.get(id);if(!room)return;
  push.notify(room.users.filter(account=>account!==sender&&!contacts.between(account,sender)?.muted));
}
app.post('/api/message', guard('send', 80, 60_000), (req, res) => {
  chats.send(req.account.id, req.body?.id, req.body?.text, req.body?.replyTo ?? null, req.body || {});
  notifyRoom(req.account.id,req.body.id);
  res.json({
    ok: true
  });
});
app.post('/api/connection/respond', guard('connection-response', 30, 60_000), (req, res) => {
  res.json(chats.respondConnection(req.account.id, req.body?.id, req.body?.accept === true, req.body?.nickname));
});

app.post('/api/message/unsend', guard('unsend', 40, 60_000), (req, res) => {
  chats.unsend(req.account.id, req.body?.id, req.body?.messageId, req.account.access_plan==='admin');
  res.json({ ok: true });
});

app.post('/api/privacy/invisible', guard('invisible', 20, 60_000), (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid setting.' });
  db.prepare('UPDATE accounts SET invisible=? WHERE id=?').run(Number(req.body.enabled), req.account.id);
  chats.markPresent(req.account.id, req.body.enabled);
  res.json({ invisible: req.body.enabled });
});

app.post('/api/feedback', guard('feedback', 3, 10 * 60_000), async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000 || req.body?.confirmed !== true) {
    return res.status(400).json({ error: 'Enter and confirm your feedback.' });
  }
  feedback.submit(message,true);
  res.json({ok:true});
  if(process.env.QZU_FEEDBACK_WEBHOOK)void sendFeedback(message).catch(()=>{});
});
app.get('/api/admin/feedback',guard('admin-feedback',60,60000),(req,res)=>res.json({items:feedback.list(req.account.access_plan==='admin',req.query.before===undefined?Number.MAX_SAFE_INTEGER:Number(req.query.before))}));
app.post('/api/admin/feedback/review',guard('admin-feedback-review',60,60000),(req,res)=>res.json(feedback.review(req.account.access_plan==='admin',req.body?.id)));
app.post('/api/admin/feedback/status',guard('admin-feedback-status',30,60000),(req,res)=>{const result=feedback.status(req.account.access_plan==='admin',req.body?.id,req.body?.status,req.account.id,req.body?.note??'');if(req.body?.status==='help')push.notify(db.prepare("SELECT id FROM accounts WHERE access_plan='admin' AND pin_state!='retired' AND id<>?").all(req.account.id).map(a=>a.id));res.json(result);});
app.post('/api/admin/feedback/delete',guard('admin-feedback-delete',30,60000),(req,res)=>res.json(feedback.remove(req.account.access_plan==='admin',req.body?.id)));

app.post('/api/message/edit', guard('edit', 40, 60_000), (req, res) => {
  chats.edit(req.account.id, req.body?.id, req.body?.messageId, req.body?.text);
  res.json({ ok: true });
});

app.post('/api/message/react', guard('react', 80, 60_000), (req, res) => {
  chats.react(req.account.id, req.body?.id, req.body?.messageId, req.body?.emoji);
  res.json({ ok: true });
});

app.post('/api/message/open', guard('open', 80, 60_000), (req, res) => {
  res.json(chats.openOnce(req.account.id, req.body?.id, req.body?.messageId, Boolean(req.account.invisible)));
});

app.get('/api/media/:room/:message', guard('media', 120, 60_000), (req, res) => {
  const media = chats.getMedia(req.account.id, req.params.room, req.params.message);
  res.type(media.mime).send(media.bytes);
});

app.post('/api/block', guard('block', 20, 60_000), (req, res) => {
  chats.blockContact(req.account.id, req.body?.id, req.body?.member);
  res.json({ ok: true });
});

app.get('/api/blocks', (req, res) => {
  res.json({ blocks: blocks.list(req.account.id) });
});

app.post('/api/unblock', guard('unblock', 20, 60_000), (req, res) => {
  blocks.remove(req.account.id, req.body?.target);
  res.json({ ok: true });
});

app.post('/api/group/create', guard('group-create', 10, 60_000), (req, res) => {
  res.json({ id: chats.createGroup(req.account.id) });
});

app.post('/api/group/invite', guard('group-invite', 20, 60_000), (req, res) => {
  res.json(chats.groupInvite(req.account.id, req.body?.id));
});

app.post('/api/typing', guard('typing', 100, 60_000), (req, res) => {
  chats.setTyping(req.account.id, req.body?.id, req.body?.active, Boolean(req.account.invisible));
  res.json({ ok: true });
});

app.post('/api/receipts', guard('receipts', 100, 60_000), (req, res) => {
  chats.acknowledge(req.account.id, req.body?.entries, Boolean(req.account.invisible));
  res.json({ ok: true });
});

app.post('/api/chat/delete', (req, res) => {
  const room=chats.rooms.get(req.body?.id),alreadyRequested=room?.deletionRequested;
  const result=chats.remove(req.account.id, req.body?.id, req.account.access_plan==='admin');
  if(result?.requested&&!result.duplicate&&!alreadyRequested&&room)notifyDeletionAdmin(room.users.find(x=>x!==req.account.id));else if(!result?.requested&&room){push.notify(room.users.filter(x=>x!==req.account.id));if(req.account.access_plan==='admin')auditLedger.record(req.account.id,'mobile','chat/delete','chat',req.body.id);}
  res.json({ok:true,...result});
});
app.post('/api/pin/issue', guard('pin-issue', 5, 60_000), (req, res) => {
  const pin = issuePin(db, req.account.id, req.body?.pin);
  if (pin === null) return res.status(409).json({
    error: 'Choose a different PIN, or request a reset.'
  });
  res.json({
    ok: true
  });
});
app.post('/api/pin/reset', guard('pin-reset', 5, 60_000), async(req, res) => {
  const id = req.account.id;
  const ref = requestReset(db, id);
  if (!ref) return res.status(409).json({
    error: 'Reset unavailable.'
  });
  if (req.account.request === ref && req.account.request_sent) return res.json({
    pending: true
  });
  try {
    if (!sendingResets.has(ref)) {
      const delivery = sendReset(ref).then(() => markRequestSent(db, ref)).finally(() => sendingResets.delete(ref));
      sendingResets.set(ref, delivery);
    }
    await sendingResets.get(ref);
    res.json({
      pending: true
    });
  } catch {
    res.status(503).json({
      error: 'Reset delivery unavailable. Try again.'
    });
  }
});
app.post('/api/emergency', guard('pin-use', 10, 15 * 60_000), (req, res) => {
  const result = usePin(db, req.account.id, req.body?.pin);
  if (result !== 'ok') return res.status(result === 'locked' ? 429: 400).json({
    error: result === 'locked' ? 'Try again in 15 minutes.': result === 'unavailable' ? 'PIN unavailable.': 'Incorrect PIN.'
  });
  chats.erase(req.account.id);push.remove(req.account.id);
  res.json({
    ok: true
  });
});
app.use('/api', (req, res) => res.status(404).json({
  error: 'Not found.'
}));
app.get('/healthz', (req, res) => res.json({ ok: true, version }));
const escapePrivacy = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
app.get('/privacy.css', (req,res)=>res.sendFile(resolve(root,'public/privacy.css')));
app.get(['/privacy','/privacy.html','/terms','/delete-account'], (req,res)=>{
  const name=process.env.QZU_PRIVACY_OPERATOR?.trim()||'qzu. developer (operator details pending)';
  const email=process.env.QZU_PRIVACY_EMAIL?.trim()||'';
  const contact=/^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)?'<a href="mailto:'+escapePrivacy(email)+'">'+escapePrivacy(email)+'</a>':'Settings &gt; Help &gt; Write Support (public email pending)';
  const policy=readFileSync(resolve(root,'public',req.path==='/terms'?'terms.html':req.path==='/delete-account'?'delete-account.html':'privacy.html'),'utf8').replace('__QZU_OPERATOR__',()=>escapePrivacy(name)).replace('__QZU_CONTACT__',()=>contact);
  res.type('html').send(policy);
});
app.post('/delete-account',express.urlencoded({extended:false,limit:'2kb'}),(req,res)=>{
  if(!rate('delete-web:'+req.ip,5,60000))return res.status(429).type('text').send('Try again later.');
  const id=compliance.byDeletionCode(req.body?.code);
  if(!id||req.body?.confirm!=='yes')return res.status(400).type('text').send('Invalid deletion code or missing confirmation. Return to the deletion page and try again.');
  deleteAccount(id);res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><title>Account deleted | qzu.</title><h1>Account deleted</h1><p>Your active account has been deleted. Limited records may remain as described in the privacy policy.</p><a href="/privacy">Privacy Policy</a></html>');
});
app.get('/downloads/' + apkName, (req, res) => {
  if (!existsSync(apkPath)) return res.sendStatus(404);
  res.download(apkPath, apkName);
});
app.get(['/control','/control.html','/control/monitoring'],(req,res)=>desktopRequest(req)?res.sendFile(resolve(root,'public/control.html')):res.status(403).type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>qzu. Control</title><h1>Desktop only</h1><p>Open qzu. Control on a Windows or Mac computer.</p></html>'));
app.get(['/control.js','/control.css','/desktop-messenger.js','/e2ee.js','/metadata.js'],(req,res)=>res.sendFile(resolve(root,'public',req.path.slice(1))));
app.use((req, res, next) => {
  if (!mobileOnly) return next();
  if (req.path === '/') return res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>qzu.</title><h1>qzu.</h1><p>Mobile app only.</p></html>');
  res.status(404).send('Not found');
});
app.get('/vendor/jsqr.js', (req, res) => res.sendFile(resolve(root, 'node_modules/jsqr/dist/jsQR.js')));
app.use(express.static(resolve(root, 'public'), {
  index: false,
  etag: false,
  lastModified: false
}));
app.get(['/', '/chat', '/connect', '/settings', '/settings/privacy', '/settings/notifications', '/settings/motion', '/settings/connections', '/settings/appearance', '/settings/account', '/settings/updates', '/settings/help', '/settings/support-requests', '/settings/admin-feedback', '/settings/about','/tickets'], (req, res) => res.sendFile(resolve(root, 'public/index.html')));
app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status: 500;
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong.': err.message
  });
});
const port = Number(process.env.PORT || 3000);
startAdminSocket(command => handleAdminCommand(db, chats, command, unlocks))
  .then(() => {
    app.listen(port, process.env.HOST || '0.0.0.0', () => console.log('qzu. listening on ' + port));
  })
  .catch(error => {
    console.error(error.message);
    db.close();
    process.exitCode = 1;
  });
