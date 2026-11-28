'use strict';
(()=>{
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const button=(label,fn,cls='')=>{const b=el('button',label,'cc-button '+cls);b.type='button';b.addEventListener('click',fn);return b;};
const date=x=>x?new Date(x).toLocaleString():'—';
const input=(placeholder,type='text')=>{const n=el('input');n.type=type;n.placeholder=placeholder;n.setAttribute('aria-label',placeholder);n.autocomplete='off';return n;};
const select=(options)=>{const n=el('select');for(const [value,label] of options){const o=el('option',label);o.value=value;n.append(o);}return n;};
const statusLabels={help:'Needs help',inspection:'In review',review:'In review',solved:'Resolved',closed:'Closed',active:'Active',confirmed:'Verified',completed:'Completed',accepted:'Accepted',submitted:'Submitted',pending:'Pending',unassigned:'Unassigned',assigned:'Assigned',open:'Open',expired:'Expired',rejected:'Rejected',suspended:'Suspended',revoked:'Revoked',retired:'Retired',success:'Success',unused:'Unused',redeemed:'Redeemed'};
const status=(value)=>el('span',statusLabels[value]||String(value??'Unknown'), 'cc-status '+(['help','expired','rejected','suspended','revoked'].includes(value)?'red':['solved','active','confirmed','accepted','success','completed','redeemed'].includes(value)?'green':['pending','inspection','review','submitted','unassigned','unused'].includes(value)?'yellow':'neutral'));
const caseNames={report:'Report',support:'Support',ticket:'User ticket','payment-ticket':'Payment ticket'};
const caseRoute=(type,id)=>'cases/'+encodeURIComponent(type)+'/'+encodeURIComponent(id);
const plans=[['1W','1 Week'],['1M','1 Month'],['1Y','1 Year'],['LT','Lifetime']];
const planName=value=>({week:'1 week',month:'1 month',year:'1 year',lifetime:'Lifetime',legacy:'Legacy',seller:'Seller',admin:'Administrator',support:'Support'})[value]||value||'—';
const number=new Intl.NumberFormat();
const currency=(cents,code)=>Number.isFinite(cents)?new Intl.NumberFormat(undefined,{style:'currency',currency:code}).format(cents/100):'—';
const keyState=key=>key.state==='revoked'?'revoked':key.redeemed?'redeemed':'unused';
const evidenceSource=source=>({'reporter-submitted':'Reporter submitted','server-confirmed':'Server confirmed','server-stored':'Server stored'})[source]||'Source unavailable';
const chatTypeLabel=value=>({direct:'Direct chat','encrypted direct':'Encrypted direct chat',group:'Group chat',support:'Support chat',room:'Room',world:'World chat',public:'Public chat',unknown:'Type unavailable'})[value]||'Type unavailable';
const platformName=value=>({ios:'iOS',android:'Android',web:'Web',desktop:'Desktop'})[value]||value;
const deviceName=device=>device?.model||platformName(device?.platform)||'Unavailable';
const sections=[
 ['Workspace',['Overview','Chats','Announcements']],
 ['Inbox',['Tickets','Support','Payment tickets','Reports','Shop reviews','Feedback']],
 ['Management',['Accounts','Keys','Sellers','Groups','Payments']],
 ['Operations',['Monitoring','Audit','Archive']]
];
function mount(root,api,{mobile=false,isActive=()=>root.isConnected,onExit=()=>{},media=null,mobileChat=null,initialTab=null}={}){
 root.classList.add('cc-root');root.replaceChildren();
 const groupFor=tab=>sections.find(([,tabs])=>tabs.includes(tab))?.[0];
 let revision=0,current=groupFor(initialTab)?initialTab:location.pathname==='/control/monitoring'?'Monitoring':'Overview';
 let query='',scope='all',cursor='',keyPages=[],auditType='',auditOutcome='',objectURL=null,closed=false,archiveTab='Reports',listView=false,listSignature='',pollingInbox=false,updateOverview=null,concealKey=null;
 const header=el('header','','cc-header'),identity=el('div','','cc-identity'),brand=el('h1','qzu.'),server=el('p',location.origin,'cc-muted'),connection=el('span','Connecting…','cc-connection');
 brand.append(el('span',' Control','cc-accent'));identity.append(brand,server);
 const adminAvatar=el('span','','cc-chat-avatar cc-chat-admin-avatar');
 adminAvatar.setAttribute('aria-hidden','true');
 const logo=el('div','','cc-brand-lockup'),session=el('div','','cc-session-actions');
 logo.append(adminAvatar,identity);
 connection.setAttribute('role','status');
 session.append(connection,button(mobile?'Close':'Sign out',async()=>{stop();if(!mobile)await api('logout',{}).catch(()=>{});onExit();},'cc-secondary'));
 header.append(logo,session);
 const layout=el('div','','cc-layout'),nav=el('nav','','cc-nav'),main=el('section','','cc-content');
 nav.setAttribute('aria-label','Control Center sections');main.setAttribute('aria-label','Control Center content');
 layout.append(nav,main);root.append(header,layout);
 const groups=new Map(),tabs=new Map(),sectionPicker=select(sections.map(([label])=>[label,label]));
 sectionPicker.className='cc-section-picker';
 sectionPicker.setAttribute('aria-label','Control Center section');
 sectionPicker.addEventListener('change',()=>navigate(sections.find(([label])=>label===sectionPicker.value)[1][0]));
 nav.append(sectionPicker);
 for(const [label,names] of sections){
  const group=el('div','','cc-nav-group');
  group.setAttribute('role','group');
  group.setAttribute('aria-label',label);
  group.append(el('span',label,'cc-nav-heading'));
  for(const name of names){
   const control=button('',()=>navigate(name),'cc-tab');
   control.append(el('span',name),el('span','','cc-count'));
   tabs.set(name,control);group.append(control);
  }
  groups.set(label,group);nav.append(group);
 }
 const lookup=el('form','','cc-quick-lookup'),lookupField=input('Find an account or reference'),lookupButton=el('button','Find account','cc-button cc-secondary');
 lookup.setAttribute('role','search');lookupField.maxLength=128;lookupField.required=true;
 lookup.append(lookupField,lookupButton);
 lookup.addEventListener('submit',e=>{e.preventDefault();const value=lookupField.value.trim();if(value)navigate('Accounts','all',value);});
 header.insertBefore(lookup,session);
 const alive=token=>!closed&&isActive()&&token===revision;
 function clearKeySecret(){concealKey?.();concealKey=null;}
 const hideKeyWhenAway=()=>{if(document.hidden)concealKey?.();};
 const hideKeyOnPageExit=()=>concealKey?.();
 document.addEventListener('visibilitychange',hideKeyWhenAway);
 window.addEventListener('pagehide',hideKeyOnPageExit);
 function stop(){closed=true;revision++;clearInterval(inboxTimer);clearKeySecret();document.removeEventListener('visibilitychange',hideKeyWhenAway);window.removeEventListener('pagehide',hideKeyOnPageExit);if(objectURL)URL.revokeObjectURL(objectURL);root.replaceChildren();}
 function navigate(tab,nextScope='all',nextQuery=''){if(mobile&&tab==='Chats'&&mobileChat){stop();mobileChat();return;}current=tab;query=nextQuery;cursor='';keyPages=[];scope=nextScope;if(tab!=='Accounts')lookupField.value='';if(!mobile&&location.pathname==='/control/monitoring'&&tab!=='Monitoring')history.replaceState(null,'','/control');else if(!mobile&&tab==='Monitoring')history.replaceState(null,'','/control/monitoring');load();}
 function updateCount(tab,count){const n=tabs.get(tab).lastElementChild;n.textContent=count>0?String(count):'';n.hidden=!count;}
 function routeFor(view,archived=false){
  const route=view==='Payment tickets'?'payment-tickets':view==='Shop reviews'?'shop-reviews':view.toLowerCase();
  if(archived)return route+'?archived=1';
  if(['Tickets','Payments'].includes(view))return route+'?scope='+encodeURIComponent(scope);
  if(!['Accounts','Keys','Audit'].includes(view))return route;
  const filters=new URLSearchParams({q:query});
  if(cursor)filters.set(view==='Audit'?'before':'after',cursor);
  if(view==='Keys')filters.set('scope',scope);
  if(view==='Audit'){
   if(auditType)filters.set('type',auditType);
   if(auditOutcome)filters.set('outcome',auditOutcome);
  }
  return route+'?'+filters;
 }
 async function pollInbox(){
  if(closed||!isActive()||document.hidden||pollingInbox)return;
  pollingInbox=true;
  try{
   const info=await api('inbox');if(closed)return;
   server.textContent=(info.environment==='production'?'Production':'Development')+' · '+(mobile?'Mobile':location.host)+' · v'+info.version+' · Admin '+info.adminId.slice(0,8);
   connection.textContent='Connected';connection.dataset.state='online';
   const work=info.work||{};
   updateCount('Payment tickets',work.paymentTickets??info.paymentTickets);
   updateCount('Support',info.supportRequests);
   updateCount('Tickets',work.claimableTickets??info.userTickets);
   updateCount('Reports',work.reports);
   updateCount('Shop reviews',work.shopReviews);
   updateCount('Feedback',work.feedback);
   updateOverview?.(work);
   if(listView){
    const token=revision,data=await api(routeFor(current));
    if(alive(token)&&listView&&JSON.stringify(data)!==listSignature&&!main.contains(document.activeElement)&&!root.querySelector('dialog[open]'))load(data);
   }
  }catch(e){if(!closed){if(e.status===401){stop();onExit();return;}connection.textContent='Connection unavailable';connection.dataset.state='offline';}}
  finally{pollingInbox=false;}
 }
 const inboxTimer=setInterval(pollInbox,5000);
 function archiveAction(category,id,restore=false){return action(restore?'Restore from archive':'Archive',async()=>{await api('archive',{category,id,restore});await load();},'cc-secondary');}
 const toastHost=el('div','','cc-toast-host');toastHost.setAttribute('aria-live','polite');root.append(toastHost);
 const recentNotices=new Map();
 function toast(message,kind='error'){if(closed||!isActive())return;const key=kind+':'+message,t=Date.now();for(const [k,v] of recentNotices)if(t-v>=5000)recentNotices.delete(k);if(recentNotices.has(key))return;recentNotices.set(key,t);const n=el('div','','cc-toast '+kind);n.append(el('span',message),button('Dismiss',()=>n.remove(),'cc-secondary'));toastHost.append(n);while(toastHost.children.length>3)toastHost.firstElementChild.remove();setTimeout(()=>n.remove(),5000);}
 function error(e){toast(e?.message||'Request failed.');}
 function modalConfirm(message){return new Promise(resolve=>{const d=el('dialog','','cc-modal');const finish=v=>{d.close();d.remove();resolve(v);};d.append(el('h3','Confirm action'),el('p',message),button('Cancel',()=>finish(false),'cc-secondary'),button('Confirm',()=>finish(true),'cc-danger'));d.addEventListener('cancel',e=>{e.preventDefault();finish(false);});root.append(d);d.showModal();});}
 function details(rows,cls=''){const d=el('dl','','cc-details '+cls);for(const [k,v] of rows){const value=el('dd');if(v instanceof Node)value.append(v);else value.textContent=String(v??'—');d.append(el('dt',k),value);}return d;}
 function card(title,children=[]){const n=el('article','','cc-card');n.append(el('h3',title),...children);return n;}
 function action(label,run,cls=''){return button(label,async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;try{await run();}catch(e){error(e);}finally{if(b.dataset.locked!=='1')b.disabled=false;}},cls);}
 function secret(title,keys){
  const dialog=el('dialog','','cc-modal cc-key-secrets'),heading=el('h3',title),list=el('ul','','cc-key-secret-list');
  dialog.setAttribute('aria-label',title);
  for(const key of keys){
   const item=el('li');
   item.append(el('code',key.key,'cc-secret'),el('small','Key ID '+key.id,'cc-muted'));
   list.append(item);
  }
  const actions=el('div','','cc-actions');
  actions.append(action(keys.length===1?'Copy key':'Copy all keys',async()=>{
   await navigator.clipboard.writeText(keys.map(key=>key.key).join('\n'));
   toast(keys.length===1?'Key copied':'Keys copied','success');
  }),button('Done',()=>dialog.close(),'cc-secondary'));
  dialog.append(heading,el('p','Share activation keys privately.','cc-muted'),list,actions);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  root.append(dialog);dialog.showModal();
 }
 function search(placeholder){const form=el('form','','cc-search'),field=input(placeholder);field.value=query;field.maxLength=128;const b=el('button','Search','cc-button cc-secondary');form.setAttribute('role','search');form.append(field,b);form.addEventListener('submit',e=>{e.preventDefault();query=field.value.trim();cursor='';keyPages=[];load();});return form;}
 function confirmReason(title,description,run){
  const dialog=el('dialog','','cc-modal'),reason=input('Reason (required)'),actions=el('div','','cc-actions');
  dialog.setAttribute('aria-label',title);
  reason.maxLength=500;
  const confirm=action(title,async()=>{
   if(!reason.value.trim())throw Error('Enter a reason.');
   await run(reason.value.trim(),()=>dialog.close());
  },'cc-danger');
  const cancel=button('Cancel',()=>{if(!confirm.disabled)dialog.close();},'cc-secondary');
  actions.append(cancel,confirm);
  dialog.append(el('h3',title),el('p',description,'cc-muted'),reason,actions);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.addEventListener('cancel',e=>{if(confirm.disabled)e.preventDefault();});
  root.append(dialog);dialog.showModal();reason.focus();
 }
 function displayAction(event){
  const names={
   'reports/resolve':'Resolved report','reports/collaborate':'Updated report review','reports/follow-up':'Requested evidence from reporter',
   'sellers/rename':'Changed seller display name','seller-rename':'Changed seller display name',
   'shop-reviews/review':'Reviewed shop listing','groups/join':'Joined group as staff','groups/send':'Sent group message',
   'support/respond':'Responded to support request','support/finish':'Updated support status',
   'support/send':'Replied to support case','support/delete':'Approved deletion',
   'tickets/action':'Updated ticket','tickets/send':'Replied to ticket',
   'payment-tickets/release':'Released access key','payment-tickets/verify':'Checked payment',
   'keys/reveal':'Revealed access key','keys/delete':'Deleted access key',
   'cases/claim':'Claimed case','cases/unassign':'Released assignment','cases/note':'Added an internal note',
   'accounts/device-alarm/review':'Reviewed a device change',
   note:'Added an internal note','accounts/view':'Viewed account','reports/evidence-view':'Viewed reported chat','reports/evidence-attachment':'Viewed report attachment'
  };
  const name=String(event.action||event.event||'Activity');
  const fallback=name.replace(/[-_/]+/g,' ');
  return names[name]||fallback.charAt(0).toUpperCase()+fallback.slice(1);
 }
 function recordId(id,label='ID'){
  const row=el('div','','cc-record-id');
  if(!id)return el('span','Unavailable','cc-muted');
  const code=el('code',id);
  row.append(code,action('Copy '+label,async()=>{
   try{
    await navigator.clipboard.writeText(id);
    toast(label+' copied','success');
   }catch{
    const selection=window.getSelection();
    const range=document.createRange();
    range.selectNodeContents(code);
    selection?.removeAllRanges();selection?.addRange(range);
    toast('Select Copy to keep this '+label.toLowerCase()+'.','info');
   }
  },'cc-secondary cc-compact-button'));
  return row;
 }
 function detailView(title,back=()=>load(),backLabel='Back'){
  listView=false;updateOverview=null;
  const token=++revision;
  clearKeySecret();
  if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
  const head=el('div','','cc-detail-header'),name=el('h2',title);
  name.tabIndex=-1;
  head.append(button(backLabel,back,'cc-secondary cc-compact-button'),name);
  main.replaceChildren(head);
  name.focus();
  return {token,name};
 }
 function editSellerName(seller,token){
  const title='Change seller display name',dialog=el('dialog','','cc-modal');
  const form=el('form','','cc-detail-primary'),field=input('Public display name');
  const hint=el('p','Use at least 4 letters. This name appears on the seller profile and in chats.','cc-muted');
  const issue=el('p','','cc-error'),actions=el('div','','cc-actions');
  const save=el('button','Save name','cc-button'),cancel=button('Cancel',()=>dialog.close(),'cc-secondary');
  dialog.setAttribute('aria-label',title);
  hint.id='cc-seller-name-hint';field.setAttribute('aria-describedby',hint.id);
  field.value=seller.name||'Seller';field.maxLength=40;field.required=true;
  issue.hidden=true;issue.setAttribute('role','alert');
  save.type='submit';
  form.addEventListener('submit',async e=>{
   e.preventDefault();
   if(save.disabled||!alive(token))return;
   const name=field.value;
   save.disabled=cancel.disabled=field.disabled=true;
   issue.hidden=true;
   try{
    await api('sellers/rename',{id:seller.account,name});
    dialog.close();
    toast('Seller display name updated','success');
    if(alive(token))await load();
   }catch(errorValue){
    if(dialog.open){
     issue.textContent=errorValue.message||'Unable to update the seller display name.';
     issue.hidden=false;
    }
   }finally{save.disabled=cancel.disabled=field.disabled=false;}
  });
  actions.append(cancel,save);form.append(field,issue,actions);
  dialog.append(el('h3',title),details([['Seller account',seller.account]]),hint,form);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.addEventListener('cancel',e=>{if(save.disabled)e.preventDefault();});
  root.append(dialog);dialog.showModal();field.select();
 }
 function splitDetail(content,sidebar){
  const layout=el('div','','cc-detail-layout'),primary=el('div','','cc-detail-primary');
  primary.append(...content);
  layout.append(primary,sidebar);
  return layout;
 }
 async function openGroup(group){
  const {token}=detailView(group.name);
  const transcript=el('div','','cc-chat'),composer=el('form','','cc-detail-primary');
  const text=el('textarea');text.setAttribute('aria-label','Group message');text.required=true;text.maxLength=2000;
  const send=el('button','Send message','cc-button');send.type='submit';
  let signature='';
  async function refresh(){
   const current=await api('groups/'+encodeURIComponent(group.id));
   if(!alive(token))return;
   const fingerprint=JSON.stringify(current.messages);
   if(signature===fingerprint)return;
   signature=fingerprint;
   transcript.replaceChildren(...current.messages.map(message=>{
    const row=el('div','','cc-bubble '+(message.mine?'mine':'other'));
    row.append(el('small',message.system?'Group activity':(message.sender||'Member')+' · '+date(message.at)),
      el('p',message.deleted?'Message deleted':message.kind==='text'?message.text:'Attachment'));
    return row;
   }));
  }
  composer.addEventListener('submit',async event=>{
   event.preventDefault();if(send.disabled||!text.value.trim())return;
   send.disabled=true;
   try{await api('groups/send',{id:group.id,text:text.value});text.value='';await refresh();}catch(e){error(e);}finally{send.disabled=false;}
  });
  composer.append(text,send);
  main.append(card('Group chat',[transcript,composer]));
  async function poll(){
   if(!alive(token))return;
   try{await refresh();}catch(e){if(alive(token)){if(e.status===404){transcript.textContent='Group unavailable.';composer.hidden=true;return;}error(e);}}
   if(alive(token))setTimeout(poll,4000);
  }
  void poll();
 }
 function renderGroupDirectory(data,token){
  const filter=input('Search by group name or ID'),list=el('div','','cc-detail-primary');
  function draw(){
   const q=filter.value.trim().toLowerCase();
   const items=data.items.filter(group=>group.name.toLowerCase().includes(q)||group.id.includes(q));
   list.replaceChildren(...items.map(group=>{
    const row=card(group.name,[details([['Group ID',group.id],['Owner account',group.owner],['Members',group.memberCount],
      ['Scheduled deletion',group.persistent?'Never':date(group.expires)]])]);
    if(group.joined)row.append(button('Open group',()=>openGroup(group),'cc-secondary'));
    else row.append(action('Join as staff',async()=>{
     if(!await modalConfirm('Join this group as qzu. Staff? Members will see the join notice.')||!alive(token))return;
     await api('groups/join',{id:group.id});
     if(alive(token))await openGroup(group);
    }));
    return row;
   }));
   if(!items.length)list.append(el('p','No groups found.','cc-muted'));
  }
  filter.addEventListener('input',draw);draw();
  main.append(filter,list);
 }
 function renderShopReviews(data,token){
  if(!data.items.length){main.append(el('p','No listings waiting for review.','cc-muted'));return;}
  for(const item of data.items){
   const row=card(item.name,[details([['Seller',item.seller],['Seller account',item.owner],['Quantity',item.quantity],
     ['Price per item',currency(item.priceMinor,item.currency)],['Fulfillment',item.fulfillment],['Submitted',date(item.submitted)]])]);
   const actions=el('div','','cc-actions');
   for(const [label,approve] of [['Publish listing',true],['Return to seller',false]]){
    actions.append(action(label,async()=>{
     if(!await modalConfirm(approve?'Approve this listing for the seller’s shop?':'Return this submission for edits?')||!alive(token))return;
     await api('shop-reviews/review',{id:item.id,approve});
     toast(approve?'Listing published':'Listing returned','success');
     if(alive(token))await load();
    },approve?'':'cc-secondary'));
   }
   row.append(actions);main.append(row);
  }
 }
 function timeline(entries,empty='No activity recorded.'){
  if(!entries?.length)return el('p',empty,'cc-muted');
  const list=el('ol','','cc-timeline');
  for(const event of entries){
   const row=el('li','','cc-timeline-event'),title=el('div','','cc-timeline-title');
   title.append(el('strong',displayAction(event)),el('time',date(event.at)));
   row.append(title);
   if(event.actor)row.append(el('small','Admin '+event.actor,'cc-muted'));
   if(event.detail)row.append(el('p',statusLabels[event.detail]||event.detail));
   if(event.note)row.append(el('p',event.note,'cc-case-note'));
   if(event.outcome==='rejected')row.append(status('rejected'));
   list.append(row);
  }
  return list;
 }
 function mountCaseActivity(type,id,token,{back=()=>load(),onChange=null,onState=null,initial=null}={}){
  const panel=el('aside','','cc-case-sidebar'),header=el('div','','cc-panel-heading'),body=el('div','','cc-case-activity'),feedback=el('p','Loading activity…','cc-muted');
  feedback.setAttribute('role','status');
  const reload=button('Refresh',()=>refresh(),'cc-secondary cc-compact-button');
  header.append(el('h3','Case activity'),reload);
  panel.append(header,recordId(id,'case ID'),feedback,body);
  let pending=false;
  async function refresh(){
   if(pending||!alive(token))return;
   pending=true;reload.disabled=true;
   try{
    const data=await api(caseRoute(type,id));
    if(alive(token))render(data);
   }catch(e){
    if(alive(token))feedback.textContent=e.message||'Activity unavailable.';
   }finally{pending=false;reload.disabled=false;}
  }
  function render(data,clearDraft=false){
   const previousField=body.querySelector('.cc-case-note-form textarea');
   const draft=clearDraft?'':previousField?.value||'';
   const hadFocus=previousField&&document.activeElement===previousField;
   feedback.textContent='';
   const facts=details([['Status',statusLabels[data.status]||data.status],['Assigned to',data.assignedToMe?'You':data.assignee||'Unassigned']]);
   body.replaceChildren(facts);
   const actions=el('div','','cc-actions');
   if(data.accountId&&type!=='report')actions.append(button('Open account',()=>openAccount(data.accountId,back),'cc-secondary'));
   if(data.canClaim)actions.append(action('Claim case',()=>change('claim')));
   if(data.canUnassign)actions.append(action('Release assignment',()=>change('unassign'),'cc-secondary'));
   if(actions.childElementCount)body.append(actions);
   if(data.canNote!==false){
    const field=el('textarea');
    field.maxLength=1000;field.placeholder='Add an internal note';field.setAttribute('aria-label','Internal case note');field.value=draft;
    const form=el('form','','cc-case-note-form');
    const submit=el('button','Save note','cc-button cc-secondary');
    field.required=true;
    form.append(field,submit);
    form.addEventListener('submit',async e=>{
     e.preventDefault();
     const note=field.value.trim();
     if(!note||submit.disabled)return;
     submit.disabled=true;
     try{await change('note',note);}catch(errorValue){error(errorValue);submit.disabled=false;}
    });
    body.append(form);
    if(hadFocus)field.focus({preventScroll:true});
   }
   const reviewNotes=(data.record?.collaboration||[]).filter(event=>event.note).map(event=>({...event,action:'Report review note',detail:event.status}));
   const events=[...(data.events||[]).filter(event=>event.action!=='cases/note'),...reviewNotes].sort((a,b)=>b.at-a.at);
   body.append(timeline(events));
   onState?.(data);
  }
  async function change(operation,note){
   const data=await api(caseRoute(type,id),{action:operation,note});
   if(!alive(token))return;
   render(data,operation==='note');
   toast(operation==='note'?'Note saved':operation==='claim'?'Case claimed':'Case returned to the queue','success');
   await onChange?.();
  }
  if(initial)render(initial);
  else void refresh();
  return {panel,refresh};
 }
 function accountState(account){return account.accessStatus||(account.suspended?'suspended':account.access_revoked?'revoked':account.access?.active?'active':'expired');}
 function deviceAlarmBadge(){return el('span','Alarm','cc-status red cc-device-alarm');}
 function accountBadges(account){
  const access=status(accountState(account));
  if(!account.deviceAlarm)return access;
  const badges=el('div','','cc-device-badges');
  badges.append(deviceAlarmBadge(),access);
  return badges;
 }
 function accountDevice(account){
  const device=account.device;
  const panel=card('Registered device');
  if(!device||!device.platform&&!device.fingerprint){
   panel.append(el('p','No device has been recorded for this account.','cc-muted'));
   return panel;
  }
  const facts=[['Platform',platformName(device.platform)],['Model',device.model]];
  if(device.modelIdentifier)facts.push(['Model identifier',device.modelIdentifier]);
  facts.push(['OS version',device.osVersion],['App version',device.appVersion]);
  if(device.registeredAt)facts.push(['First registered',date(device.registeredAt)]);
  else if(device.firstSeenAt)facts.push(['First observed',date(device.firstSeenAt)]);
  if(device.lastSignedInAt)facts.push(['Last successful sign-in',date(device.lastSignedInAt)]);
  if(!device.lastSignedInAt||device.lastSeenAt!==device.lastSignedInAt)facts.push(['Last device update',date(device.lastSeenAt)]);
  facts.push(['Details source',({'app-reported':'App-reported device details','signed-session':'Verified app signing key'})[device.source]]);
  panel.append(details(facts,'cc-detail-facts'));
  if(device.fingerprint){
   panel.append(el('h4','Qzu device fingerprint'),recordId(device.fingerprint,'fingerprint'),el('p','Identifies the app’s registered device.','cc-muted'));
  }
  return panel;
 }
 function deviceHistory(account,changes,token,reload){
  const panel=card('Device changes',[
   el('p','qzu. records verified changes to an account’s registered app key. Review the previous and new fingerprints here.','cc-muted')
  ]);
  for(const change of changes){
   const row=el('section','','cc-device-change');
   const heading=el('div','','cc-panel-heading cc-device-change-heading');
   heading.append(el('h4','Registered device changed'),change.reviewedAt?el('span','Reviewed','cc-status neutral'):deviceAlarmBadge());
   const facts=[['Changed',date(change.changedAt)]];
   if(change.previousDevice)facts.push(['Previous device',deviceName(change.previousDevice)]);
   if(change.reviewedAt)facts.push(['Reviewed',date(change.reviewedAt)]);
   row.append(heading,details(facts,'cc-detail-facts'),
    el('h4','Previous fingerprint'),recordId(change.previousFingerprint,'previous fingerprint'),
    el('h4','New fingerprint'),recordId(change.currentFingerprint,'new fingerprint'));
   if(!change.reviewedAt)row.append(action('Mark reviewed',async()=>{
    if(!alive(token))return;
    await api('accounts/device-alarm/review',{id:account.id,changeId:change.id});
    if(!alive(token))return;
    toast('Device change marked reviewed','success');
    await reload();
   },'cc-secondary cc-compact-button cc-fit'));
   panel.append(row);
  }
  return panel;
 }
 function accountActions(account,reload){
  const controls=el('div','','cc-actions');
  if(account.access_plan==='admin')return controls;
  const id=account.id;
  const extension=()=>editAccess('Extend access','extend',true);
  if(!account.access_revoked&&!['lifetime','legacy','seller'].includes(account.access_plan))controls.append(button('Extend access',extension));
  const state=account.access_revoked?'restore':'revoke';
  controls.append(button(state==='restore'?'Restore access':'Revoke access',()=>editAccess(state==='restore'?'Restore access':'Revoke access',state,false),'cc-secondary'));
  function editAccess(title,operation,needsPlan){
   const modal=el('dialog','','cc-modal');
   const reason=input('Reason for access change'),picker=select(plans);
   reason.maxLength=500;reason.required=true;picker.setAttribute('aria-label','Access plan');
   modal.append(el('h3',title),recordId(id,'account ID'),reason);
   if(needsPlan)modal.append(picker);
   modal.append(action('Confirm',async()=>{
    if(!reason.value.trim()){reason.reportValidity();throw Error('Enter a reason.');}
    await api('accounts/action',{id,action:operation,reason:reason.value.trim(),plan:needsPlan?picker.value:undefined});
    modal.close();toast('Account access updated','success');await reload();
   },'cc-danger'),button('Cancel',()=>modal.close(),'cc-secondary'));
   modal.addEventListener('close',()=>modal.remove(),{once:true});
   root.append(modal);modal.showModal();reason.focus();
  }
  return controls;
 }
 async function openAccount(id,back=()=>load()){
  if(!id)return;
  const {token}=detailView('Account details',back);
  const loading=el('p','Loading account…','cc-muted');
  main.append(loading);
  try{
   const {account,cases=[],activity=[],audit=[],deviceChanges=[]}=await api('accounts/'+encodeURIComponent(id));
   if(!alive(token))return;
   const summary=card('Account record');
   summary.classList.add('cc-record-panel');
   summary.firstElementChild.after(accountBadges(account));
   summary.append(recordId(account.id,'account ID'),details([
    ['Name',account.name],['Access plan',planName(account.access_plan)],['Access ends',date(account.paid_until)],
    ['Last activity',date(account.last_activity)],['Reports received',number.format(account.reports??0)]
   ],'cc-detail-facts'));
   const access=card('Access and restrictions',[details([
    ['Access registered',date(account.registeredAccessAt)],
    ['Messaging restriction',account.restricted_until?'Until '+date(account.restricted_until):'None'],
    ['Suspension',account.suspended?(account.suspended_until?'Until '+date(account.suspended_until):'Indefinite'):'None'],
    ['Recovery configured',account.recovery_created?'Yes':'No']
   ],'cc-detail-facts')]);
   if(account.key?.id||account.key_id){
    const keyId=account.key?.id||account.key_id;
    access.append(el('h4','Activation key ID'),recordId(keyId,'key ID'));
    if(account.key?.fingerprint)access.append(details([['Key fingerprint',account.key.fingerprint]],'cc-detail-facts'));
    access.append(button('Find activation key',()=>navigate('Keys','all',keyId),'cc-secondary cc-compact-button cc-fit'));
   }
   const controls=accountActions(account,()=>openAccount(id,back));
   if(controls.childElementCount)access.append(controls);
   const related=card('Related cases');
   if(!cases.length)related.append(el('p','No related cases.','cc-muted'));
   else{
    const heading=el('div','','cc-panel-heading');
    heading.append(related.firstElementChild,el('span',number.format(cases.length),'cc-queue-total'));
    related.prepend(heading);
   }
   for(const item of cases){
    const row=el('div','','cc-account-case');
    const name=el('div','','cc-account-case-label');
    name.append(el('strong',item.title||caseNames[item.type]||'Case'),el('small',(caseNames[item.type]||'Case')+' · '+date(item.at),'cc-muted'));
    row.append(name,status(item.status));
    if(item.canOpen!==false&&Object.hasOwn(caseNames,item.type))row.append(button('Open case',()=>openLinkedCase(item,()=>openAccount(id,back)),'cc-secondary cc-compact-button'));
    related.append(row);
   }
   const trail=el('aside','','cc-detail-primary');
   trail.append(card('Account activity',[timeline(activity)]),card('Administrative actions',[timeline(audit)]));
   loading.remove();
   const panels=[summary,accountDevice(account)];
   if(deviceChanges.length)panels.push(deviceHistory(account,deviceChanges,token,()=>openAccount(id,back)));
   main.append(splitDetail([...panels,access,related],trail));
  }catch(e){
   if(alive(token)){loading.textContent=e.message;main.append(button('Retry',()=>openAccount(id,back),'cc-secondary'));}
  }
 }
 function openLinkedCase(item,back){
  if(item.type==='report')return openReportCase(item.id,back);
  if(item.type==='support')return openSupportCase(item.id,Boolean(item.archived),back);
  if(item.type==='ticket')return openUserTicket(item.id,back);
  if(item.type==='payment-ticket')return openPaymentTicket(item.id,back);
 }
 function caseQueue(title,items,entry,empty='Nothing in this queue.'){
  const section=el('section','','cc-work-list'),head=el('div','','cc-panel-heading');
  head.append(el('h3',title),el('span',String(items.length),'cc-queue-total'));
  section.append(head);
  if(!items.length)section.append(el('p',empty,'cc-muted'));
  for(const item of items){
   const summary=entry(item),row=el('article','','cc-work-row'),description=el('div','','cc-work-description');
   description.append(el('h3',summary.title),el('p',summary.description,'cc-muted'));
   row.append(description,summary.status,button(summary.action||'Open case',summary.open,'cc-secondary cc-compact-button'));
   if(summary.extra)row.append(summary.extra);
   section.append(row);
  }
  return section;
 }
 function reportAccount(title,id,back,account,description){
  const panel=card(title,[recordId(id,'account ID')]);
  if(account?.deviceAlarm)panel.firstElementChild.after(deviceAlarmBadge());
  if(account)panel.append(details([
   ['Name',account.name],['Access',statusLabels[account.accessStatus]||account.accessStatus],['Plan',planName(account.plan)],
   ['Device',deviceName(account.device)],['OS version',account.device?.osVersion],['App version',account.device?.appVersion],
   ['Last device update',date(account.device?.lastSeenAt)]
  ],'cc-detail-facts'));
  if(account?.device?.fingerprint)panel.append(el('h4','Qzu device fingerprint'),recordId(account.device.fingerprint,'fingerprint'));
  if(description)panel.append(el('p',description,'cc-muted'));
  if(id)panel.append(button('Open '+title.toLowerCase(),()=>openAccount(id,back),'cc-secondary cc-compact-button cc-fit'));
  return panel;
 }
 async function openReportEvidence(id,back){
  const {token}=detailView('Reported chat',back,'Back to report');
  const loading=el('p','Loading submitted evidence…','cc-muted');
  loading.setAttribute('role','status');
  main.append(loading);
  try{
   const report=await api('reports/'+encodeURIComponent(id)+'/evidence');
   if(!alive(token))return;
   const messages=[...(report.context||[])].sort((a,b)=>a.at-b.at);
   const stream=card('Submitted messages');
   if(messages.length){
    const snapshot=el('ol','','cc-report-stream');
    for(const message of messages){
     const flagged=message.reported||Boolean(report.messageId&&message.id===report.messageId);
     const bubble=el('li','','cc-report-message'+(flagged?' cc-report-message-flagged':''));
     const head=el('div','','cc-report-message-head');
     head.append(el('strong',message.sender||'Participant'),el('time',date(message.at),'cc-muted'));
     if(flagged)head.append(el('span','Reported message','cc-status red'));
     bubble.append(head,el('p',message.text,'cc-case-note'),el('small',evidenceSource(message.source),'cc-muted'));
     snapshot.append(bubble);
    }
    stream.append(snapshot);
   }else stream.append(el('p','The report contains no submitted text messages.','cc-muted'));
   const summary=card('Snapshot details',[
    el('p','Messages and attachments saved with this report.','cc-muted'),
    details([['Submitted',date(report.created)],['Chat type',chatTypeLabel(report.chatType)],['Messages',number.format(messages.length)]],'cc-detail-facts'),
    el('h4','Report ID'),recordId(id,'report ID')
   ]);
   if(report.messageId)summary.append(el('h4','Reported message ID'),recordId(report.messageId,'message ID'));
   const side=el('aside','','cc-detail-primary');
   side.append(summary);
   if(report.attachment){
    const {kind,mime,source,at}=report.attachment;
    const attachment=card('Submitted attachment',[details([
     ['Type',kind==='audio'?'Audio':'Image'],['Format',mime],['Source',evidenceSource(source)],['Sent',date(at)]
    ],'cc-detail-facts')]);
    if(media){
     const slot=el('div','','cc-report-attachment');
     const reveal=action('View submitted attachment',async()=>{
      const blob=await media(id);
      if(!alive(token))return;
      if(objectURL)URL.revokeObjectURL(objectURL);
      objectURL=URL.createObjectURL(blob);
      const node=el(kind==='image'?'img':'audio','','cc-evidence');
      node.src=objectURL;
      if(kind==='audio')node.controls=true;
      else node.alt='Submitted report evidence';
      slot.replaceChildren(node);
     },'cc-secondary');
     slot.append(reveal);
     attachment.append(slot);
    }
    side.append(attachment);
   }
   loading.remove();
   main.append(splitDetail([stream],side));
  }catch(e){
   if(alive(token)){loading.textContent=e.message||'Submitted evidence unavailable.';main.append(button('Retry',()=>openReportEvidence(id,back),'cc-secondary cc-fit'));}
  }
 }
 function reportCorrespondence(report,investigation,reopen){
  const panel=card('Reporter correspondence');
  const entries=el('div','','cc-report-correspondence');
  for(const followUp of report.followUps||[]){
   const thread=el('article','','cc-report-follow-up');
   thread.append(el('strong','Request to reporter'),el('time',date(followUp.requestedAt),'cc-muted'),el('p',followUp.request,'cc-case-note'));
   if(followUp.repliedAt!=null){
    const reply=el('div','','cc-report-reply');
    reply.append(el('strong','Reporter’s evidence'),el('time',date(followUp.repliedAt),'cc-muted'),el('p',followUp.reply,'cc-case-note'));
    thread.append(reply);
   }else thread.append(el('p',report.resolved?'Closed before a reply':'Waiting for the reporter','cc-muted'));
   entries.append(thread);
  }
  if(entries.childElementCount)panel.append(entries);
  const mayContact=report.reporter&&!report.resolved&&(!investigation.assignee||investigation.assignedToMe||investigation.canClaim);
  if(mayContact&&report.followUpStatus!=='awaiting-reporter'){
   const label=el('label','Evidence to request','cc-report-follow-up-label');
   const field=el('textarea');
   field.maxLength=1000;field.rows=3;
   field.placeholder='Describe what evidence would help your review';
   label.append(field);
   let pending;
   const send=action('Request evidence',async()=>{
    const text=field.value.trim();
    if(!text){field.focus();throw Error('Enter what evidence you need.');}
    if(pending?.text!==text)pending={text,requestId:crypto.randomUUID()};
    await api('reports/follow-up',{id:report.id,...pending});
    toast('Evidence request sent','success');
    await reopen();
   },'cc-secondary cc-fit');
   panel.append(label,el('p','The reporter can see and reply to this request.','cc-muted'),send);
  }else if(!entries.childElementCount)panel.append(el('p','No evidence has been requested from the reporter.','cc-muted'));
  return panel;
 }
 async function openReportCase(id,back=()=>load()){
  const {token}=detailView('Report details',back),loading=el('p','Loading report…','cc-muted');
  main.append(loading);
  try{
   const investigation=await api(caseRoute('report',id));
   if(!alive(token))return;
   const report=investigation.record;
   if(!report)throw Error('Report unavailable.');
   const reopen=()=>openReportCase(id,back);
   const metadata=card(report.reason);
   metadata.classList.add('cc-record-panel');
   metadata.append(status(report.resolved?'solved':report.workflow||'inspection'),details([
    ['Received',date(report.created)],['Chat type',chatTypeLabel(report.chat_type)],
    ['Previous reports for this account',number.format(report.previousReports??0)],['Moderation decisions',number.format(report.history?.length??0)]
   ],'cc-detail-facts'),el('h4','Reporter’s statement'),el('p',report.evidence||'No statement included.','cc-case-note'));
   const account=report.account;
   const restrictions=[];
   if(account?.suspended)restrictions.push(account.suspendedUntil?'Suspended until '+date(account.suspendedUntil):'Suspended indefinitely');
   if(account?.restrictedUntil)restrictions.push('Messaging restricted until '+date(account.restrictedUntil));
   const parties=el('div','','cc-report-parties');
   parties.append(reportAccount('Reported account',report.target,reopen,report.reportedAccount,restrictions.join(' · ')),reportAccount('Reporter account',report.reporter,reopen,report.reporterAccount));
   const messageCount=report.snapshot?.messageCount??report.context?.length??0;
   const hasAttachment=Boolean(report.snapshot?.hasAttachment??report.attachment);
   const context=card('Reported chat snapshot',[details([
    ['Messages included',number.format(messageCount)],['Attachment',hasAttachment?'Included':'None'],['Reported message ID',report.message_id||report.messageId]
   ],'cc-detail-facts')]);
   if(messageCount||hasAttachment)context.append(button('View reported chat',()=>openReportEvidence(id,reopen),'cc-fit'));
   else context.append(el('p','No messages or attachments were included.','cc-muted'));
   const controls=card('Moderation');
   if(report.resolved){
    controls.append(details([['Decision',report.action],['Resolved',date(report.resolved)],['Moderator',report.moderator]]));
    if(report.notes)controls.append(el('p',report.notes,'cc-case-note'));
    controls.append(archiveAction('reports',report.id,Boolean(report.archived)));
   }else if(investigation.assignee&&!investigation.assignedToMe&&!investigation.canClaim){
    controls.append(el('p','This report is assigned to another administrator.','cc-muted'));
   }else{
    const note=el('textarea');note.placeholder='Reason or review note';note.setAttribute('aria-label','Moderation note');note.maxLength=1000;
    const choice=select([['','Choose a decision'],['dismiss','Dismiss report'],['warn','Warn account'],['restrict','Restrict for 24 hours'],['suspend24h','Suspend for 24 hours'],['suspend7d','Suspend for 7 days'],['suspend','Suspend indefinitely']]);
    choice.setAttribute('aria-label','Moderation decision');
    const progress=el('div','','cc-actions');
    for(const [value,label] of [['inspection','Mark in review'],['help','Request help']]){
     progress.append(action(label,async()=>{
      await api('reports/collaborate',{id,status:value,note:note.value.trim()});
      await reopen();
     },'cc-secondary'));
    }
    const resolveReport=action('Resolve report',async()=>{
     const decision=choice.value,notes=note.value.trim();
     if(!decision)throw Error('Choose a decision.');
     if(!notes)throw Error('Enter a reason for the decision.');
     if(!await modalConfirm(choice.selectedOptions[0].textContent+'?')||!alive(token))return;
     await api('reports/resolve',{id,action:decision,notes});
     toast('Report resolved','success');
     await reopen();
    },'cc-danger');
    controls.append(note,progress,choice,resolveReport);
   }
   const activity=mountCaseActivity('report',id,token,{back:reopen,initial:investigation,onChange:()=>reopen()});
   const side=el('aside','','cc-detail-primary');
   side.append(activity.panel);
   const history=(report.history||[]).filter(item=>item.report_id!==report.id);
   if(history.length){
    const events=history.map(item=>({action:'Moderation decision',detail:item.action,note:item.notes,at:item.created,actor:item.actor}));
    side.append(card('Prior moderation decisions',[timeline(events)]));
   }
   loading.remove();
   main.append(splitDetail([metadata,parties,context,reportCorrespondence(report,investigation,reopen),controls],side));
  }catch(e){
   if(alive(token)){loading.textContent=e.message;main.append(button('Retry',()=>openReportCase(id,back),'cc-secondary'));}
  }
 }
 function renderOverview(data){
  const queue=el('section','','cc-queue');
  const queueHeading=el('h3','Needs attention');
  const queueRows=el('div','','cc-queue-list');
  const empty=el('p','No open work in your queues.','cc-muted cc-queue-empty');
  empty.setAttribute('role','status');
  const items=[
   ['Open reports','Review reports awaiting a moderation decision.','Reports','all',work=>work.reports],
   ['Shop reviews','Review seller changes before they go live.','Shop reviews','all',work=>work.shopReviews??0],
   ['Deletion requests','Review customer requests assigned to you.','Support','all',work=>work.deletionRequests],
   ['Verified payments','Release access for verified payments.','Payment tickets','all',work=>work.paymentReleases],
   ['Payments to review','Recheck older submissions and review legacy orders.','Payments','review',work=>work.stalePayments+work.legacyPayments],
   ['Unassigned tickets','Claim a ticket or take over from an unavailable admin.','Tickets','claim',work=>work.claimableTickets],
   ['My tickets','Continue tickets assigned to you.','Tickets','mine',work=>work.assignedTickets],
   ['Support requests','Respond to new requests assigned to you.','Support','all',work=>work.supportRequests],
   ['Other payment tickets','Review questions and ongoing payment cases.','Payment tickets','all',work=>work.paymentTickets-work.paymentReleases],
   ['Open feedback','Review feedback before it is marked solved.','Feedback','all',work=>work.feedback]
  ];
  const counters=items.map(([label,hint,tab,targetScope,total])=>{
   const row=button('',()=>navigate(tab,targetScope),'cc-queue-row cc-secondary');
   const summary=el('span','','cc-queue-text'),count=el('strong','—','cc-queue-count'),arrow=el('span','','cc-queue-arrow');
   summary.append(el('strong',label),el('small',hint));arrow.setAttribute('aria-hidden','true');
   row.append(summary,count,arrow);queueRows.append(row);
   row.addEventListener('blur',()=>{row.hidden=row.dataset.pending!=='true';});
   return {row,count,total};
  });
  updateOverview=work=>{
   let hasWork=false;
   for(const {row,count,total} of counters){
    const value=total(work);
    const label=Number.isFinite(value)?String(value):'—';
    if(count.textContent!==label)count.textContent=label;
    const pending=value>0;
    row.dataset.pending=String(pending);
    row.hidden=!pending&&document.activeElement!==row;
    if(pending)hasWork=true;
   }
   empty.hidden=hasWork;
  };
  updateOverview(data.work||{});
  queue.append(queueHeading,queueRows,empty);
  const accounts=data.totals?.accounts||{},payments=data.totals?.payments||{},keys=data.totals?.keys||{};
  const count=value=>Number.isFinite(value)?number.format(value):'—';
  const directory=el('section','','cc-queue cc-totals');
  const groups=el('div','','cc-total-groups');
  const totalGroup=(group,headline,value,rows,tab)=>{
   const panel=el('article','','cc-total-panel'),header=el('div','','cc-panel-heading'),metric=el('div','','cc-total-headline');
   header.append(el('h4',group),button('Open '+tab.toLowerCase(),()=>navigate(tab),'cc-secondary cc-compact-button'));
   metric.append(el('strong',value),el('span',headline,'cc-muted'));
   panel.append(header,metric,details(rows,'cc-total-breakdown'));
   return panel;
  };
  groups.append(totalGroup('Accounts','Total accounts',count(accounts.total??data.accounts),[
   ['Active',count(accounts.active??data.active)],['Expired',count(accounts.expired)],['Suspended',count(accounts.suspended)],
   ['Revoked',count(accounts.revoked)],['Retired staff',count(accounts.retired)],['Administrators',count(accounts.admins??data.admins)],['Sellers',count(accounts.sellers)]
  ],'Accounts'),totalGroup('Payments','Verified USD revenue',currency(payments.verifiedUsdCents??data.revenue,'USD'),[
   ['Confirmed payments',count(payments.confirmed)],['Submitted payments',count(payments.submitted)],
   ['Confirmed legacy EUR',currency(payments.confirmedLegacyEurCents,'EUR')]
  ],'Payments'),totalGroup('Access keys','Unused keys',count(keys.unused??data.keys),[
   ['Redeemed',count(keys.redeemed)],['Revoked',count(keys.revoked)]
  ],'Keys'));
  directory.append(el('h3','Account and payment totals'),groups);
  main.append(queue,directory);
 }
 function keyReveal(key,token,revealOnOpen){
  const panel=card('Activation key');
  if(!key.revealAvailable){
   const message=key.generated?'Choose Replace unused key to create a new activation key you can reveal.':'The activation key is unavailable to reveal.';
   panel.append(el('p',message,'cc-muted'));
   return panel;
  }
  panel.classList.add('cc-key-reveal');
  const code=el('code','','cc-secret');
  code.id='cc-key-value';
  code.setAttribute('aria-label','Activation key value');
  code.hidden=true;
  let revealRevision=0;
  const reveal=action('Reveal key',async()=>{
   const request=++revealRevision;
   try{
    const result=await api('keys/reveal',{id:key.id});
    if(!alive(token)||document.hidden||request!==revealRevision)return;
    code.textContent=result.key;
    code.hidden=copy.hidden=hide.hidden=false;
    reveal.hidden=true;
    reveal.setAttribute('aria-expanded','true');
    copy.focus();
   }catch(e){
    if(!alive(token))return;
    if(e.status===404||e.status===409){void openKey(key.id,{notice:e.message||'Review the key’s current details.'});return;}
    throw e;
   }
  },'cc-secondary');
  reveal.setAttribute('aria-controls',code.id);
  reveal.setAttribute('aria-expanded','false');
  const copy=action('Copy key',async()=>{
   if(code.hidden)return;
   try{
    await navigator.clipboard.writeText(code.textContent);
    toast('Activation key copied','success');
   }catch{
    if(!alive(token)||code.hidden)return;
    const selection=window.getSelection(),range=document.createRange();
    range.selectNodeContents(code);
    selection?.removeAllRanges();selection?.addRange(range);
    toast('Select Copy to keep this activation key.','info');
   }
  },'cc-secondary');
  function conceal(){
   revealRevision++;
   code.textContent='';
   code.hidden=copy.hidden=hide.hidden=true;
   reveal.hidden=false;
   reveal.setAttribute('aria-expanded','false');
  }
  const hide=button('Hide key',()=>{conceal();reveal.focus();},'cc-secondary');
  copy.hidden=hide.hidden=true;
  concealKey=conceal;
  const actions=el('div','','cc-actions');
  actions.append(reveal,copy,hide);
  panel.append(code,actions);
  if(revealOnOpen&&!document.hidden)reveal.click();
  return panel;
 }
 async function openKey(id,{notice='',revealOnOpen=false}={}){
  const back=()=>load();
  const {token}=detailView('Access key details',back,'Back to keys');
  const message=el('p','Loading key details…','cc-muted');
  message.setAttribute('role','status');
  main.append(message);
  let key;
  try{
   ({key}=await api('keys/'+encodeURIComponent(id)));
  }catch(e){
   if(!alive(token))return;
   message.textContent=e.status===404?'This key is no longer in the inventory.':e.message||'Key details unavailable.';
   if(e.status!==404)main.append(button('Retry',()=>openKey(id),'cc-secondary cc-fit'));
   return;
  }
  if(!alive(token))return;
  if(notice)message.textContent=notice;else message.remove();
  const state=keyState(key),account=key.accountId||key.account;
  const summary=card('Key record',[status(state),el('h4','Key ID'),recordId(key.id,'key ID'),details([
   ['Plan',planName(key.plan)],['Issued',date(key.created)],['Redeemed',date(key.redeemed)],
   ['Source',key.generated?'Administrator issued':'Payment or legacy'],['Key fingerprint',key.fingerprint]
  ],'cc-detail-facts')]);
  const linked=card('Linked account');
  if(account)linked.append(recordId(account,'account ID'),button('Open account',()=>openAccount(account,()=>openKey(id)),'cc-secondary cc-compact-button cc-fit'));
  else linked.append(el('p','No linked account.','cc-muted'));
  main.append(summary,linked);
  const actions=el('div','','cc-actions');
  if(state==='unused'&&key.state==='confirmed')main.append(keyReveal(key,token,revealOnOpen));
  if(state==='unused'&&key.generated&&key.state==='confirmed'){
   const replace=action('Replace unused key',async()=>{
    concealKey?.();
    if(!await modalConfirm('Replace this key? Its current activation secret will stop working.')||!alive(token))return;
    const result=await api('keys/replace',{id:key.id});
    if(!alive(token))return;
    void openKey(id);
    secret('Replacement key',[result]);
   },'cc-secondary');
   const revoke=button('Revoke unused key',()=>{
    concealKey?.();
    confirmReason('Revoke unused key','Revoking this key permanently disables activation.',async(reason,close)=>{
     await api('keys/revoke',{id:key.id,reason});
     close();toast('Key revoked','success');
     if(alive(token))void openKey(id);
    });
   },'cc-danger');
   actions.append(replace,revoke);
  }
  if(key.deletable&&key.deleteToken){
   const label=key.deleteAccount?'Delete key and account':'Delete key';
   const question=(key.deleteAccount
    ?'Permanently delete this key and account '+key.deleteAccount+'? This also deletes the account’s active chats and contacts.'
    :'Permanently delete this key from the inventory and disable activation?')+(key.retainsPayment?' The payment record is kept.':'');
   actions.append(action(label,async()=>{
    concealKey?.();
    if(!await modalConfirm(question)||!alive(token))return;
    try{
     const result=await api('keys/delete',{id,confirmed:true,deleteToken:key.deleteToken});
     if(!alive(token))return;
     const success=result.deletedAccount?'Key and linked account deleted':'Key deleted';
     toast(success+(result.retainedPayment?' · Payment record retained':''),'success');
     cursor='';keyPages=[];await load();
    }catch(e){
     if(!alive(token))return;
     if(e.status===403||e.status===404||e.status===409){void openKey(id,{notice:'The key or its linked account changed. Review the current details before deleting.'});return;}
     throw e;
    }
   },'cc-danger'));
  }
  if(actions.childElementCount)main.append(card('Manage key',[actions]));
 }
 function purgeUsedKeys(token){
  const title='Remove used keys and linked accounts',phrase='REMOVE USED KEYS AND ACCOUNTS';
  const dialog=el('dialog','','cc-modal cc-purge-dialog'),body=el('div','','cc-purge-body'),actions=el('div','','cc-actions');
  dialog.setAttribute('aria-label',title);
  const message=el('p','','cc-muted');message.setAttribute('role','status');
  const countLabel=preview=>details([
   ['Used keys to remove',number.format(preview.keys??0)],['Linked accounts to delete',number.format(preview.accounts??0)],
   ['Payment records to keep',number.format(preview.retainedPayments??0)]
  ],'cc-detail-facts');
  const field=input('Confirmation phrase');field.maxLength=phrase.length;
  const remove=el('button','Remove used keys and accounts','cc-button cc-danger');remove.type='submit';remove.disabled=true;
  const cancel=button('Cancel',()=>dialog.close(),'cc-secondary');
  let preview=null,busy=false;
  const form=el('form','','cc-purge-body');
  const fieldLabel=el('label');fieldLabel.append(el('span','Type this phrase to confirm'),el('code',phrase),field);
  field.addEventListener('input',()=>{remove.disabled=busy||field.value!==phrase;});
  form.addEventListener('submit',async e=>{
   e.preventDefault();
   if(busy||!preview||field.value!==phrase||!alive(token))return;
   busy=true;remove.disabled=cancel.disabled=field.disabled=true;
   message.textContent='Removing keys and linked accounts…';
   try{
    const result=await api('keys/purge-used',{confirmation:field.value,previewToken:preview.previewToken});
    if(!alive(token))return;
    dialog.close();
    toast(number.format(result.removedKeys)+' keys removed · '+number.format(result.deletedAccounts)+' accounts deleted · '+number.format(result.retainedPayments)+' payment records kept','success');
    cursor='';keyPages=[];await load();
   }catch(errorValue){
    message.textContent=errorValue.message||'Removal failed. Refresh the preview before trying again.';
    preview=null;
    form.hidden=true;
    actions.append(button('Refresh preview',e=>{e.currentTarget.remove();void refreshPreview();},'cc-secondary'));
   }finally{
    busy=false;cancel.disabled=field.disabled=false;
   }
  });
  actions.append(cancel);
  form.append(fieldLabel,remove);form.hidden=true;
  dialog.append(el('h3',title),el('p','Permanently delete used keys and eligible linked accounts. Payment records are kept.','cc-muted'),body,form,message,actions);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  root.append(dialog);dialog.showModal();
  async function refreshPreview(){
   message.textContent='Preparing removal preview…';
   body.replaceChildren();
   try{
    const result=await api('keys/purge-used/preview',{});
    if(!dialog.open||!alive(token))return;
    preview=result;
    body.replaceChildren(countLabel(result));
    form.hidden=!result.keys;
    field.value='';remove.disabled=true;
    message.textContent=result.keys?'':'There are no used keys eligible for removal.';
   }catch(errorValue){
    if(!dialog.open||!alive(token))return;
    message.textContent=errorValue.message||'Preview unavailable.';
    actions.append(button('Retry',e=>{e.currentTarget.remove();void refreshPreview();},'cc-secondary'));
   }
  }
  void refreshPreview();
 }
 function renderKeys(data,token){
  const picker=select(plans),quantity=input('Quantity','number'),generate=el('button','Generate keys','cc-button');
  quantity.min='1';quantity.max='100';quantity.step='1';quantity.value='1';quantity.required=true;
  const form=el('form','','cc-key-generate');
  const planField=el('label'),quantityField=el('label');
  picker.setAttribute('aria-label','Key plan');
  planField.append(el('span','Plan'),picker);
  quantityField.append(el('span','Quantity'),quantity);
  form.append(planField,quantityField,generate);
  form.addEventListener('submit',async e=>{
   e.preventDefault();
   if(generate.disabled||!alive(token))return;
   generate.disabled=true;
   try{
    const result=await api('keys/generate',{plan:picker.value,count:quantity.valueAsNumber});
    if(!alive(token))return;
    secret('New access keys',result.keys);
    await load();
   }catch(errorValue){error(errorValue);}finally{generate.disabled=false;}
  });
  const issuing=card('Generate access keys',[form]);
  const tally=data.counts||{};
  const selectors=el('div','','cc-key-filters');
  selectors.setAttribute('role','group');selectors.setAttribute('aria-label','Filter access keys');
  for(const [value,label] of [['all','All keys'],['unused','Unused'],['redeemed','Redeemed'],['revoked','Revoked']]){
   const count=value==='all'?Object.values(tally).reduce((sum,n)=>sum+n,0):tally[value]??0;
   const chip=button('',()=>{scope=value;cursor='';keyPages=[];load(null,'Filter '+label.toLowerCase());},'cc-secondary cc-key-filter');
   chip.setAttribute('aria-label','Filter '+label.toLowerCase());
   chip.setAttribute('aria-pressed',String(scope===value));
   chip.append(el('span',label),el('strong',number.format(count)));
   selectors.append(chip);
  }
  const inventory=el('section','','cc-key-inventory');
  const inventoryHead=el('div','','cc-key-inventory-head');
  inventoryHead.append(el('h3','Key inventory'),search('Key ID, fingerprint or account ID'),selectors);
  inventory.append(inventoryHead);
  if(data.items.length){
   const wrap=el('div','','cc-key-table-wrap'),table=el('table','','cc-key-table'),head=el('thead'),body=el('tbody'),headerRow=el('tr');
   table.setAttribute('aria-label','Access key results');
   for(const heading of ['Key reference','Status','Plan','Issued','Account','Details']){
    const cell=el('th',heading);cell.scope='col';headerRow.append(cell);
   }
   head.append(headerRow);
   for(const key of data.items){
    const row=el('tr'),reference=el('td'),state=el('td'),created=el('td'),linked=el('td'),open=el('td');
    reference.append(el('code',key.fingerprint?'QZU-••••-'+key.fingerprint:key.id.slice(0,8),'cc-key-ref'));
    if(key.fingerprint)reference.append(el('small','ID '+key.id.slice(0,8),'cc-muted'));
    state.append(status(keyState(key)));
    const createdDate=new Date(key.created),time=el('time',createdDate.toLocaleDateString());time.dateTime=createdDate.toISOString();created.append(time);
    const account=key.accountId||key.account;
    linked.append(account?button(account.slice(0,8),()=>openAccount(account),'cc-key-account cc-compact-button'):el('span','—','cc-muted'));
    if(account)linked.firstElementChild.setAttribute('aria-label','Open account '+account);
    const view=button('View',()=>openKey(key.id,{revealOnOpen:true}),'cc-secondary cc-compact-button');
    view.setAttribute('aria-label','View key '+key.id);
    open.append(view);
    row.append(reference,state,el('td',planName(key.plan)),created,linked,open);
    body.append(row);
   }
   table.append(head,body);
   wrap.append(table);inventory.append(wrap);
  }else inventory.append(el('p','No matching keys.','cc-muted cc-key-empty'));
  if(keyPages.length||data.nextCursor){
   const pages=el('div','','cc-key-pages');
   const previous=button('Previous page',()=>{cursor=keyPages.pop();load(null,'Previous page');},'cc-secondary cc-compact-button');
   const next=button('Next page',()=>{keyPages.push(cursor);cursor=data.nextCursor;load(null,'Next page');},'cc-secondary cc-compact-button');
   previous.disabled=!keyPages.length;next.disabled=!data.nextCursor;
   pages.append(el('span','Page '+number.format(keyPages.length+1),'cc-muted'),previous,next);inventory.append(pages);
  }
  const danger=el('details','','cc-key-maintenance');
  danger.append(el('summary','Key maintenance'),el('p','Review eligible used keys and linked accounts before bulk removal.','cc-muted'),button('Remove all used keys',()=>purgeUsedKeys(token),'cc-danger cc-fit'));
  const keyTools=el('div','','cc-key-tools');
  keyTools.append(issuing,danger);
  main.append(keyTools,inventory);
 }
 function queuePicker(label,choices){
  const field=select(choices);
  field.setAttribute('aria-label',label);
  field.value=scope;
  field.addEventListener('change',()=>{scope=field.value;load(null,true);});
  field.className='cc-queue-picker';
  return field;
 }
 async function openPaymentTicket(id,back=()=>load()){
  const {token}=detailView('Payment ticket',back);
  let currentPayment=null,assignedToOther=false;
  const activity=mountCaseActivity('payment-ticket',id,token,{back:()=>openPaymentTicket(id,back),onState(data){
   assignedToOther=Boolean(data.assignee&&!data.assignedToMe&&!data.canClaim);
   if(currentPayment)render(currentPayment);
  }});
  const n=el('div','','cc-ticket'),summary=el('div','','cc-muted'),chat=el('div','','cc-snapshot cc-ticket-chat'),field=el('textarea'),feedback=el('p','','cc-muted');
  field.placeholder='Write a reply';field.maxLength=2000;field.disabled=true;let last='',busy=false,polling=false,pending=null,mutation=0;
  const actions=el('div','','cc-actions');
  const send=action('Send reply',async()=>{if(busy||!field.value.trim())return;const text=field.value.trim(),requestId=pending?.text===text?pending.requestId:crypto.randomUUID();pending={text,requestId};busy=true;mutation++;try{const t=await api('payment-tickets/send',{id,text,requestId});if(alive(token)){if(field.value.trim()===text)field.value='';pending=null;render(t);void activity.refresh();}}finally{busy=false;}});
  const handle=async(operation,data={})=>{
   if(busy)return;
   busy=true;mutation++;
   try{
    render(await api('payment-tickets/'+operation,{id,...data}));
    void activity.refresh();
   }finally{busy=false;}
  };
  const verify=action('Verify transaction',()=>handle('verify'));
  const release=action('Release verified key',async()=>{if(await modalConfirm('Release the access key for this verified payment?')&&alive(token))await handle('release');});
  const close=action('Close ticket',()=>handle('close'),'cc-secondary');
  const review=action('Start review',()=>handle('review'),'cc-secondary');
  const reject=button('Reject ticket',()=>{
   if(n.querySelector('.cc-payment-reject'))return;
   const box=card('Reject ticket',[el('p','The customer can start a new ticket for this payment.')]);
   const reason=el('textarea');reason.placeholder='Reason for rejection';reason.maxLength=500;reason.setAttribute('aria-label','Rejection reason');
   box.classList.add('cc-payment-reject');
   box.append(reason,action('Confirm rejection',async()=>{
    if(busy)return;
    if(!reason.value.trim())throw Error('Enter a reason.');
    await handle('reject',{reason:reason.value.trim()});
    box.remove();
   },'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary'));
   n.append(box);reason.focus();
  },'cc-danger');
  for(const control of [review,verify,release,reject,close,send])control.hidden=true;
  field.setAttribute('aria-label','Payment ticket reply');
  actions.append(review,verify,release,reject,close);n.append(summary,chat,feedback,field,send,actions);main.append(splitDetail([n],activity.panel));
  function render(t){
   if(!alive(token))return;currentPayment=t;summary.textContent=t.plan+' · $'+t.usd+' · '+t.coin+' · '+t.amount+' '+t.coin+' · '+t.state+(t.txid?' · '+t.txid:'');
   const fp=JSON.stringify([t.messages.map(m=>m.id),t.state,t.released,t.redeemed,t.closed,t.confirmations,t.txid,t.status,t.reason]);
   if(fp!==last){last=fp;const bottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<80,top=chat.scrollTop;chat.replaceChildren();for(const m of t.messages){const b=el('div','','cc-bubble '+(m.actor==='customer'?'other':'mine'));b.append(el('small',(m.actor==='customer'?'Customer':'Support · '+m.actor.slice(0,8))+' · '+date(m.at)));if(m.text)b.append(el('p',m.text));if(m.hasProof)b.append(action('View proof',async()=>{const data=await api('payment-tickets/proof',{id,message:m.id});if(alive(token)&&b.isConnected){const image=el('img');image.src='data:image/png;base64,'+data.data;image.alt='Submitted payment proof';image.className='cc-evidence';b.append(image);}}));chat.append(b);}if(t.released)chat.append(el('p','Verified key delivered to customer.','cc-muted'));if(t.reason)chat.append(el('p','Rejected: '+t.reason,'cc-error'));chat.scrollTop=bottom?chat.scrollHeight:top;}
   review.hidden=assignedToOther||t.closed||t.status==='review';reject.hidden=assignedToOther||t.closed||t.state==='confirmed'||t.confirmations>0;verify.hidden=t.closed||t.state!=='submitted';release.hidden=assignedToOther||t.closed||t.released||t.state!=='confirmed';close.hidden=assignedToOther||t.closed||!t.released;field.disabled=t.closed;send.hidden=t.closed;
   feedback.textContent=t.closed?'This ticket is closed.':assignedToOther?'Assigned to another administrator.':t.needsReview?'Payment needs review. Automatic checks have ended.':t.status==='review'?'Under review':'Open ticket';
  }
  async function poll(){if(!alive(token)||polling)return;polling=true;try{if(!busy&&!document.hidden){const observed=mutation,t=await api('payment-tickets/state',{id});if(alive(token)&&!busy&&observed===mutation)render(t);}}catch(e){if(alive(token)){if(e.message==='Ticket unavailable.'){detailView('Ticket unavailable',back);}else feedback.textContent=e.message;}}finally{polling=false;if(alive(token))setTimeout(poll,5000);}}
  poll();
 }
 function renderMonitoring(data,token){
  const metrics=el('div','','cc-metrics cc-monitor-metrics'),feed=el('div','','cc-monitor-feed'),bar=el('div','','cc-actions'),updated=el('p','','cc-muted'),note=el('p','Read-only diagnostics from this server. No message contents, IP addresses, keys, PINs or tokens are collected. Console history is limited to the current server process.','cc-muted');
  const filter=select([['all','All events'],['AUTH','Authentication'],['PAYMENT','Payments'],['TICKET','Tickets'],['SUPPORT','Support'],['ADMIN','Admin'],['SYSTEM','System'],['error','Errors only']]);
  let paused=false,pending=false,latest=data;
  const pause=button('Pause live updates',()=>{paused=!paused;pause.textContent=paused?'Resume live updates':'Pause live updates';if(!paused)refresh();},'cc-secondary');
  const mb=n=>Math.round(n/1048576)+' MB';
  const duration=n=>Math.floor(n/86400)+'d '+Math.floor(n%86400/3600)+'h '+Math.floor(n%3600/60)+'m';
  function draw(){
   if(!alive(token))return;const d=latest;
   updated.textContent=(d.environment==='production'?'PRODUCTION':'DEVELOPMENT')+' · '+location.host+' · v'+d.version+' · '+(paused?'Paused':'Last updated '+date(d.at));
   metrics.replaceChildren();
   for(const [label,value] of [['Process uptime',duration(d.uptimeSeconds)],['Process CPU',d.cpuPercent==null?'Sampling…':d.cpuPercent.toFixed(1)+'%'],['Process RAM',mb(d.rssBytes)],['JS heap',mb(d.heapUsedBytes)],['Host RAM available',mb(d.hostFreeBytes)+' / '+mb(d.hostMemoryBytes)],['Host load (1 min)',d.load1.toFixed(2)],['API requests · 5 min',d.requests],['Server errors · 5 min',d.errors],['Client errors · 5 min',d.rejected],['Mean API response',d.meanResponseMs==null?'—':d.meanResponseMs+' ms'],['Successful send requests · 5 min',d.messageRequests],['Active desktop sessions',d.activeDesktopSessions],['Live waiting requests',d.liveRequests],['Open payment tickets',d.paymentTickets],['Assigned support requests',d.supportRequests]]){
    const n=el('div','','cc-metric');n.append(el('strong',String(value)),el('span',label));metrics.append(n);
   }
   const top=feed.scrollTop;feed.replaceChildren();
   const rows=d.events.filter(e=>filter.value==='all'||filter.value===e.category||filter.value==='error'&&e.status==='error');
   for(const e of rows){const line=el('div','','cc-monitor-line');line.append(el('time',date(e.at)),el('span',e.category,'cc-monitor-category'),el('span',e.label),el('span',e.status,'cc-monitor-outcome '+e.status));feed.append(line);}
   if(!rows.length)feed.append(el('p','No matching events in this process.','cc-muted'));feed.scrollTop=top;
  }
  async function refresh(){
   if(!alive(token)||pending||paused||document.hidden)return;
   pending=true;try{latest=await api('monitoring');draw();}catch(e){if(alive(token)){updated.textContent='Disconnected · '+e.message;if(e.status===401){stop();onExit();}}}finally{pending=false;}
  }
  filter.addEventListener('change',draw);bar.append(filter,pause,button('Refresh now',refresh,'cc-secondary'));
  main.append(updated,metrics,el('h3','Live server console'),bar,feed,note,el('p','Counts cover the current and preceding four minute buckets. Response time excludes long-poll waits. Successful send requests are not delivery receipts. CPU may exceed 100% across cores.','cc-muted'));
  draw();
  async function tick(){if(!alive(token))return;await refresh();if(alive(token))setTimeout(tick,5000);}
  setTimeout(tick,5000);
 }
 function renderAnnouncements(initial,token){
  const feed=el('div','','cc-announcements-feed'),draft=el('textarea');
  let snapshot=initial,posts=initial.posts,hasOlder=Boolean(initial.hasOlder),pages=1,busy=false,fingerprint='';
  draft.placeholder='Write an announcement…';draft.maxLength=2000;
  draft.setAttribute('aria-label','Announcement text');
  const send=action('Publish to everyone',async()=>{
   const text=draft.value.trim();
   if(!text||!await modalConfirm('Publish this announcement to all accounts?')||!alive(token))return;
   busy=true;
   try{await api('announcements/publish',{text});if(draft.value.trim()===text)draft.value='';}
   finally{busy=false;}
   await poll();
  });
  const older=action('Load earlier announcements',async()=>{
   if(busy||!posts.length)return;
   busy=true;
   try{
    const page=await api('announcements?before='+posts[0].id);
    if(!alive(token))return;
    if(page.deletedRevision!==snapshot.deletedRevision){await reload(true);return;}
    posts=[...page.posts,...posts];hasOlder=Boolean(page.hasOlder);pages++;
    draw();
   }finally{busy=false;}
  },'cc-secondary');
  function draw(){
   if(!alive(token))return;
   older.hidden=!hasOlder;
   const next=JSON.stringify(posts);
   if(fingerprint===next)return;
   fingerprint=next;feed.replaceChildren();
   for(const p of [...posts].reverse()){
    const row=el('article','','cc-announcement'),head=el('div','','cc-announcement-head'),menu=el('details','','cc-announcement-menu');
    const trigger=el('summary','⋯');trigger.setAttribute('aria-label','Announcement options');
    menu.append(trigger,action('Delete for all',async()=>{
     if(!await modalConfirm('Permanently delete this announcement for everyone?')||!alive(token))return;
     busy=true;
     try{await api('announcements/delete',{id:p.id});posts=posts.filter(x=>x.id!==p.id);draw();}
     finally{busy=false;}
     await poll();
    },'cc-danger'));
    head.append(el('strong','qzu-Support'),el('span','Verified','cc-admin-mark'),el('small',date(p.at),'cc-muted'),menu);
    row.append(head,el('p',p.text));feed.append(row);
   }
   if(!posts.length)feed.append(el('p','No announcements yet.','cc-muted'));
  }
  async function reload(force=false){
   const next=await api('announcements');
   if(!alive(token)||!force&&JSON.stringify(next)===JSON.stringify(snapshot))return;
   let current=next.posts,more=Boolean(next.hasOlder);
   for(let i=1;i<pages&&more;i++){
    const page=await api('announcements?before='+current[0].id);
    if(!alive(token)||page.deletedRevision!==next.deletedRevision)return;
    current=[...page.posts,...current];more=Boolean(page.hasOlder);
   }
   snapshot=next;posts=current;hasOlder=more;draw();
  }
  async function poll(){
   if(!alive(token)||busy||document.hidden||feed.querySelector('details[open]'))return;
   busy=true;try{await reload();}catch(e){if(alive(token))error(e);}finally{busy=false;}
  }
  main.append(card('New announcement',[draft,send]),feed,older);draw();
  async function tick(){if(!alive(token))return;await poll();if(alive(token))setTimeout(tick,15000);}
  setTimeout(tick,15000);
 }
 async function openUserTicket(id,back=()=>load()){
  const {token,name}=detailView('User ticket',back);
  const activity=mountCaseActivity('ticket',id,token,{back:()=>openUserTicket(id,back)});
  const info=el('p','','cc-muted'),feed=el('div','','cc-ticket-chat cc-snapshot'),field=el('textarea'),controls=el('div','','cc-actions'),seller=select([['','Choose a seller']]),notice=el('p','','cc-muted');field.placeholder='Write a reply…';field.maxLength=2000;
  field.setAttribute('aria-label','Ticket reply');seller.setAttribute('aria-label','Seller');
  let current=null,busy=false,polling=false,fp='',pending=null,available=[],lastPollError='',mutation=0;
  const act=(label,path,data,cls='')=>action(label,async()=>{if(busy)return;busy=true;mutation++;try{const t=await api(path,data());if(alive(token)){render(t);void activity.refresh();}}finally{busy=false;}},cls);
  const accept=act('Accept ticket','tickets/action',()=>({id,action:'accept'})),assign=act('Add seller','tickets/action',()=>({id,action:'assign',seller:seller.value})),share=act('Share seller code','tickets/action',()=>({id,action:'share',seller:seller.value}),'cc-secondary');
  const adminPicker=select([['','Choose administrator']]);adminPicker.setAttribute('aria-label','Transfer to administrator');
  const transfer=act('Transfer ticket','tickets/action',()=>({id,action:'transfer',seller:adminPicker.value}),'cc-secondary');transfer.disabled=true;adminPicker.addEventListener('change',()=>{transfer.disabled=!adminPicker.value;});
  const remove=act('Remove seller','tickets/action',()=>({id,action:'remove',seller:seller.value}),'cc-secondary');
  const erase=action('Delete archived ticket',async()=>{if(busy||!await modalConfirm('Permanently delete this archived ticket?'))return;busy=true;try{await api('tickets/action',{id,action:'delete'});toast('Ticket deleted','success');if(alive(token))await back();}finally{busy=false;}},'cc-danger');erase.hidden=true;
  const close=action('Close & archive',async()=>{if(busy||!await modalConfirm('Close this ticket and archive it?'))return;busy=true;try{await api('tickets/action',{id,action:'close'});if(alive(token)){toast('Ticket closed and archived','success');await back();}}finally{busy=false;}},'cc-danger');
  const send=action('Send reply',async()=>{if(busy||!field.value.trim())return;const text=field.value.trim();if(!pending||pending.text!==text)pending={text,requestId:crypto.randomUUID()};busy=true;mutation++;try{const t=await api('tickets/send',{id,...pending});if(alive(token)){if(field.value.trim()===text)field.value='';pending=null;render(t);void activity.refresh();}}finally{busy=false;}});
  controls.append(accept,seller,assign,share,remove,adminPicker,transfer,close,erase);seller.addEventListener('change',updateSellerControls);
  function lock(b,v){b.dataset.locked=v?'1':'0';b.disabled=v;}
  function updateSellerControls(){const editable=current&&!current.closed&&current.canReply,selected=seller.value,members=current?.sellers||[];lock(assign,!editable||!selected||!available.includes(selected)||members.includes(selected));lock(share,!editable||!selected||!available.includes(selected));lock(remove,!editable||!selected||!members.includes(selected));}
  for(const control of [field,send,...controls.children])control.hidden=true;
  info.textContent='Loading ticket…';updateSellerControls();main.append(splitDetail([info,feed,notice,field,send,controls],activity.panel));
  function render(t){if(!alive(token))return;current=t;name.textContent=t.topic;info.textContent=(t.closed?'Closed':t.assigned?'Open':'Waiting for admin')+' · Customer '+(t.owner||'—');
   const key=JSON.stringify(t.messages);if(key!==fp){fp=key;const bottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<80,top=feed.scrollTop;feed.replaceChildren();for(const m of t.messages){const b=el('div','','cc-bubble '+(m.mine?'mine':'other')),name=m.role==='admin'?'qzu-Support':m.role==='verified-seller'?(m.name||'Seller')+' · Verified':m.role==='seller'?(m.name||'Seller'):m.role==='system'?'Ticket':'Customer';b.append(el('small',name+(m.actor?' · '+m.actor.slice(0,8):'')+' · '+date(m.at),m.role==='admin'?'cc-admin-mark':m.role==='verified-seller'?'cc-seller-mark':''),el('p',m.text));feed.append(b);}if(t.transcriptExpired)feed.append(el('p','The conversation was deleted after the seven-day retention period.','cc-muted'));feed.scrollTop=bottom?feed.scrollHeight:top;}
   accept.hidden=!t.claimable;accept.textContent=t.claimable&&t.admin?'Reclaim ticket':'Accept ticket';
   const editable=!t.closed&&t.canReply;field.hidden=!editable;field.disabled=!editable;
   send.hidden=seller.hidden=assign.hidden=share.hidden=remove.hidden=adminPicker.hidden=transfer.hidden=close.hidden=!editable;
   erase.hidden=!t.closed;updateSellerControls();
   notice.textContent=t.closed?'Ticket closed and archived.':t.claimable&&t.admin?'The assigned admin is unavailable. Reclaim the ticket to reply.':t.assigned&&!editable?'Assigned to another administrator.':editable&&!available.length?'No available sellers.':'';
  }
  api('sellers').then(d=>{if(!alive(token))return;for(const p of d.items.filter(p=>p.active)){available.push(p.account);const o=el('option',(p.name||'Seller')+' · '+p.account.slice(0,8)+(p.verified?' · Verified':''));o.value=p.account;seller.append(o);}renderCurrent();}).catch(e=>{if(alive(token))error(e);});
  api('ticket-admins').then(admins=>{if(alive(token))for(const a of admins.items){const o=el('option','Admin '+a.id.slice(0,8));o.value=a.id;adminPicker.append(o);}}).catch(e=>{if(alive(token))error(e);});
  function renderCurrent(){if(current)render(current);}
  async function poll(){if(!alive(token)||polling)return;polling=true;try{if(!busy&&!document.hidden){const observed=mutation,t=await api('tickets/state',{id});lastPollError='';if(!busy&&observed===mutation)render(t);}}catch(e){if(alive(token)&&lastPollError!==e.message){lastPollError=e.message;error(e);}}finally{polling=false;if(alive(token))setTimeout(poll,5000);}}poll();
 }
 async function openSupportCase(id,archived=false,back=()=>load()){
  const {token}=detailView('Support conversation',back,'Back to inbox');
  const activity=mountCaseActivity('support',id,token,{back:()=>openSupportCase(id,archived,back)});
  const meta=el('p','','cc-muted'),feed=el('div','','cc-support-feed cc-snapshot'),field=el('textarea'),actions=el('div','','cc-actions');field.placeholder='Write a reply…';field.maxLength=2000;let busy=false,fp='',lastError='';
  const run=(label,path,body,cls='',exit=false)=>action(label,async()=>{if(busy||!alive(token))return;busy=true;try{await api(path,body);if(!alive(token))return;if(exit)await back();else{await refresh();void activity.refresh();}}finally{busy=false;}},cls);
  const accept=run('Accept request','support/respond',{id,action:'accept'}),reject=run('Reject request','support/respond',{id,action:'reject'},'cc-secondary',true),solve=run('Close case','support/finish',{id,action:'solve'},'cc-secondary',true);
  const erase=(label,path,question)=>action(label,async()=>{if(busy||!await modalConfirm(question)||!alive(token))return;busy=true;try{await api(path,{id,confirmed:true});toast(label==='Delete Contact'?'Contact deleted':'Chat deleted','success');if(alive(token))await back();}finally{busy=false;}},'cc-danger');
  const deleteChat=erase('Delete Chat','support/delete-direct','Permanently delete this chat for both participants?'),deleteContact=erase('Delete Contact','support/delete-contact','Delete the Support contact and associated conversations for both participants?');
  const send=action('Send',async()=>{if(busy||!field.value.trim())return;busy=true;const text=field.value.trim();try{await api('support/send',{id,text});if(alive(token)){if(field.value.trim()===text)field.value='';await refresh();void activity.refresh();}}finally{busy=false;}});
  field.setAttribute('aria-label','Support reply');
  actions.append(accept,reject,solve,deleteChat,deleteContact);main.append(splitDetail([meta,feed,field,send,actions],activity.panel));
  field.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!send.hidden)send.click();}});
  async function refresh(){const d=await api('support'+(archived?'?archived=1':''));if(!alive(token))return;const p=d.requests.find(r=>r.id===id),r=d.rooms.find(r=>r.id===id),f=d.finished.find(r=>r.id===id),t=p||r||f;if(!t){detailView('Support case unavailable',back);return;}meta.textContent=p?'Pending request':r?'Active conversation':statusLabels[f.status]||f.status;accept.hidden=reject.hidden=!p;solve.hidden=!r;field.hidden=send.hidden=!r;const messages=r?.messages||f?.messages||(p?.preview?[{mine:false,text:p.preview,at:p.at}]:[]);const key=JSON.stringify(messages);if(key!==fp){fp=key;const bottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<80,top=feed.scrollTop;feed.replaceChildren();for(const m of messages){const b=el('div','','cc-bubble '+(m.mine?'mine':'other'));b.append(el('small',(m.mine?'qzu-Support':'Customer')+' · '+date(m.at)),el('p',m.text));feed.append(b);}feed.scrollTop=bottom?feed.scrollHeight:top;}}
  async function poll(){if(!alive(token))return;try{if(!busy&&!document.hidden){await refresh();lastError='';}}catch(e){if(alive(token)&&lastError!==e.message){lastError=e.message;error(e);}}finally{if(alive(token))setTimeout(poll,4000);}}poll();
 }
 async function load(prefetched=null,focusQueue=false){
  listView=false;updateOverview=null;const token=++revision;clearKeySecret();if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
  sectionPicker.value=groupFor(current);
  for(const [label,group] of groups)group.classList.toggle('current',label===sectionPicker.value);
  for(const [name,control] of tabs){
   control.classList.toggle('selected',name===current);
   if(name===current)control.setAttribute('aria-current','page');
   else control.removeAttribute('aria-current');
  }
  main.replaceChildren(el('h2',current),el('p','Loading…','cc-muted'));
  try{
   const archived=current==='Archive',view=archived?archiveTab:current;
   if(view==='Chats'){main.replaceChildren(el('h2','Chats'));await window.QzuDesktopMessenger(main,api,()=>alive(token),{error,confirm:modalConfirm});return;}
   const data=await (prefetched&&typeof prefetched==='object'&&('items' in prefetched||'requests' in prefetched)?prefetched:api(routeFor(view,archived)));
   if(!alive(token))return;
   listSignature=JSON.stringify(data);
   const heading=el('div','','cc-view-heading');heading.append(el('h2',current));
   if(view!=='Monitoring')heading.append(button('Refresh',()=>load(),'cc-secondary'));
   main.replaceChildren(heading);
   if(archived){
    const sub=el('div','','cc-actions cc-archive-tabs');
    for(const name of ['Reports','Feedback','Payment tickets','Payments','Support','Tickets']){
     const control=button(name==='Tickets'?'Closed user tickets':name,()=>{archiveTab=name;load();},name===archiveTab?'':'cc-secondary');
     control.setAttribute('aria-pressed',String(name===archiveTab));sub.append(control);
    }
    const explanation=view==='Tickets'?'Closed tickets remain listed after their transcripts are deleted.':'Use Restore to return a record to its working list. Retention limits still apply.';
    main.append(sub,el('p',explanation,'cc-muted'));
   }
   if(view==='Announcements'){renderAnnouncements(data,token);}else if(view==='Tickets'){
    if(!archived)main.append(queuePicker('Ticket queue',[['all','All open tickets'],['claim','Unassigned and reclaimable'],['mine','Assigned to me']]));
    main.append(caseQueue(archived?'Closed tickets':'User ticket queue',data.items,t=>({
     title:t.topic+' · '+t.id.slice(0,8),
     description:(t.closed?'Closed ':t.claimable&&t.admin?'Previous assignee unavailable · Updated ':'Updated ')+date(t.closed||t.updated),
     status:status(t.closed?'closed':t.claimable?'unassigned':'assigned'),
     action:t.closed?'View ticket':'Open ticket',
     open:()=>openUserTicket(t.id)
    })));
    listView=!archived;
   }else if(view==='Groups'){
    renderGroupDirectory(data,token);
   }else if(view==='Shop reviews'){
    renderShopReviews(data,token);listView=true;
   }else if(view==='Sellers'){
     const controls=el('div','','cc-actions');controls.append(action('Generate Seller key',async()=>{const result=await api('sellers/generate',{});if(!alive(token))return;const d=el('dialog','','cc-seller-dialog');d.append(el('h2','Seller key generated'),el('p','Save this one-time activation secret privately.','cc-muted'),el('code',result.key,'cc-secret'),action('Copy key',()=>navigator.clipboard.writeText(result.key)),button('Done',()=>{d.close();d.remove();},'cc-secondary'));main.append(d);d.addEventListener('close',()=>d.remove());d.showModal();}));main.append(controls);
     for(const p of data.items){
      const n=card((p.name||'Seller')+' · '+p.account.slice(0,8),[status(p.active?'active':'revoked'),details([
       ['Account',p.account],['Created',date(p.created)],['Current connection code',p.code],['Next rotation',date(p.rotates)],['Verification',p.verified?'Verified':'Not verified']
      ])]);
      if(p.verified)n.append(el('span','Verified seller','cc-seller-mark'));
      n.append(button('Change display name',()=>editSellerName(p,token),'cc-secondary'));
      if(p.code)n.append(action('Copy connection code',()=>navigator.clipboard.writeText(p.code),'cc-secondary'),action('Rotate connection code',async()=>{
       if(!await modalConfirm('Rotate this seller’s code? The old code stops working immediately.'))return;
       await api('sellers/rotate',{id:p.account});toast('Connection code rotated','success');if(alive(token))await load();
      },'cc-secondary'));
      n.append(action(p.revoked?'Restore seller access':'Suspend seller',async()=>{
       if(!await modalConfirm(p.revoked?'Restore seller access?':'Suspend this seller’s access?'))return;
       await api('sellers/access',{id:p.account,suspended:!p.revoked});toast('Seller access updated','success');if(alive(token))await load();
      },'cc-secondary'),action(p.verified?'Revoke verification':'Verify Seller',async()=>{
       await api('sellers/verify',{id:p.account,verified:!p.verified});if(alive(token))await load();
      },p.verified?'cc-danger':''));
      main.append(n);
     }
    listView=true;
   }else if(view==='Monitoring'){renderMonitoring(data,token);}else if(view==='Overview'){
    renderOverview(data);
   }else if(view==='Accounts'){
    main.append(search('Account ID, case reference, key ID or fingerprint'));
    main.append(caseQueue('Account directory',data.items,a=>({
     title:a.id,
     description:a.access_plan+' · '+(a.last_activity?'Last activity '+date(a.last_activity):'No recent activity')+' · '+a.reports+' reports',
     status:accountBadges(a),
     action:'Open account',
     open:()=>openAccount(a.id)
    }),'No matching accounts.'));
    if(data.items.length===100)main.append(button('Next page',()=>{cursor=data.items.at(-1).id;load();},'cc-secondary'));
    listView=true;
   }else if(view==='Keys'){
    renderKeys(data,token);
   }else if(view==='Payments'){
    if(!archived)main.append(queuePicker('Payment queue',[['all','All payments'],['review','Needs review']]));
    for(const p of data.items){
     const expired=p.state==='pending'&&p.expires<=Date.now();
     const manual=p.state==='submitted'&&!p.coin;
     const badge=p.needsReview||manual?el('span',manual?'Legacy manual review':'Needs review','cc-status yellow'):status(expired?'expired':p.state);
     const n=card(p.id,[badge,details([['Plan',p.plan],['Network',p.coin||'LTC (legacy)'],['Price',p.usd_cents==null?'€'+(p.eur_cents/100).toFixed(2):'$'+(p.usd_cents/100).toFixed(2)],['Expires',date(p.expires)],['Transaction',p.txid],['Confirmations',p.confirmations],['Verified',date(p.verified_at)],['Account',p.redeemed_account]])]);
     if(manual)n.append(el('p','Review this legacy order in the developer payment CLI.','cc-muted'));
     if(!archived&&p.coin&&p.state==='submitted')n.append(action('Recheck transaction',async()=>{
      const result=await api('payments/verify',{id:p.id});
      if(!alive(token))return;
      toast(result.verified?'Payment verified':'Payment is still unverified',result.verified?'success':'info');
      await load();
     },'cc-secondary'));
     if(archived||p.state==='rejected'||expired||(p.state==='confirmed'&&p.redeemed))n.append(archiveAction('payments',p.id,archived));
     main.append(n);
    }
   }else if(view==='Payment tickets'){
    const open=data.items.filter(t=>!['completed','rejected'].includes(t.status)),done=data.items.filter(t=>['completed','rejected'].includes(t.status));
    const entry=t=>{
     const ready=t.state==='confirmed'&&!t.ticket_released&&!t.closed;
     const badge=ready||t.needsReview?el('span',ready?'Ready to release':'Needs review','cc-status yellow'):status(t.status);
     return {
      title:'Payment ticket · '+t.id.slice(0,8),
      description:t.plan+' · $'+(t.usd_cents/100).toFixed(2)+' '+t.coin+' · Updated '+date(t.updated),
      status:badge,
      open:()=>openPaymentTicket(t.id),
      extra:['completed','rejected'].includes(t.status)?archiveAction('payment-tickets',t.id,archived):null
     };
    };
    if(!archived)main.append(caseQueue('Open payment tickets',open,entry));
    main.append(caseQueue(archived?'Archived payment tickets':'Completed payment tickets',done,entry));
    listView=!archived;
   }else if(view==='Reports'){
    const pending=data.items.filter(item=>!item.resolved),resolved=data.items.filter(item=>item.resolved);
    const entry=r=>({
     title:r.reason+' · '+r.id.slice(0,8),
     description:'Received '+date(r.created)+' · '+(r.previousReports||0)+' previous reports'+
       (r.followUpStatus==='awaiting-reporter'?' · Waiting for reporter':r.followUpStatus==='reporter-replied'?' · Evidence submitted':''),
     status:status(r.resolved?'solved':r.workflow||'inspection'),
     action:'Review report',
     open:()=>openReportCase(r.id)
    });
    if(!archived)main.append(caseQueue('Reports to review',pending,entry));
    main.append(caseQueue(archived?'Archived reports':'Resolved reports',resolved,entry));
    listView=!archived;
   }else if(view==='Feedback'){
    for(const f of data.items){const note=el('textarea');note.placeholder='Internal support note';note.maxLength=1000;const n=card('Feedback #'+f.id,[status(f.workflow||'inspection'),el('p',date(f.at),'cc-muted'),el('p',f.text)]);for(const e of f.events||[])n.append(el('p','Admin '+(e.actor||'Deleted')+' · '+e.status+' · '+e.note,'cc-muted'));if(!archived&&f.workflow!=='solved'){n.append(note);for(const [value,label] of [['inspection','Under Inspection'],['help','Need Additional Help'],['solved','Solved']])n.append(action(label,async()=>{await api('feedback/status',{id:f.id,status:value,note:note.value});await load();},value==='help'?'cc-danger':''));}if(f.workflow==='solved')n.append(archiveAction('feedback',f.id,archived));main.append(n);}
   }else if(view==='Support'){
    if(!archived){
     main.append(caseQueue('Deletion requests',data.deletions||[],r=>({
      title:(r.kind==='contact'?'Contact':'Conversation')+' deletion · '+r.id.slice(0,8),
      description:'Requested '+date(r.at),
      status:status('pending'),
      action:'Approve deletion',
      open:async()=>{
       if(!await modalConfirm(r.kind==='contact'?'Delete the contact and shared chats for both participants?':'Delete the conversation for both participants?')||!alive(token))return;
       try{
        await api('support/delete',{id:r.id,confirmed:true});
        toast('Deletion completed','success');if(alive(token))await load();
       }catch(e){error(e);}
      }
     })));
     main.append(caseQueue('Pending support', (data.requests||[]).filter(r=>!r.deletionRequested),r=>({
      title:'Support request · '+r.id.slice(0,8),
      description:'Requested '+date(r.at),
      status:status('pending'),
      action:'Open request',
      open:()=>openSupportCase(r.id)
     })),caseQueue('Active support',data.rooms||[],r=>({
      title:'Support conversation · '+r.id.slice(0,8),
      description:r.messages.at(-1)?'Last reply '+date(r.messages.at(-1).at):'No messages yet',
      status:status('active'),
      open:()=>openSupportCase(r.id)
     })));
    }
    main.append(caseQueue(archived?'Archived support':'Completed support',data.finished||[],r=>({
     title:'Support case · '+r.id.slice(0,8),
     description:'Updated '+date(r.at),
     status:status(r.status),
     open:()=>openSupportCase(r.id,archived),
     extra:archiveAction('support',r.id,archived)
    })));
    listView=!archived;
   }else if(view==='Audit'){
    const filters=el('div','','cc-audit-filters');
    const types=select([['','All records'],['report','Reports'],['support','Support'],['ticket','User tickets'],['payment-ticket','Payment tickets'],['account','Accounts'],['payment','Payments'],['key','Access keys'],['seller','Sellers'],['feedback','Feedback'],['announcement','Announcements']]);
    const outcomes=select([['','All outcomes'],['success','Successful'],['rejected','Rejected']]);
    types.value=auditType;types.setAttribute('aria-label','Audit record type');
    outcomes.value=auditOutcome;outcomes.setAttribute('aria-label','Audit outcome');
    for(const picker of [types,outcomes])picker.addEventListener('change',()=>{auditType=types.value;auditOutcome=outcomes.value;cursor='';load(null,picker.getAttribute('aria-label'));});
    filters.append(types,outcomes);
    main.append(search('Search admin ID, record ID or action'),filters);
    const list=el('section','','cc-audit-list');
    for(const a of data.items){
     const event=card(displayAction(a),[status(a.outcome==='success'?'success':'rejected'),details([
      ['Admin',a.actor],['Record type',caseNames[a.target_type]||a.target_type],['Record ID',a.target],['Related account',a.related],
      ['Decision',statusLabels[a.detail]||a.detail],['Source',a.source],['Time',date(a.at)]
     ])]);
     if(a.target)event.append(recordId(a.target,'record ID'));
     list.append(event);
    }
    if(!data.items.length)list.append(el('p','No matching audit events.','cc-muted'));
    main.append(list);
    if(data.items.length===100)main.append(button('Older events',()=>{cursor=String(data.items.at(-1).id);load();},'cc-secondary'));
    if(data.legacy?.length&&!auditType&&!auditOutcome&&!query){
     const history=el('details','','cc-legacy-audit');history.append(el('summary','Earlier administration records'));
     for(const event of data.legacy)history.append(card(displayAction(event),[details([['Admin',event.actor],['Account',event.account],['Key',event.key_id],['At',date(event.at)],['Reason',event.reason]])]));
     main.append(history);
    }
   }
   if(Array.isArray(data.items)&&!data.items.length&&['Feedback','Payments','Sellers'].includes(view))main.append(el('p',view==='Payments'&&scope!=='all'?'Nothing in this queue.':'No records yet.','cc-muted'));
   if(focusQueue){
    const control=focusQueue===true?main.querySelector('.cc-queue-picker'):[...main.querySelectorAll('select,button')].find(node=>(node.getAttribute('aria-label')||node.textContent)===focusQueue&&!node.disabled);
    (control||main.querySelector('.cc-key-pages button:not(:disabled)'))?.focus({preventScroll:true});
   }
  }catch(e){if(alive(token)){main.replaceChildren(el('h2',current),button('Retry',load));error(e);}}
 }
 load();pollInbox();
 return {close:stop};
}
window.QzuControl={mount};
const desktop=document.getElementById('controlRoot');if(!desktop)return;
async function api(path,data){
 const response=await fetch('/api/control/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-QZU':'1'},body:data===undefined?undefined:JSON.stringify(data),credentials:'same-origin',cache:'no-store'});
 const value=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(Error(value.error||'Request failed.'),{status:response.status});return value;
}
async function media(id){const r=await fetch('/api/control/reports/media/'+encodeURIComponent(id),{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw Error('Evidence unavailable.');return r.blob();}
function login(){
 desktop.className='cc-root';desktop.replaceChildren();
 const form=el('form','','cc-pair'),field=input('Admin key','password'),pin=input('Admin PIN (if already registered)','password');
 field.maxLength=58;field.required=true;pin.maxLength=6;pin.inputMode='numeric';
 const message=el('p','Use your mobile login PIN if the admin key is registered on a phone.','cc-muted');
 message.setAttribute('role','status');
 const brand=el('h1','qzu.');brand.append(el('span',' Control','cc-accent'));
 const submit=el('button','Sign in securely','cc-button');form.append(brand,el('h2','Administrator sign-in'),field,pin,message,submit);desktop.append(form);
 form.addEventListener('submit',async e=>{e.preventDefault();submit.disabled=true;try{await api('login',{key:field.value.trim().toUpperCase(),pin:pin.value});field.value='';pin.value='';mount(desktop,api,{onExit:login,media});}catch(e){message.textContent=e.message;pin.value='';}finally{submit.disabled=false;}});
}
if(/Macintosh/i.test(navigator.userAgent)&&navigator.maxTouchPoints>1){desktop.replaceChildren(el('h1','Desktop only'),el('p','Open qzu. Control on a Windows or Mac computer.'));}else api('overview').then(()=>mount(desktop,api,{onExit:login,media})).catch(login);
})();
