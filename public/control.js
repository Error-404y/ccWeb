'use strict';
(()=>{
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const button=(label,fn,cls='')=>{const b=el('button',label,'cc-button '+cls);b.type='button';b.addEventListener('click',fn);return b;};
const date=x=>x?new Date(x).toLocaleString():'—';
const input=(placeholder,type='text')=>{const n=el('input');n.type=type;n.placeholder=placeholder;n.setAttribute('aria-label',placeholder);n.autocomplete='off';return n;};
const select=(options)=>{const n=el('select');for(const [value,label] of options){const o=el('option',label);o.value=value;n.append(o);}return n;};
const status=(value)=>el('span',value==='help'?'Need Additional Help':value==='solved'?'Solved':value==='inspection'?'Under Inspection':value,'cc-status '+(value==='help'||value==='revoked'||value==='expired'?'red':value==='solved'||value==='active'||value==='confirmed'?'green':'yellow'));
const plans=[['1W','1 Week'],['1M','1 Month'],['1Y','1 Year'],['LT','Lifetime']];
function mount(root,api,{mobile=false,isActive=()=>root.isConnected,onExit=()=>{},pair=null,media=null}={}){
 root.classList.add('cc-root');root.replaceChildren();
 let revision=0,current='Overview',query='',cursor='',objectURL=null;
 const header=el('header','','cc-header');const brand=el('h1','qzu.');brand.append(el('span',' Control','cc-accent'));header.append(brand,button(mobile?'Close':'Sign out',async()=>{revision++;if(objectURL)URL.revokeObjectURL(objectURL);if(!mobile)await api('logout',{}).catch(()=>{});root.replaceChildren();onExit();},'cc-secondary'));
 const layout=el('div','','cc-layout'),nav=el('nav','','cc-nav'),main=el('section','','cc-content');main.setAttribute('aria-label','Control Center content');layout.append(nav,main);root.append(header,layout);
 const tabs=['Overview','Accounts','Keys','Payments','Reports','Feedback','Audit'];
 for(const tab of tabs)nav.append(button(tab,()=>{current=tab;query='';cursor='';load();},'cc-tab'));
 const alive=token=>isActive()&&token===revision;
 function error(e){if(isActive())main.prepend(el('p',e?.message||'Request failed.','cc-error'));}
 function details(rows){const d=el('dl','','cc-details');for(const [k,v] of rows){d.append(el('dt',k),el('dd',String(v??'—')));}return d;}
 function card(title,children=[]){const n=el('article','','cc-card');n.append(el('h3',title),...children);return n;}
 function action(label,run,cls=''){return button(label,async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;try{await run();}catch(e){error(e);}finally{b.disabled=false;}},cls);}
 function secret(title,value){const box=card(title,[el('p','Save this secret privately. It is displayed only here.'),el('code',value,'cc-secret'),action('Copy',()=>navigator.clipboard.writeText(value))]);main.prepend(box);}
 function search(placeholder){const form=el('form','','cc-search'),field=input(placeholder);field.value=query;field.maxLength=128;const b=el('button','Search','cc-button');form.append(field,b);form.addEventListener('submit',e=>{e.preventDefault();query=field.value.trim();cursor='';load();});return form;}
 function confirmAction(title,fn,{plan=false}={}){
  const box=card(title);const reason=input('Reason (required)');reason.maxLength=500;const picker=select(plans);if(plan)box.append(picker);box.append(reason,action('Confirm',async()=>{if(!reason.value.trim())throw Error('Enter a reason.');await fn(reason.value.trim(),picker.value);await load();},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary'));main.prepend(box);
 }
 async function load(){
  const token=++revision;if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
  for(const b of nav.children){b.classList.toggle('selected',b.textContent===current);b.setAttribute('aria-current',b.textContent===current?'page':'false');}
  main.replaceChildren(el('h2',current),el('p','Loading…','cc-muted'));
  try{
   const route=current==='Overview'?'overview':current==='Audit'?'audit':current.toLowerCase();
   const url=route+(['Accounts','Keys'].includes(current)?'?q='+encodeURIComponent(query)+(cursor?'&after='+encodeURIComponent(cursor):''):'');
   const data=await api(url);if(!alive(token))return;main.replaceChildren(el('h2',current),button('Refresh',load,'cc-secondary'));
   if(current==='Overview'){
    const metrics=el('div','','cc-metrics');for(const [label,val] of [['Accounts',data.accounts],['Active',data.active],['Admin accounts',data.admins],['Unused keys',data.keys],['Open reports',data.reports],['Open feedback',data.feedback],['Pending payments',data.payments],['Verified revenue','$'+(data.revenue/100).toFixed(2)]]){const n=el('div','','cc-metric');n.append(el('strong',String(val)),el('span',label));metrics.append(n);}main.append(metrics);
    if(pair)main.append(card('Desktop pairing',[el('p','Link a browser with a one-time code. Your admin PIN is required.'),button('Pair desktop',pair),action('Sign out all linked browsers',async()=>{await api('logout',{});main.prepend(el('p','Desktop sessions revoked.','cc-muted'));},'cc-secondary')]));
    main.append(card('Privacy boundary',[el('p','Only explicitly submitted report snapshots are available. Private encrypted conversations and consumed View Once content cannot be recovered.')]));
   }else if(current==='Accounts'){
    main.append(search('Account ID, key ID or fingerprint'));
    for(const a of data.items){const state=a.suspended?'suspended':a.access_revoked?'revoked':a.access.active?'active':'expired';const n=card(a.id,[status(state),details([['Plan',a.access_plan],['Expires',date(a.paid_until)],['Key ID',a.key_id],['Last activity',date(a.last_activity)],['Reports',a.reports],['Recovery configured',a.recovery_created?'Yes':'No']])]);
     if(a.access_plan!=='admin'){const actions=el('div','','cc-actions');if(!a.access_revoked&&!['lifetime','legacy'].includes(a.access_plan))actions.append(button('Extend access',()=>confirmAction('Extend '+a.id,(reason,plan)=>api('accounts/action',{id:a.id,action:'extend',reason,plan}),{plan:true})));actions.append(button(a.access_revoked?'Restore access':'Revoke access',()=>confirmAction((a.access_revoked?'Restore ':'Revoke ')+a.id,reason=>api('accounts/action',{id:a.id,action:a.access_revoked?'restore':'revoke',reason})),'cc-secondary'));n.append(actions);}
     main.append(n);
    }
    if(data.items.length===100)main.append(button('Next page',()=>{cursor=data.items.at(-1).id;load();}));if(!data.items.length)main.append(el('p','No matching accounts.'));
   }else if(current==='Keys'){
    main.append(search('Key ID, fingerprint or account ID'));const picker=select(plans),count=input('Quantity (1–100)','number');count.min='1';count.max='100';count.value='1';
    main.append(card('Generate access keys',[picker,count,action('Generate',async()=>{const result=await api('keys/generate',{plan:picker.value,count:Number(count.value)});await load();secret('New access keys',result.keys.map(k=>k.key+' · '+k.id).join('\n'));})]));
    for(const k of data.items){const state=k.state==='revoked'?'revoked':k.redeemed?'redeemed':'unused';const n=card(k.fingerprint?'QZU-••••-'+k.fingerprint:k.id,[status(state),details([['ID',k.id],['Plan',k.plan],['Created',date(k.created)],['Activated',date(k.redeemed)],['Account',k.account]])]);
     if(!k.redeemed&&k.generated&&k.state==='confirmed'){n.append(button('Replace unused key',()=>{const box=card('Replace key?',[el('p','The previous secret will stop working.'),action('Replace',async()=>{const result=await api('keys/replace',{id:k.id});await load();secret('Replacement key',result.key);},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary')]);main.prepend(box);}),button('Revoke',()=>confirmAction('Revoke unused key',reason=>api('keys/revoke',{id:k.id,reason})),'cc-secondary'));}
     main.append(n);
    }
   }else if(current==='Payments'){
    for(const p of data.items){main.append(card(p.id,[status(p.state),details([['Plan',p.plan],['Network',p.coin||'LTC (legacy)'],['Price',p.usd_cents==null?'€'+(p.eur_cents/100).toFixed(2):'$'+(p.usd_cents/100).toFixed(2)],['Transaction',p.txid],['Confirmations',p.confirmations],['Verified',date(p.verified_at)],['Account',p.redeemed_account]])]));}
   }else if(current==='Reports'){
    for(const r of data.items){const n=card(r.reason,[status(r.resolved?'solved':r.workflow||'inspection'),details([['Report',r.id],['Reported account',r.target],['Reporter',r.reporter],['Received',date(r.created)],['Previous reports',r.previousReports]]),el('p',r.evidence||'No additional details')]);
     const snap=el('div','','cc-snapshot');for(const m of r.context||[]){const bubble=el('div','','cc-bubble '+(m.sender==='Reporter'?'mine':'other')+(m.reported?' flagged':''));bubble.append(el('small',m.sender+' · '+date(m.at)),el('p',m.text),el('small',m.source==='reporter-submitted'?'Reporter-submitted':'Server-confirmed'));snap.append(bubble);}n.append(snap);
     if(r.attachment&&media)n.append(action('View submitted attachment',async()=>{const blob=await media(r.id);if(!alive(token))return;if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(blob);const node=el(r.attachment.kind==='image'?'img':'audio');node.src=objectURL;node.className='cc-evidence';if(node.tagName==='AUDIO')node.controls=true;else node.alt='Submitted report evidence';n.append(node);}));
     for(const event of r.collaboration||[])n.append(el('p','Admin '+(event.actor||'Deleted')+' · '+event.status+' · '+event.note,'cc-muted'));
     if(!r.resolved){const note=el('textarea');note.placeholder='Internal note';note.maxLength=1000;n.append(note,action('Under Inspection',async()=>{await api('reports/collaborate',{id:r.id,status:'inspection',note:note.value});await load();}),action('Need Additional Help',async()=>{await api('reports/collaborate',{id:r.id,status:'help',note:note.value});await load();},'cc-danger'));
      const choice=select([['dismiss','Mark solved / dismiss'],['warn','Warn account'],['restrict','Restrict 24h'],['suspend24h','Suspend 24h'],['suspend7d','Suspend 7 days'],['suspend','Suspend permanently']]);n.append(choice,button('Resolve report',()=>{const box=card('Confirm moderation action',[el('p',choice.options[choice.selectedIndex].textContent),action('Confirm',async()=>{await api('reports/resolve',{id:r.id,action:choice.value,notes:note.value});await load();},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary')]);n.append(box);}));}
     main.append(n);
    }
   }else if(current==='Feedback'){
    for(const f of data.items){const note=el('textarea');note.placeholder='Internal support note';note.maxLength=1000;const n=card('Feedback #'+f.id,[status(f.workflow||'inspection'),el('p',date(f.at),'cc-muted'),el('p',f.text)]);for(const e of f.events||[])n.append(el('p','Admin '+(e.actor||'Deleted')+' · '+e.status+' · '+e.note,'cc-muted'));n.append(note);for(const [value,label] of [['inspection','Under Inspection'],['help','Need Additional Help'],['solved','Solved']])n.append(action(label,async()=>{await api('feedback/status',{id:f.id,status:value,note:note.value});await load();},value==='help'?'cc-danger':''));main.append(n);}
   }else if(current==='Audit'){
    for(const a of data.items)main.append(card(a.action,[details([['Actor',a.actor],['Account',a.account],['Key',a.key_id],['At',date(a.at)],['Reason',a.reason]])]));
   }
   if(Array.isArray(data.items)&&!data.items.length&&!['Accounts','Keys'].includes(current))main.append(el('p','No records yet.','cc-muted'));
  }catch(e){if(alive(token)){main.replaceChildren(el('h2',current),el('p',e.message||'Request failed.','cc-error'),button('Retry',load));}}
 }
 load();
 return {close(){revision++;if(objectURL)URL.revokeObjectURL(objectURL);root.replaceChildren();}};
}
window.QzuControl={mount};
const desktop=document.getElementById('controlRoot');if(!desktop)return;
async function api(path,data){
 const response=await fetch('/api/control/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-QZU':'1'},body:data===undefined?undefined:JSON.stringify(data),credentials:'same-origin',cache:'no-store'});
 const value=await response.json().catch(()=>({}));if(!response.ok)throw Error(value.error||'Request failed.');return value;
}
async function media(id){const r=await fetch('/api/control/reports/media/'+encodeURIComponent(id),{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw Error('Evidence unavailable.');return r.blob();}
function login(){desktop.className='cc-root';desktop.replaceChildren();const form=el('form','','cc-pair');const field=input('One-time pairing code');field.maxLength=57;const message=el('p','Open the admin app → Control Center → Pair desktop.','cc-muted');const submit=el('button','Connect securely','cc-button');form.append(el('h1','qzu. Control'),message,field,submit);desktop.append(form);form.addEventListener('submit',async e=>{e.preventDefault();submit.disabled=true;try{await api('exchange',{code:field.value.trim().toUpperCase()});field.value='';mount(desktop,api,{onExit:login,media});}catch(e){message.textContent=e.message;}finally{submit.disabled=false;}});}
api('overview').then(()=>mount(desktop,api,{onExit:login,media})).catch(login);
})();
