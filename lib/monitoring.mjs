import { performance } from 'node:perf_hooks';
import { totalmem, freemem, loadavg } from 'node:os';

// Only fixed labels are recorded. Never retain raw URLs, headers, identifiers,
// request/response bodies, errors, or per-user message metadata.
const operations=new Map(Object.entries({
 'POST /api/control/login':['AUTH','Desktop admin sign-in'],
 'POST /api/control/logout':['AUTH','Desktop admin sign-out'],
 'POST /api/login/unlock':['AUTH','App unlock'],
 'POST /api/access/invoice':['PAYMENT','Payment order request'],
 'POST /api/access/ticket/open':['TICKET','Payment ticket opened or resumed'],
 'POST /api/access/ticket/transaction':['PAYMENT','Transaction submitted'],
 'POST /api/control/payment-tickets/release':['PAYMENT','Verified key release'],
 'POST /api/control/payment-tickets/reject':['TICKET','Payment ticket rejection'],
 'POST /api/control/payment-tickets/review':['TICKET','Payment ticket review'],
 'POST /api/control/support/respond':['SUPPORT','Support request response'],
 'POST /api/control/support/finish':['SUPPORT','Support status update'],
 'POST /api/control/reports/resolve':['ADMIN','Report resolution'],
 'POST /api/control/feedback/status':['ADMIN','Feedback status update'],
 'POST /api/control/archive':['ADMIN','Archive action'],
 'POST /api/control/keys/generate':['ADMIN','Access key generation'],
 'POST /api/control/accounts/action':['ADMIN','Account access action']
}));
const messageRoutes=new Set(['POST /api/message','POST /api/encryption/message','POST /api/encryption/once/send','POST /api/access/ticket/send','POST /api/control/payment-tickets/send','POST /api/control/support/send']);
export function createMonitoring({now=Date.now,clock=()=>performance.now(),cpu=()=>process.cpuUsage(),memory=()=>process.memoryUsage(),uptime=()=>process.uptime(),write=()=>{},capacity=200}={}){
 const events=[],buckets=new Map();let sequence=0;
 const started=now();let previousCPU=cpu(),previousTime=clock();
 let cpuPercent=null;
 function event(category,label,status){
  const entry={id:++sequence,at:now(),category,label,status};
  events.push(entry);if(events.length>capacity)events.shift();
  // Write only this explicitly constructed record to the system journal.
  try{write(JSON.stringify({qzu:'monitor',...entry}));}catch{}
 }
 function prune(minute){for(const key of buckets.keys())if(key<minute-59)buckets.delete(key);}
 function observe(method,path,status,elapsed){
  if(!Number.isInteger(status)||status<100||status>599||typeof path!=='string'||!path.startsWith('/api/')||['/api/control/monitoring','/api/control/inbox'].includes(path))return;
  const minute=Math.floor(now()/60000);prune(minute);
  let b=buckets.get(minute);if(!b){b={requests:0,errors:0,rejected:0,messages:0,duration:0,measured:0};buckets.set(minute,b);}
  b.requests++;if(path!=='/api/state/live'&&Number.isFinite(elapsed)){b.duration+=Math.max(0,Math.min(elapsed,300000));b.measured++;}
  if(status>=500)b.errors++;else if(status>=400)b.rejected++;
  const key=method+' '+path;
  if(messageRoutes.has(key)&&status>=200&&status<300)b.messages++;
  const operation=operations.get(key);
  if(operation&&(status>=200&&status<300||status>=400)){
   // Bounded console and journal: collapse bursts to one event per label/status per 5 seconds.
   const outcome=status>=500?'error':status>=400?'rejected':'ok';
   const recent=events.findLast(e=>e.category===operation[0]&&e.label===operation[1]&&e.status===outcome);
   if(!recent||now()-recent.at>=5000)event(operation[0],operation[1],outcome);
  }else if(status>=500){
   const recent=events.findLast(e=>e.category==='SYSTEM'&&e.status==='error');
   if(!recent||now()-recent.at>=5000)event('SYSTEM','API request failed','error');
  }
 }
 function middleware(req,res,next){
  const method=req.method,path=req.path,t=clock();
  res.once('finish',()=>observe(method,path,res.statusCode,clock()-t));next();
 }
 function snapshot(){
  const minute=Math.floor(now()/60000);prune(minute);
  const totals={requests:0,errors:0,rejected:0,messages:0,duration:0,measured:0};
  for(const [key,b] of buckets)if(key>=minute-4)for(const field of Object.keys(totals))totals[field]+=b[field];
  const t=clock(),c=cpu(),elapsed=t-previousTime;
  if(elapsed>=1000){cpuPercent=Math.max(0,Math.round((c.user-previousCPU.user+c.system-previousCPU.system)/elapsed)/10);previousCPU=c;previousTime=t;}
  const m=memory();
  return {started,at:now(),uptimeSeconds:Math.floor(uptime()),cpuPercent,rssBytes:m.rss,heapUsedBytes:m.heapUsed,hostMemoryBytes:totalmem(),hostFreeBytes:freemem(),load1:loadavg()[0],windowMinutes:5,requests:totals.requests,errors:totals.errors,rejected:totals.rejected,messageRequests:totals.messages,meanResponseMs:totals.measured?Math.round(totals.duration/totals.measured):null,events:events.slice().reverse().map(e=>({...e}))};
 }
 event('SYSTEM','Monitoring started','ok');
 return {middleware,observe,snapshot};
}
