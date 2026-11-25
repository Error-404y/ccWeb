import express from 'express';
import QRCode from 'qrcode';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {Chats} from './lib/chats.mjs';
import {openAccounts,createAccount,findAccount,issuePin,usePin,requestReset} from './lib/accounts.mjs';

process.umask(0o077);
const root=dirname(fileURLToPath(import.meta.url));
const app=express(), chats=new Chats(), db=openAccounts();
const production=process.env.NODE_ENV==='production';
if(production&&!process.env.PUBLIC_ORIGIN) throw new Error('Set PUBLIC_ORIGIN to your HTTPS origin.');
const publicOrigin=process.env.PUBLIC_ORIGIN;
if(production&&!publicOrigin.startsWith('https://')) throw new Error('HTTPS required.');
if(process.env.TRUST_PROXY==='1') app.set('trust proxy',1);
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Permissions-Policy':'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  if(production) res.set('Strict-Transport-Security','max-age=31536000');
  next();
});
app.use(express.json({limit:'12kb'}));
const cookieName=production?'__Host-qzu':'qzu';
const readToken=req=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
const limits=new Map();
function rate(key,max,period) {
  const now=Date.now(),old=limits.get(key);
  const bucket=old&&old.until>now?old:{count:0,until:now+period};
  limits.set(key,bucket);return ++bucket.count<=max;
}
const timer=setInterval(()=>{chats.sweep();const now=Date.now();for(const [k,v] of limits)if(v.until<=now)limits.delete(k);},1000);
timer.unref();
app.use('/api',(req,res,next)=>{
  if(!['GET','HEAD'].includes(req.method)){
    const origin=req.get('origin');
    const allowed=publicOrigin||req.protocol+'://'+req.get('host');
    if(req.get('x-qzu')!=='1'||(origin&&origin!==allowed))return res.status(403).json({error:'Request rejected.'});
  }
  if(!rate('ip:'+req.ip,600,60_000))return res.status(429).json({error:'Try again shortly.'});
  req.account=findAccount(db,readToken(req));next();
});
app.post('/api/session',(req,res)=>{
  if(!req.account){
    if(!rate('new:'+req.ip,20,60*60_000))return res.status(429).json({error:'Try again later.'});
    const {token,id}=createAccount(db);
    res.cookie(cookieName,token,{httpOnly:true,secure:production,sameSite:'strict',path:'/',maxAge:365*24*60*60_000});
    req.account={id};
  }
  res.json({ok:true});
});
app.use('/api',(req,res,next)=>req.account?next():res.status(401).json({error:'Session unavailable.'}));
const guard=(name,max,period)=> (req,res,next)=>rate(name+':'+req.account.id,max,period)?next():res.status(429).json({error:'Try again shortly.'});
app.get('/api/state',(req,res)=>{
  const a=req.account;
  res.json({now:Date.now(),rooms:chats.snapshot(a.id),invite:chats.inviteFor(a.id),pinState:a.pin_state,resetRequest:a.request});
});
app.post('/api/invite',guard('invite',15,60_000),(req,res)=>res.json(chats.newCode(req.account.id)));
app.get('/api/qr',async(req,res)=>{
  const inv=chats.inviteFor(req.account.id);
  if(!inv)return res.sendStatus(404);
  const origin=publicOrigin||req.protocol+'://'+req.get('host');
  const png=await QRCode.toBuffer(origin+'/connect#'+inv.code,{width:320,margin:2,errorCorrectionLevel:'M'});
  res.type('png').send(png);
});
app.post('/api/connect',guard('connect',10,60_000),(req,res)=>{
  const code=typeof req.body?.code==='string'?req.body.code.trim().toUpperCase():'';
  if(!/^[A-Z0-9]{6}$/.test(code))return res.status(400).json({error:'Enter a 6-character code.'});
  res.json({id:chats.connect(req.account.id,code)});
});
app.post('/api/message',guard('send',80,60_000),(req,res)=>{
  chats.send(req.account.id,req.body?.id,req.body?.text);res.json({ok:true});
});
app.post('/api/chat/delete',(req,res)=>{
  chats.remove(req.account.id,req.body?.id);res.json({ok:true});
});
app.post('/api/pin/issue',guard('pin-issue',5,60_000),(req,res)=>{
  const pin=issuePin(db,req.account.id);
  if(pin===null)return res.status(409).json({error:'PIN already issued.'});
  res.json({pin});
});
app.post('/api/pin/reset',guard('pin-reset',5,60_000),(req,res)=>{
  const ref=requestReset(db,req.account.id);
  if(!ref)return res.status(409).json({error:'Reset unavailable.'});
  res.json({ref});
});
app.post('/api/emergency',guard('pin-use',10,15*60_000),(req,res)=>{
  const result=usePin(db,req.account.id,req.body?.pin);
  if(result!=='ok')return res.status(result==='locked'?429:400).json({error:result==='locked'?'Try again in 15 minutes.':result==='unavailable'?'PIN unavailable.':'Incorrect PIN.'});
  chats.erase(req.account.id);res.json({ok:true});
});
app.use('/api',(req,res)=>res.status(404).json({error:'Not found.'}));
app.get('/vendor/jsqr.js',(req,res)=>res.sendFile(resolve(root,'node_modules/jsqr/dist/jsQR.js')));
app.use(express.static(resolve(root,'public'),{index:false,etag:false,lastModified:false}));
app.get(['/', '/chat','/connect','/settings'],(req,res)=>res.sendFile(resolve(root,'public/index.html')));
app.use((req,res)=>res.status(404).send('Not found'));
app.use((err,req,res,next)=>{
  if(res.headersSent)return next(err);
  const status=Number.isInteger(err.status)&&err.status>=400&&err.status<600?err.status:500;
  res.status(status).json({error:status>=500?'Something went wrong.':err.message});
});
const port=Number(process.env.PORT||3000);
app.listen(port,process.env.HOST||'0.0.0.0',()=>console.log('qzu. listening on '+port));
