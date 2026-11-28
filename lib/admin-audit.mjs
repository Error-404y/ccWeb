const actions=Object.freeze({
 'keys/generate':'key','keys/replace':'key','keys/revoke':'key','accounts/action':'account',
 'payment-tickets/send':'payment-ticket','payment-tickets/verify':'payment-ticket','payment-tickets/release':'payment-ticket','payment-tickets/review':'payment-ticket','payment-tickets/reject':'payment-ticket','payment-tickets/close':'payment-ticket',
 'support/delete':'support','support/finish':'support','support/respond':'support','support/send':'support','archive':'archive',
 'reports/collaborate':'report','reports/resolve':'report','feedback/status':'feedback',
 'chats/reset':'admin-identity','chats/connect':'connection','chats/respond':'connection','chats/delete':'chat',
 'sellers/generate':'seller-key','sellers/rotate':'seller','sellers/access':'seller','sellers/verify':'seller',
 'announcements/publish':'announcement','announcements/delete':'announcement','tickets/send':'ticket','tickets/action':'ticket'
});
const safeId=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value:null;
const allowedDetails=new Set(['accept','reject','assign','remove','transfer','share','close','delete','extend','revoke','restore','solve','archive','inspection','help','solved','dismiss','warn','restrict','suspend24h','suspend7d','suspend']);
export function adminAudit(db,now=Date.now){
 db.exec('CREATE TABLE IF NOT EXISTS admin_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,source TEXT NOT NULL,action TEXT NOT NULL,target_type TEXT NOT NULL,target TEXT,related TEXT,detail TEXT,at INTEGER NOT NULL,outcome TEXT NOT NULL); CREATE INDEX IF NOT EXISTS admin_activity_actor ON admin_activity(actor,id); CREATE INDEX IF NOT EXISTS admin_activity_target ON admin_activity(target,id)');
 function record(actor,source,action,targetType,target=null,related=null,detail=null,outcome='success'){
  if(!safeId(actor)||!['desktop','mobile','system'].includes(source))return;
  db.prepare('INSERT INTO admin_activity(actor,source,action,target_type,target,related,detail,at,outcome) VALUES(?,?,?,?,?,?,?,?,?)').run(actor,source,action,targetType,safeId(target),safeId(related),allowedDetails.has(detail)?detail:null,now(),outcome);
 }
 function capture(req,res){
  if(req.method!=='POST')return;
  const action=req.path.replace(/^\//,'');if(!Object.hasOwn(actions,action))return;
  const actor=req.account.id,source=req.deviceId?'mobile':'desktop',b=req.body||{};
  let target=safeId(b.id),related=safeId(b.seller);
  const detail=allowedDetails.has(b.action)?b.action:allowedDetails.has(b.status)?b.status:typeof b.verified==='boolean'?(b.verified?'accept':'revoke'):typeof b.suspended==='boolean'?(b.suspended?'suspend':'restore'):null;
  // Extract only generated record identifiers, never keys, PINs, codes or message bodies.
  const original=res.json.bind(res);res.json=value=>{if(!target&&value&&typeof value==='object')target=safeId(value.id);return original(value);};
  res.once('finish',()=>{try{record(actor,source,action,actions[action],target,related,detail,res.statusCode<400?'success':'rejected');}catch(e){console.error('Admin audit write failed');}});
 }
 function list({q='',before=Number.MAX_SAFE_INTEGER}={}){
  if(typeof q!=='string'||q.length>128||!Number.isSafeInteger(before)||before<1)throw Object.assign(Error('Invalid audit filter.'),{status:400});
  const term=q.trim();
  return db.prepare("SELECT * FROM admin_activity WHERE id<? AND (?='' OR actor=? OR target=? OR related=? OR action LIKE '%'||?||'%') ORDER BY id DESC LIMIT 100").all(before,term,term,term,term,term);
 }
 return {record,capture,list};
}
