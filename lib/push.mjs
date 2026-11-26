const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function privatePush(db,options={}){
  db.exec('CREATE TABLE IF NOT EXISTS push_devices(account TEXT PRIMARY KEY, platform TEXT NOT NULL, token TEXT NOT NULL UNIQUE)');
  let endpoint;
  try{const url=new URL(options.url||'');if(url.protocol==='https:'&&!url.username&&!url.password&&options.secret)endpoint=url.href;}catch{}
  const firebase=typeof options.firebase==='function'?options.firebase:null;
  const platforms=endpoint?['ios','android']:firebase?['android']:[];
  const enabled=platforms.length>0;
  const recently=new Map(), outcomes=new Map();
  const status=(account,result)=>{outcomes.set(account,{result,at:Date.now()});return {result};};
  const send=async (row,force=false)=>{
    if(!platforms.includes(row.platform))return status(row.account,'not-configured');
    const now=Date.now();
    if(!force&&(recently.get(row.account)||0)>now)return {result:'rate-limited'};
    for(const [id,until] of recently)if(until<=now)recently.delete(id);
    recently.set(row.account,now+1500);
    try{
      if(row.platform==='android'&&firebase){
        const count=typeof options.unread==='function'?Math.max(1,Math.min(999,Number(options.unread(row.account))||1)):1;
        const result=await firebase(row.token,count);
        if(result?.unregistered){db.prepare('DELETE FROM push_devices WHERE account=? AND token=?').run(row.account,row.token);return status(row.account,'token-expired');}
        return status(row.account,'accepted');
      }
      const response=await (options.fetch||fetch)(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+options.secret},body:JSON.stringify({platform:row.platform,token:row.token,title:'qzu.',body:'New activity. Open qzu. to view.'}),signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('Push relay rejected delivery.');return status(row.account,'accepted');
    }catch(error){if(firebase&&row.platform==='android')console.warn('Private Firebase push delivery failed.');return status(row.account,'delivery-failed');}
  };
  const rows=()=>db.prepare("SELECT p.* FROM push_devices p JOIN accounts a ON a.id=p.account WHERE a.pin_state!='retired' AND (a.access_plan!='monthly' OR a.paid_until>?)").all(Date.now());
  return {
    enabled,platforms,
    diagnostic(account){return outcomes.get(account)||null;},
    async test(account){const row=db.prepare('SELECT * FROM push_devices WHERE account=?').get(account);return row?send(row,true):{result:'not-registered'};},
    registered(account){return Boolean(db.prepare('SELECT 1 FROM push_devices WHERE account=?').get(account));},
    register(account,platform,token){
      if(!platforms.includes(platform))throw fail('Push delivery is not configured for this device.',503);
      if(!['ios','android'].includes(platform)||typeof token!=='string'||!/^[A-Za-z0-9_:.-]{16,4096}$/.test(token))throw fail('Invalid push registration.');
      const previous=db.prepare('SELECT account FROM push_devices WHERE token=?').get(token);
      if(previous&&previous.account!==account)throw fail('Push token already registered.',409);
      db.prepare('INSERT INTO push_devices(account,platform,token) VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET platform=excluded.platform,token=excluded.token').run(account,platform,token);
      return {ok:true};
    },
    remove(account){db.prepare('DELETE FROM push_devices WHERE account=?').run(account);recently.delete(account);outcomes.delete(account);},
    notify(accounts){if(!enabled)return;const targets=new Set(accounts);for(const row of rows())if(targets.has(row.account))void send(row);},
    broadcast(exclude){if(!enabled)return;const list=rows().filter(row=>row.account!==exclude);void(async()=>{for(let i=0;i<list.length;i+=20)await Promise.all(list.slice(i,i+20).filter(row=>db.prepare('SELECT token FROM push_devices WHERE account=?').get(row.account)?.token===row.token).map(send));})().catch(()=>{});}
  };
}
