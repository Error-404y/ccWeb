'use strict';
(()=>{
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const button=(label,fn,cls='')=>{const b=el('button',label,'cc-button '+cls);b.type='button';b.addEventListener('click',fn);return b;};
const date=x=>x?new Date(x).toLocaleString():'—';
const input=(placeholder,type='text')=>{const n=el('input');n.type=type;n.placeholder=placeholder;n.setAttribute('aria-label',placeholder);n.autocomplete='off';return n;};
const select=(options)=>{const n=el('select');for(const [value,label] of options){const o=el('option',label);o.value=value;n.append(o);}return n;};
const statusLabels={help:'Needs help',inspection:'In review',review:'In review',solved:'Resolved',closed:'Closed',active:'Active',confirmed:'Verified',completed:'Completed',accepted:'Accepted',submitted:'Submitted',pending:'Pending',unassigned:'Unassigned',assigned:'Assigned',open:'Open',expired:'Expired',rejected:'Rejected',suspended:'Suspended',revoked:'Revoked',success:'Success'};
const status=(value)=>el('span',statusLabels[value]||String(value??'Unknown'), 'cc-status '+(['help','expired','rejected','suspended','revoked'].includes(value)?'red':['solved','active','confirmed','accepted','success','completed'].includes(value)?'green':['pending','inspection','review','submitted','unassigned'].includes(value)?'yellow':'neutral'));
const caseNames={report:'Report',support:'Support',ticket:'User ticket','payment-ticket':'Payment ticket'};
const caseRoute=(type,id)=>'cases/'+encodeURIComponent(type)+'/'+encodeURIComponent(id);
const plans=[['1W','1 Week'],['1M','1 Month'],['1Y','1 Year'],['LT','Lifetime']];
const sections=[
 ['Workspace',['Overview','Chats','Announcements']],
 ['Inbox',['Tickets','Support','Payment tickets','Reports','Feedback']],
 ['Management',['Accounts','Keys','Sellers','Payments']],
 ['Operations',['Monitoring','Audit','Archive']]
];
function mount(root,api,{mobile=false,isActive=()=>root.isConnected,onExit=()=>{},media=null,mobileChat=null,initialTab=null}={}){
 root.classList.add('cc-root');root.replaceChildren();
 const groupFor=tab=>sections.find(([,tabs])=>tabs.includes(tab))?.[0];
 let revision=0,current=groupFor(initialTab)?initialTab:location.pathname==='/control/monitoring'?'Monitoring':'Overview';
 let query='',scope='all',cursor='',auditType='',auditOutcome='',objectURL=null,closed=false,archiveTab='Reports',listView=false,listSignature='',pollingInbox=false,updateOverview=null;
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
 function stop(){closed=true;revision++;clearInterval(inboxTimer);if(objectURL)URL.revokeObjectURL(objectURL);root.replaceChildren();}
 function navigate(tab,nextScope='all',nextQuery=''){if(mobile&&tab==='Chats'&&mobileChat){stop();mobileChat();return;}current=tab;query=nextQuery;cursor='';scope=nextScope;if(tab!=='Accounts')lookupField.value='';if(!mobile&&location.pathname==='/control/monitoring'&&tab!=='Monitoring')history.replaceState(null,'','/control');else if(!mobile&&tab==='Monitoring')history.replaceState(null,'','/control/monitoring');load();}
 function updateCount(tab,count){const n=tabs.get(tab).lastElementChild;n.textContent=count>0?String(count):'';n.hidden=!count;}
 function routeFor(view,archived=false){
  const route=view==='Payment tickets'?'payment-tickets':view.toLowerCase();
  if(archived)return route+'?archived=1';
  if(['Tickets','Payments'].includes(view))return route+'?scope='+encodeURIComponent(scope);
  if(!['Accounts','Keys','Audit'].includes(view))return route;
  const filters=new URLSearchParams({q:query});
  if(cursor)filters.set(view==='Audit'?'before':'after',cursor);
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
 function details(rows){const d=el('dl','','cc-details');for(const [k,v] of rows){d.append(el('dt',k),el('dd',String(v??'—')));}return d;}
 function card(title,children=[]){const n=el('article','','cc-card');n.append(el('h3',title),...children);return n;}
 function action(label,run,cls=''){return button(label,async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;try{await run();}catch(e){error(e);}finally{if(b.dataset.locked!=='1')b.disabled=false;}},cls);}
 function secret(title,value){const box=card(title,[el('p','Save this secret privately. It is displayed only here.'),el('code',value,'cc-secret'),action('Copy',()=>navigator.clipboard.writeText(value))]);main.prepend(box);}
 function search(placeholder){const form=el('form','','cc-search'),field=input(placeholder);field.value=query;field.maxLength=128;const b=el('button','Search','cc-button');form.append(field,b);form.addEventListener('submit',e=>{e.preventDefault();query=field.value.trim();cursor='';load();});return form;}
 function confirmAction(title,fn,{plan=false}={}){
  const box=card(title);const reason=input('Reason (required)');reason.maxLength=500;const picker=select(plans);if(plan)box.append(picker);box.append(reason,action('Confirm',async()=>{if(!reason.value.trim())throw Error('Enter a reason.');await fn(reason.value.trim(),picker.value);await load();},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary'));main.prepend(box);
 }
 function displayAction(event){
  const names={
   'reports/resolve':'Resolved report','reports/collaborate':'Updated report review',
   'support/respond':'Responded to support request','support/finish':'Updated support status',
   'support/send':'Replied to support case','support/delete':'Approved deletion',
   'tickets/action':'Updated ticket','tickets/send':'Replied to ticket',
   'payment-tickets/release':'Released access key','payment-tickets/verify':'Checked payment',
   'cases/claim':'Claimed case','cases/unassign':'Released assignment','cases/note':'Added an internal note',
   note:'Added an internal note','accounts/view':'Viewed account'
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
  if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
  const head=el('div','','cc-detail-header'),name=el('h2',title);
  name.tabIndex=-1;
  head.append(button(backLabel,back,'cc-secondary cc-compact-button'),name);
  main.replaceChildren(head);
  name.focus();
  return {token,name};
 }
 function splitDetail(content,sidebar){
  const layout=el('div','','cc-detail-layout'),primary=el('div','','cc-detail-primary');
  primary.append(...content);
  layout.append(primary,sidebar);
  return layout;
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
   if(data.accountId)actions.append(button('Open account',()=>openAccount(data.accountId,back),'cc-secondary'));
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
 function accountState(account){return account.suspended?'suspended':account.access_revoked?'revoked':account.access.active?'active':'expired';}
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
   const {account,cases=[],activity=[],audit=[]}=await api('accounts/'+encodeURIComponent(id));
   if(!alive(token))return;
   loading.remove();
   const summary=card('Account',[status(accountState(account)),recordId(id,'account ID'),details([
    ['Access plan',account.access_plan],['Access ends',date(account.paid_until)],['Last activity',date(account.last_activity)],
    ['Messaging restriction ends',date(account.restricted_until)],['Suspension ends',date(account.suspended_until)],
    ['Recovery configured',account.recovery_created?'Yes':'No'],['Activation key ID',account.key_id],['Reports',account.reports]
   ])]);
   const controls=accountActions(account,()=>openAccount(id,back));
   if(controls.childElementCount)summary.append(controls);
   const related=card('Related cases');
   if(!cases.length)related.append(el('p','No related cases.','cc-muted'));
   for(const item of cases){
    const row=el('div','','cc-account-case');
    const name=el('div','','cc-account-case-label');
    name.append(el('strong',item.title||caseNames[item.type]||'Case'),el('small',(caseNames[item.type]||'Case')+' · '+date(item.at),'cc-muted'));
    row.append(name,status(item.status));
    if(item.canOpen!==false&&Object.hasOwn(caseNames,item.type))row.append(button('Open case',()=>openLinkedCase(item,()=>openAccount(id,back)),'cc-secondary cc-compact-button'));
    related.append(row);
   }
   const trail=el('aside','','cc-case-sidebar');
   trail.append(el('h3','Account activity'),timeline(activity),el('h3','Administrative actions'),timeline(audit));
   main.append(splitDetail([summary,related],trail));
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
 async function openReportCase(id,back=()=>load()){
  const {token}=detailView('Report details',back),loading=el('p','Loading report…','cc-muted');
  main.append(loading);
  try{
   const investigation=await api(caseRoute('report',id));
   if(!alive(token))return;
   const report=investigation.record;
   if(!report)throw Error('Report unavailable.');
   loading.remove();
   const reopen=()=>openReportCase(id,back);
   const metadata=card(report.reason,[status(report.resolved?'solved':report.workflow||'inspection'),details([
    ['Received',date(report.created)],['Reported account',report.target],['Reporter',report.reporter],['Previous reports',report.previousReports]
   ]),el('p',report.evidence||'No additional details','cc-case-note')]);
   if(report.reporter&&report.reporter!==report.target)metadata.append(button('Open reporter account',()=>openAccount(report.reporter,reopen),'cc-secondary'));
   const context=card('Submitted evidence');
   if(!report.context?.length&&!report.attachment)context.append(el('p','No messages or attachments were included.','cc-muted'));
   if(report.context?.length){
    const snapshot=el('div','','cc-snapshot');
    for(const message of report.context){
     const bubble=el('div','','cc-bubble '+(message.sender==='Reporter'?'mine':'other')+(message.reported?' flagged':''));
     bubble.append(el('small',message.sender+' · '+date(message.at)),el('p',message.text),el('small',message.source==='reporter-submitted'?'Reporter submitted':'Server confirmed'));
     snapshot.append(bubble);
    }
    context.append(snapshot);
   }
   if(report.attachment&&media){
    const slot=el('div','','cc-report-attachment');
    const reveal=action('View submitted attachment',async()=>{
     const blob=await media(report.id);
     if(!alive(token))return;
     if(objectURL)URL.revokeObjectURL(objectURL);
     objectURL=URL.createObjectURL(blob);
     const node=el(report.attachment.kind==='image'?'img':'audio');
     node.src=objectURL;node.className='cc-evidence';
     if(node.tagName==='AUDIO')node.controls=true;
     else node.alt='Submitted report evidence';
     slot.replaceChildren(node);
    },'cc-secondary');
    slot.append(reveal);context.append(slot);
   }
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
   main.append(splitDetail([metadata,context,controls],activity.panel));
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
  const metrics=el('div','','cc-metrics cc-overview-metrics');
  for(const [label,value] of [
   ['Active accounts',data.active],['Total accounts',data.accounts],['Admin accounts',data.admins],
   ['Unused access keys',data.keys],['Verified USD revenue','$'+(data.revenue/100).toFixed(2)]
  ]){
   const metric=el('article','','cc-metric');
   metric.append(el('strong',String(value??'—')),el('span',label));
   metrics.append(metric);
  }
  const directory=el('section','','cc-queue');
  directory.append(el('h3','Account and payment totals'),metrics);
  main.append(queue,directory);
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
  listView=false;updateOverview=null;const token=++revision;if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
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
   }else if(view==='Sellers'){
     const controls=el('div','','cc-actions');controls.append(action('Generate Seller key',async()=>{const result=await api('sellers/generate',{});if(!alive(token))return;const d=el('dialog','','cc-seller-dialog');d.append(el('h2','Seller key generated'),el('p','Save this one-time activation secret privately.','cc-muted'),el('code',result.key,'cc-secret'),action('Copy key',()=>navigator.clipboard.writeText(result.key)),button('Done',()=>{d.close();d.remove();},'cc-secondary'));main.append(d);d.addEventListener('close',()=>d.remove());d.showModal();}));main.append(controls);
     for(const p of data.items){const n=card((p.name||'Seller')+' · '+p.account.slice(0,8),[status(p.active?'active':'revoked'),details([['Account',p.account],['Created',date(p.created)],['Current connection code',p.code],['Next rotation',date(p.rotates)],['Verification',p.verified?'Verified':'Not verified']])]);if(p.verified)n.append(el('span','Verified seller','cc-seller-mark'));if(p.code)n.append(action('Copy connection code',()=>navigator.clipboard.writeText(p.code),'cc-secondary'),action('Rotate connection code',async()=>{if(!await modalConfirm('Rotate this seller’s code? The old code stops working immediately.'))return;await api('sellers/rotate',{id:p.account});toast('Connection code rotated','success');if(alive(token))await load();},'cc-secondary'));n.append(action(p.revoked?'Restore seller access':'Suspend seller',async()=>{if(!await modalConfirm(p.revoked?'Restore seller access?':'Suspend this seller’s access?'))return;await api('sellers/access',{id:p.account,suspended:!p.revoked});toast('Seller access updated','success');if(alive(token))await load();},'cc-secondary'));n.append(action(p.verified?'Revoke verification':'Verify Seller',async()=>{await api('sellers/verify',{id:p.account,verified:!p.verified});if(alive(token))await load();},p.verified?'cc-danger':''));main.append(n);}
    listView=true;
   }else if(view==='Monitoring'){renderMonitoring(data,token);}else if(view==='Overview'){
    renderOverview(data);
   }else if(view==='Accounts'){
    main.append(search('Account ID, case reference, key ID or fingerprint'));
    main.append(caseQueue('Account directory',data.items,a=>({
     title:a.id,
     description:a.access_plan+' · '+(a.last_activity?'Last activity '+date(a.last_activity):'No recent activity')+' · '+a.reports+' reports',
     status:status(accountState(a)),
     action:'Open account',
     open:()=>openAccount(a.id)
    }),'No matching accounts.'));
    if(data.items.length===100)main.append(button('Next page',()=>{cursor=data.items.at(-1).id;load();},'cc-secondary'));
   }else if(view==='Keys'){
    main.append(button('Sellers',()=>navigate('Sellers'),'cc-secondary'),search('Key ID, fingerprint or account ID'));const picker=select(plans),count=input('Quantity (1–100)','number');count.min='1';count.max='100';count.value='1';
    main.append(card('Generate access keys',[picker,count,action('Generate',async()=>{const result=await api('keys/generate',{plan:picker.value,count:Number(count.value)});await load();secret('New access keys',result.keys.map(k=>k.key+' · '+k.id).join('\n'));})]));
    for(const k of data.items){const state=k.state==='revoked'?'revoked':k.redeemed?'redeemed':'unused';const n=card(k.fingerprint?'QZU-••••-'+k.fingerprint:k.id,[status(state),details([['ID',k.id],['Plan',k.plan],['Created',date(k.created)],['Activated',date(k.redeemed)],['Account',k.account]])]);
     if(!k.redeemed&&k.generated&&k.state==='confirmed'){n.append(button('Replace unused key',()=>{const box=card('Replace key?',[el('p','The previous secret will stop working.'),action('Replace',async()=>{const result=await api('keys/replace',{id:k.id});await load();secret('Replacement key',result.key);},'cc-danger'),button('Cancel',()=>box.remove(),'cc-secondary')]);main.prepend(box);}),button('Revoke',()=>confirmAction('Revoke unused key',reason=>api('keys/revoke',{id:k.id,reason})),'cc-secondary'));}
     main.append(n);
    }
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
     description:'Received '+date(r.created)+' · '+(r.previousReports||0)+' previous reports',
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
    const picker=focusQueue===true?main.querySelector('.cc-queue-picker'):[...main.querySelectorAll('select')].find(control=>control.getAttribute('aria-label')===focusQueue);
    picker?.focus({preventScroll:true});
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
