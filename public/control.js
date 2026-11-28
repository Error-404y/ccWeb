'use strict';
(()=>{
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const button=(label,fn,cls='')=>{const b=el('button',label,'cc-button '+cls);b.type='button';b.addEventListener('click',fn);return b;};
const date=x=>x?new Date(x).toLocaleString():'—';
const input=(placeholder,type='text')=>{const n=el('input');n.type=type;n.placeholder=placeholder;n.setAttribute('aria-label',placeholder);n.autocomplete='off';return n;};
const select=(options)=>{const n=el('select');for(const [value,label] of options){const o=el('option',label);o.value=value;n.append(o);}return n;};
const status=(value)=>el('span',value==='help'?'Need Additional Help':value==='solved'?'Solved':value==='inspection'?'Under Inspection':value,'cc-status '+(value==='help'||value==='revoked'||value==='expired'||value==='rejected'?'red':value==='solved'||value==='active'||value==='confirmed'?'green':'yellow'));
const plans=[['1W','1 Week'],['1M','1 Month'],['1Y','1 Year'],['LT','Lifetime']];
function mount(root,api,{mobile=false,isActive=()=>root.isConnected,onExit=()=>{},pair=null,media=null}={}){
 root.classList.add('cc-root');root.replaceChildren();
 let revision=0,current='Overview',query='',cursor='',objectURL=null,closed=false,archiveTab='Reports',listView=false,listSignature='',pollingInbox=false;
 const header=el('header','','cc-header'),identity=el('div','','cc-identity'),brand=el('h1','qzu.'),server=el('p',location.origin,'cc-muted'),connection=el('span','Connecting…','cc-connection');
 brand.append(el('span',' Control','cc-accent'));identity.append(brand,server);header.append(identity,connection,button('Sign out',async()=>{stop();await api('logout',{}).catch(()=>{});onExit();},'cc-secondary'));
 const layout=el('div','','cc-layout'),nav=el('nav','','cc-nav'),main=el('section','','cc-content');main.setAttribute('aria-label','Control Center content');layout.append(nav,main);root.append(header,layout);
 const tabs=['Overview','Accounts','Keys','Payments','Payment tickets','Reports','Feedback','Support','Audit','Archive'];
 for(const tab of tabs){const b=button('',()=>navigate(tab),'cc-tab');b.dataset.tab=tab;b.append(el('span',tab),el('span','','cc-count'));nav.append(b);}
 const alive=token=>!closed&&isActive()&&token===revision;
 function stop(){closed=true;revision++;clearInterval(inboxTimer);if(objectURL)URL.revokeObjectURL(objectURL);root.replaceChildren();}
 function navigate(tab){current=tab;query='';cursor='';load();}
 function updateCount(tab,count){const n=[...nav.children].find(b=>b.dataset.tab===tab)?.lastElementChild;if(n){n.textContent=count>0?String(count):'';n.hidden=!count;}}
 async function pollInbox(){
  if(closed||!isActive()||document.hidden||pollingInbox)return;
  pollingInbox=true;
  try{
   const info=await api('inbox');if(closed)return;
   server.textContent=(info.environment==='production'?'Production':'Development')+' · '+location.host+' · v'+info.version+' · Admin '+info.adminId.slice(0,8);
   connection.textContent='Connected';connection.dataset.state='online';
   updateCount('Payment tickets',info.paymentTickets);updateCount('Support',info.supportRequests);
   if(listView&&['Payment tickets','Support'].includes(current)){
    const token=revision,tab=current,data=await api(tab==='Payment tickets'?'payment-tickets':'support');
    if(alive(token)&&listView&&tab===current&&JSON.stringify(data)!==listSignature&&!main.querySelector('textarea:focus, input:focus, button:disabled')&&![...main.querySelectorAll('textarea')].some(n=>n.value.trim()))load(data);
   }
  }catch(e){if(!closed){connection.textContent='Connection unavailable';connection.dataset.state='offline';}}
  finally{pollingInbox=false;}
 }
 const inboxTimer=setInterval(pollInbox,5000);
 function archiveAction(category,id,restore=false){return action(restore?'Restore from archive':'Archive',async()=>{await api('archive',{category,id,restore});await load();},'cc-secondary');}
 function error(e){if(isActive())main.prepend(el('p',e?.message||'Request failed.','cc-error'));}
 function details(rows){const d=el('dl','','cc-details');for(const [k,v] of rows){d.append(el('dt',k),el('dd',String(v??'—')));}return d;}
 function card(title,children=[]){const n=el('article','','cc-card');n.append(el('h3',title),...children);return n;}
 function action(label,run,cls=''){return button(label,async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;try{await run();}catch(e){error(e);}finally{b.disabled=false;}},cls);}
 function secret(title,value){const box=card(title,[el('p','Save this secret privately. It is displayed only here.'),el('code',value,'cc-secret'),action('Copy',()=>navigator.clipboard.writeText(value))]);main.prepend(box);}
 function search(placeholder){const form=el('form','','cc-search'),field=input(placeholder);field.value=query;field.maxLength=128;const b=el('button','Search','cc-button');form.append(field,b);form.addEventListener('submit',e=>{e.preventDefault();query=field.value.trim();cursor='';load();});return form;}
 function confirmAction(title,fn,{plan=false}={}){
  const box=card(title);const reason=input('Reason (required)');reason.maxLength=500;const picker=select(plans);if(plan)box.append(picker);box.append(reason,action('Confirm',async()=>{if(!reason.value.trim())throw Error('Enter a reason.');await fn(reason.value.trim(),picker.value);await load();},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary'));main.prepend(box);
 }
 async function openPaymentTicket(id){
  listView=false;const token=++revision;main.replaceChildren(el('h2','Payment Ticket'),button('‹ Back',load,'cc-secondary'));
  const n=el('div','','cc-ticket'),summary=el('div','','cc-muted'),chat=el('div','','cc-snapshot cc-ticket-chat'),field=el('textarea'),feedback=el('p','','cc-muted');
  field.placeholder='Write a reply';field.maxLength=2000;let last='',busy=false,polling=false,pending=null,mutation=0;
  const actions=el('div','','cc-actions');
  const send=action('Send reply',async()=>{if(busy||!field.value.trim())return;const text=field.value.trim(),requestId=pending?.text===text?pending.requestId:crypto.randomUUID();pending={text,requestId};busy=true;mutation++;try{const t=await api('payment-tickets/send',{id,text,requestId});if(alive(token)){field.value='';pending=null;render(t);}}finally{busy=false;}});
  const verify=action('Verify transaction',async()=>{if(busy)return;busy=true;mutation++;try{render(await api('payment-tickets/verify',{id}));}finally{busy=false;}});
  const release=action('Release verified key',async()=>{if(busy)return;busy=true;mutation++;try{render(await api('payment-tickets/release',{id}));}finally{busy=false;}});
  const close=action('Close ticket',async()=>{if(busy)return;busy=true;mutation++;try{render(await api('payment-tickets/close',{id}));}finally{busy=false;}},'cc-secondary');
  const review=action('Start review',async()=>{if(busy)return;busy=true;mutation++;try{render(await api('payment-tickets/review',{id}));}finally{busy=false;}},'cc-secondary');
  const reject=button('Reject ticket',()=>{const box=card('Reject ticket',[el('p','This closes the chat, not the payment order. A customer can open another ticket.')]);const reason=el('textarea');reason.placeholder='Reason for rejection';reason.maxLength=500;box.append(reason,action('Confirm rejection',async()=>{if(busy||!reason.value.trim())return;busy=true;mutation++;try{render(await api('payment-tickets/reject',{id,reason:reason.value.trim()}));box.remove();}finally{busy=false;}},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary'));n.append(box);},'cc-danger');
  actions.append(review,verify,release,reject,close);n.append(summary,chat,feedback,field,send,actions);main.append(n);
  function render(t){
   if(!alive(token))return;summary.textContent=t.plan+' · $'+t.usd+' · '+t.coin+' · '+t.amount+' '+t.coin+' · '+t.state+(t.txid?' · '+t.txid:'');
   const fp=JSON.stringify([t.messages.map(m=>m.id),t.state,t.released,t.redeemed,t.closed,t.confirmations,t.txid,t.status,t.reason]);
   if(fp!==last){last=fp;const bottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<80,top=chat.scrollTop;chat.replaceChildren();for(const m of t.messages){const b=el('div','','cc-bubble '+(m.actor==='customer'?'other':'mine'));b.append(el('small',(m.actor==='customer'?'Customer':'Support · '+m.actor.slice(0,8))+' · '+date(m.at)));if(m.text)b.append(el('p',m.text));if(m.hasProof)b.append(action('View proof',async()=>{const data=await api('payment-tickets/proof',{id,message:m.id});if(alive(token)&&b.isConnected){const image=el('img');image.src='data:image/png;base64,'+data.data;image.alt='Submitted payment proof';image.className='cc-evidence';b.append(image);}}));chat.append(b);}if(t.released)chat.append(el('p','Verified key delivered to customer.','cc-muted'));if(t.reason)chat.append(el('p','Rejected: '+t.reason,'cc-error'));chat.scrollTop=bottom?chat.scrollHeight:top;}
   review.hidden=t.closed||t.status==='review';reject.hidden=t.closed||t.state==='confirmed'||t.confirmations>0;verify.hidden=t.closed||t.state!=='submitted';release.hidden=t.closed||t.released||t.state!=='confirmed';close.hidden=t.closed||!t.released;field.disabled=t.closed;send.hidden=t.closed;feedback.textContent=t.closed?'This ticket is closed.':t.status==='review'?'Under review': 'Open ticket';
  }
  async function poll(){if(!alive(token)||polling)return;polling=true;try{if(!busy){const observed=mutation,t=await api('payment-tickets/state',{id});if(alive(token)&&!busy&&observed===mutation)render(t);}}catch(e){if(alive(token)){if(e.message==='Ticket unavailable.'){revision++;main.replaceChildren(el('h2','Ticket unavailable'),button('Back to tickets',load,'cc-secondary'));}else feedback.textContent=e.message;}}finally{polling=false;if(alive(token))setTimeout(poll,5000);}}
  poll();
 }
 async function load(prefetched=null){
  listView=false;const token=++revision;if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
  for(const b of nav.children){b.classList.toggle('selected',b.dataset.tab===current);b.setAttribute('aria-current',b.dataset.tab===current?'page':'false');}
  main.replaceChildren(el('h2',current),el('p','Loading…','cc-muted'));
  try{
   const archived=current==='Archive',view=archived?archiveTab:current;
   const route=view==='Payment tickets'?'payment-tickets':view.toLowerCase();
   const url=route+(archived?'?archived=1':['Accounts','Keys'].includes(view)?'?q='+encodeURIComponent(query)+(cursor?'&after='+encodeURIComponent(cursor):''):'');
   const data=await (prefetched&&typeof prefetched==='object'&&('items' in prefetched||'requests' in prefetched)?prefetched:api(url));if(!alive(token))return;listSignature=JSON.stringify(data);main.replaceChildren(el('h2',current),button('Refresh',()=>load(),'cc-secondary'));
   if(archived){const sub=el('div','','cc-actions cc-archive-tabs');for(const name of ['Reports','Feedback','Payment tickets','Payments','Support'])sub.append(button(name,()=>{archiveTab=name;load();},name===archiveTab?'':'cc-secondary'));main.append(sub,el('p','Finished records only. Restoring returns them to the working list. Existing privacy retention still applies.','cc-muted'));}
   if(view==='Overview'){
    const metrics=el('div','','cc-metrics');for(const [label,val] of [['Accounts',data.accounts],['Active',data.active],['Admin accounts',data.admins],['Unused keys',data.keys],['Open reports',data.reports],['Open feedback',data.feedback],['Pending payments',data.payments],['Open payment tickets',data.paymentTickets],['Assigned support requests',data.supportRequests],['Verified revenue','$'+(data.revenue/100).toFixed(2)]]){const n=el('div','','cc-metric');n.append(el('strong',String(val)),el('span',label));metrics.append(n);}main.append(metrics,card('Inbox shortcuts',[button('Open payment tickets',()=>navigate('Payment tickets')),button('Support requests',()=>navigate('Support'),'cc-secondary')]));
    if(pair)main.append(card('Desktop pairing',[el('p','Link a browser with a one-time code. Your admin PIN is required.'),button('Pair desktop',pair),action('Sign out all linked browsers',async()=>{await api('logout',{});main.prepend(el('p','Desktop sessions revoked.','cc-muted'));},'cc-secondary')]));
    main.append(card('Privacy boundary',[el('p','Only explicitly submitted report snapshots are available. Private encrypted conversations and consumed View Once content cannot be recovered.')]));
   }else if(view==='Accounts'){
    main.append(search('Account ID, key ID or fingerprint'));
    for(const a of data.items){const state=a.suspended?'suspended':a.access_revoked?'revoked':a.access.active?'active':'expired';const n=card(a.id,[status(state),details([['Plan',a.access_plan],['Expires',date(a.paid_until)],['Key ID',a.key_id],['Last activity',date(a.last_activity)],['Reports',a.reports],['Recovery configured',a.recovery_created?'Yes':'No']])]);
     if(a.access_plan!=='admin'){const actions=el('div','','cc-actions');if(!a.access_revoked&&!['lifetime','legacy'].includes(a.access_plan))actions.append(button('Extend access',()=>confirmAction('Extend '+a.id,(reason,plan)=>api('accounts/action',{id:a.id,action:'extend',reason,plan}),{plan:true})));actions.append(button(a.access_revoked?'Restore access':'Revoke access',()=>confirmAction((a.access_revoked?'Restore ':'Revoke ')+a.id,reason=>api('accounts/action',{id:a.id,action:a.access_revoked?'restore':'revoke',reason})),'cc-secondary'));n.append(actions);}
     main.append(n);
    }
    if(data.items.length===100)main.append(button('Next page',()=>{cursor=data.items.at(-1).id;load();}));if(!data.items.length)main.append(el('p','No matching accounts.'));
   }else if(view==='Keys'){
    main.append(search('Key ID, fingerprint or account ID'));const picker=select(plans),count=input('Quantity (1–100)','number');count.min='1';count.max='100';count.value='1';
    main.append(card('Generate access keys',[picker,count,action('Generate',async()=>{const result=await api('keys/generate',{plan:picker.value,count:Number(count.value)});await load();secret('New access keys',result.keys.map(k=>k.key+' · '+k.id).join('\n'));})]));
    for(const k of data.items){const state=k.state==='revoked'?'revoked':k.redeemed?'redeemed':'unused';const n=card(k.fingerprint?'QZU-••••-'+k.fingerprint:k.id,[status(state),details([['ID',k.id],['Plan',k.plan],['Created',date(k.created)],['Activated',date(k.redeemed)],['Account',k.account]])]);
     if(!k.redeemed&&k.generated&&k.state==='confirmed'){n.append(button('Replace unused key',()=>{const box=card('Replace key?',[el('p','The previous secret will stop working.'),action('Replace',async()=>{const result=await api('keys/replace',{id:k.id});await load();secret('Replacement key',result.key);},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary')]);main.prepend(box);}),button('Revoke',()=>confirmAction('Revoke unused key',reason=>api('keys/revoke',{id:k.id,reason})),'cc-secondary'));}
     main.append(n);
    }
   }else if(view==='Payments'){
    for(const p of data.items){const n=card(p.id,[status(p.state),details([['Plan',p.plan],['Network',p.coin||'LTC (legacy)'],['Price',p.usd_cents==null?'€'+(p.eur_cents/100).toFixed(2):'$'+(p.usd_cents/100).toFixed(2)],['Transaction',p.txid],['Confirmations',p.confirmations],['Verified',date(p.verified_at)],['Account',p.redeemed_account]])]);if(archived||p.state==='rejected'||(p.state==='confirmed'&&p.redeemed))n.append(archiveAction('payments',p.id,archived));main.append(n);}
   }else if(view==='Payment tickets'){
    const open=data.items.filter(t=>!['completed','rejected'].includes(t.status)),done=data.items.filter(t=>['completed','rejected'].includes(t.status));
    for(const [title,items] of [['Open Tickets',open],['Completed Tickets',done]]){
     const group=el('section','','cc-ticket-group');group.append(el('h3',title+' · '+items.length));if(!items.length)group.append(el('p','No tickets.','cc-muted'));
     for(const t of items){const label=t.status==='review'?'Under review':t.status==='completed'?'Completed':t.status==='rejected'?'Rejected':'Open';const badge=el('span',label,'cc-status '+(t.status==='completed'?'green':t.status==='rejected'?'red':t.status==='review'?'yellow':'neutral'));const n=card('Ticket · '+t.id.slice(0,8),[badge,details([['Plan',t.plan],['Total','$'+(t.usd_cents/100).toFixed(2)+' · '+t.coin],['Opened',date(t.created)],['Payment',t.state],['Updated',date(t.updated)]]),button('Open chat',()=>openPaymentTicket(t.id))]);if(t.status==='rejected')n.append(el('p','Hidden from dashboard 12h after rejection.','cc-muted'));if(['completed','rejected'].includes(t.status))n.append(archiveAction('payment-tickets',t.id,archived));group.append(n);}main.append(group);
    }
    listView=!archived;
   }else if(view==='Reports'){
    for(const r of data.items){const n=card(r.reason,[status(r.resolved?'solved':r.workflow||'inspection'),details([['Report',r.id],['Reported account',r.target],['Reporter',r.reporter],['Received',date(r.created)],['Previous reports',r.previousReports]]),el('p',r.evidence||'No additional details')]);
     const snap=el('div','','cc-snapshot');for(const m of r.context||[]){const bubble=el('div','','cc-bubble '+(m.sender==='Reporter'?'mine':'other')+(m.reported?' flagged':''));bubble.append(el('small',m.sender+' · '+date(m.at)),el('p',m.text),el('small',m.source==='reporter-submitted'?'Reporter-submitted':'Server-confirmed'));snap.append(bubble);}n.append(snap);
     if(r.attachment&&media)n.append(action('View submitted attachment',async()=>{const blob=await media(r.id);if(!alive(token))return;if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(blob);const node=el(r.attachment.kind==='image'?'img':'audio');node.src=objectURL;node.className='cc-evidence';if(node.tagName==='AUDIO')node.controls=true;else node.alt='Submitted report evidence';n.append(node);}));
     for(const event of r.collaboration||[])n.append(el('p','Admin '+(event.actor||'Deleted')+' · '+event.status+' · '+event.note,'cc-muted'));
     if(!r.resolved){const note=el('textarea');note.placeholder='Internal note';note.maxLength=1000;n.append(note,action('Under Inspection',async()=>{await api('reports/collaborate',{id:r.id,status:'inspection',note:note.value});await load();}),action('Need Additional Help',async()=>{await api('reports/collaborate',{id:r.id,status:'help',note:note.value});await load();},'cc-danger'));
      const choice=select([['dismiss','Mark solved / dismiss'],['warn','Warn account'],['restrict','Restrict 24h'],['suspend24h','Suspend 24h'],['suspend7d','Suspend 7 days'],['suspend','Suspend permanently']]);n.append(choice,button('Resolve report',()=>{const box=card('Confirm moderation action',[el('p',choice.options[choice.selectedIndex].textContent),action('Confirm',async()=>{await api('reports/resolve',{id:r.id,action:choice.value,notes:note.value});await load();},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary')]);n.append(box);}));}
     if(r.resolved)n.append(archiveAction('reports',r.id,archived));main.append(n);
    }
   }else if(view==='Feedback'){
    for(const f of data.items){const note=el('textarea');note.placeholder='Internal support note';note.maxLength=1000;const n=card('Feedback #'+f.id,[status(f.workflow||'inspection'),el('p',date(f.at),'cc-muted'),el('p',f.text)]);for(const e of f.events||[])n.append(el('p','Admin '+(e.actor||'Deleted')+' · '+e.status+' · '+e.note,'cc-muted'));if(!archived&&f.workflow!=='solved'){n.append(note);for(const [value,label] of [['inspection','Under Inspection'],['help','Need Additional Help'],['solved','Solved']])n.append(action(label,async()=>{await api('feedback/status',{id:f.id,status:value,note:note.value});await load();},value==='help'?'cc-danger':''));}if(f.workflow==='solved')n.append(archiveAction('feedback',f.id,archived));main.append(n);}
   }else if(view==='Support'){
    main.append(el('p','Assigned support requests and conversations. Payment questions are in Payment tickets. Private user-to-user chats are never listed.','cc-muted'),button('Go to payment tickets',()=>navigate('Payment tickets'),'cc-secondary'));
    for(const r of data.requests||[])main.append(card('Pending request '+r.id,[el('p',r.preview||'New request'),el('p',date(r.at),'cc-muted'),action('Accept',async()=>{await api('support/respond',{id:r.id,action:'accept'});await load();}),action('Reject',async()=>{await api('support/respond',{id:r.id,action:'reject'});await load();},'cc-secondary')]));
    for(const r of data.rooms||[]){const n=card('Support '+r.id,[details([['Expires',date(r.expires)],['Deletion requested',r.deletionRequested?'Yes':'No']])]);const snap=el('div','','cc-snapshot');for(const m of r.messages){const bubble=el('div','','cc-bubble '+(m.mine?'mine':'other'));bubble.append(el('small',m.sender+' · '+date(m.at)),el('p',m.text));snap.append(bubble);}const reply=el('textarea');reply.placeholder='Write support reply';reply.maxLength=2000;n.append(snap,reply,action('Send reply',async()=>{if(!reply.value.trim())throw Error('Enter a reply.');await api('support/send',{id:r.id,text:reply.value});await load();}),action('Mark solved',async()=>{await api('support/finish',{id:r.id,action:'solve'});await load();},'cc-secondary'));main.append(n);}
    for(const r of data.finished||[])main.append(card('Support '+r.id,[status(r.status),el('p',date(r.at),'cc-muted'),archiveAction('support',r.id,archived)]));if(!(data.requests||[]).length&&!(data.rooms||[]).length&&!(data.finished||[]).length)main.append(el('p','No assigned support cases on this server.','cc-muted'));listView=!archived;
   }else if(view==='Audit'){
    for(const a of data.items)main.append(card(a.action,[details([['Actor',a.actor],['Account',a.account],['Key',a.key_id],['At',date(a.at)],['Reason',a.reason]])]));
   }
   if(Array.isArray(data.items)&&!data.items.length&&!['Accounts','Keys'].includes(current))main.append(el('p','No records yet.','cc-muted'));
  }catch(e){if(alive(token)){main.replaceChildren(el('h2',current),el('p',e.message||'Request failed.','cc-error'),button('Retry',load));}}
 }
 load();pollInbox();
 return {close:stop};
}
window.QzuControl={mount};
const desktop=document.getElementById('controlRoot');if(!desktop)return;
async function api(path,data){
 const response=await fetch('/api/control/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-QZU':'1'},body:data===undefined?undefined:JSON.stringify(data),credentials:'same-origin',cache:'no-store'});
 const value=await response.json().catch(()=>({}));if(!response.ok)throw Error(value.error||'Request failed.');return value;
}
async function media(id){const r=await fetch('/api/control/reports/media/'+encodeURIComponent(id),{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw Error('Evidence unavailable.');return r.blob();}
function login(){
 desktop.className='cc-root';desktop.replaceChildren();
 const form=el('form','','cc-pair'),field=input('Admin key','password'),pin=input('Admin PIN (if already registered)','password');
 field.maxLength=58;field.required=true;pin.maxLength=6;pin.inputMode='numeric';
 const message=el('p','Sign in with your QZU-ADMIN key. If the key is registered on a phone, enter its existing login PIN.','cc-muted');
 const submit=el('button','Sign in securely','cc-button');form.append(el('h1','qzu. Control'),message,field,pin,submit);desktop.append(form);
 form.addEventListener('submit',async e=>{e.preventDefault();submit.disabled=true;try{await api('login',{key:field.value.trim().toUpperCase(),pin:pin.value});field.value='';pin.value='';mount(desktop,api,{onExit:login,media});}catch(e){message.textContent=e.message;pin.value='';}finally{submit.disabled=false;}});
}
if(/Macintosh/i.test(navigator.userAgent)&&navigator.maxTouchPoints>1){desktop.replaceChildren(el('h1','Desktop only'),el('p','Open qzu. Control on a Windows or Mac computer.'));}else api('overview').then(()=>mount(desktop,api,{onExit:login,media})).catch(login);
})();
