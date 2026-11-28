'use strict';
(()=>{
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
const encoder=new TextEncoder();
function der(raw){const r=new Uint8Array(raw);if(r.length!==64)throw Error('Invalid browser signature.');const ints=[r.slice(0,32),r.slice(32)].map(a=>{let i=0;while(i<a.length-1&&a[i]===0)i++;a=a.slice(i);return a[0]&128?[2,a.length+1,0,...a]:[2,a.length,...a];});const all=ints.flat();return b64([48,all.length,...all]);}
function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open('qzu-desktop-messenger-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('keys');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function vault(key,value){
 const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('keys',value===undefined?'readonly':'readwrite'),store=tx.objectStore('keys'),r=value===undefined?store.get(key):value===null?store.delete(key):store.put(value,key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
async function pruneVault(admin,active){
 const db=await database();try{await new Promise((resolve,reject)=>{const tx=db.transaction('keys','readwrite'),store=tx.objectStore('keys'),r=store.openCursor(),prefix='room:'+admin+':';r.onsuccess=()=>{const c=r.result;if(c){if(typeof c.key==='string'&&c.key.startsWith(prefix)&&!active.has(c.key.slice(prefix.length)))c.delete();c.continue();}};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
async function identity(admin){
 const key='identity:'+admin;let pair=await vault(key);
 if(!pair){pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);await vault(key,pair);}
 const publicKey=b64(await crypto.subtle.exportKey('raw',pair.publicKey));
 const sign=async message=>({publicKey,signature:der(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,encoder.encode(message)))});
 const proof=await sign(JSON.stringify(['qzu-room-key-v1','desktop:'+admin,publicKey]));
 return {sign,record:{identity:publicKey,key:publicKey,signature:proof.signature}};
}
window.QzuDesktopMessenger=async function mount(root,api,alive,{error:reportError,confirm:confirmAction}={}){
 const fail=e=>{if(alive())reportError?.(e);};

 const err=el('p','','cc-error'),layout=el('div','','cc-messenger'),sidebar=el('aside','','cc-messenger-side'),thread=el('section','','cc-messenger-thread'),list=el('div','','cc-messenger-list'),messages=el('div','','cc-messenger-messages'),header=el('h3','Private chats'),status=el('p','','cc-muted'),code=el('code','','cc-secret'),contact=el('input'),draft=el('textarea'),actions=el('div','','cc-actions');
 contact.placeholder='6-character connection code';contact.maxLength=6;draft.placeholder='Write encrypted message…';draft.maxLength=2000;draft.disabled=true;
 let lastPollError='';let selected=null,latest=null,busy=false,polling=false,localIdentity=null,admin=null,context=null,ready=false,signature='',pending=null,drawEpoch=0,onceMode=false;const roomJobs=new Map(),roomErrors=new Map();
 const drafts=new Map(),keys=new Map(),scrollPositions=new Map();let listSignature='',renderedId=null;const search=el('input'),toolbar=el('div','','cc-chat-toolbar'),heading=el('div','','cc-chat-heading'),profile=el('div','','cc-chat-profile'),profileText=el('div','','cc-chat-profile-text'),composer=el('div','','cc-chat-composer'),empty=el('div','Choose a contact to start messaging.','cc-chat-empty');search.type='search';search.placeholder='Search contacts';search.setAttribute('aria-label','Search contacts');
 function nameFor(item){return item.peerRole==='admin'?'qzu-Support':item.peerName||item.contact?.nickname||item.nickname||'Contact';}
 function badge(role){const b=el('span','✓','cc-chat-verified '+(role==='verified-seller'?'seller':'admin'));b.setAttribute('role','img');b.setAttribute('aria-label',role==='verified-seller'?'Verified Seller':'Verified Admin');return b;}
 function avatar(item){const a=el('span','','cc-chat-avatar'+(item?.peerRole==='admin'?' cc-chat-admin-avatar':''));a.setAttribute('aria-hidden','true');return a;}
 function named(node,item){node.replaceChildren(el('span',nameFor(item)));if(['admin','verified-seller'].includes(item.peerRole))node.append(badge(item.peerRole));}
 function preview(m){return !m?'Start a new chat':m.deleted?'Message removed':m.once?(m.opened?'Opened':'View once'):m.kind==='image'?'Photo':m.kind==='audio'?'Voice message':'Encrypted message';}
 const action=(label,fn,cls='cc-secondary')=>{const b=el('button',label,'cc-button '+cls);b.type='button';b.onclick=async()=>{if(!alive()||busy)return;busy=true;b.disabled=true;err.textContent='';try{await fn();}catch(e){fail(e);}finally{busy=false;if(alive())b.disabled=b===send&&!ready;}};return b;};
 const refresh=async()=>{if(!alive()||polling||busy)return;polling=true;try{const d=await api('chats');if(!alive())return;latest=d;const active=new Set(d.rooms.map(r=>r.id));for(const id of keys.keys())if(!active.has(id))keys.delete(id);for(const id of roomErrors.keys())if(!active.has(id))roomErrors.delete(id);await pruneVault(admin,active);await draw();await prepareOtherRooms();lastPollError='';}catch(e){if(lastPollError!==e.message){lastPollError=e.message;fail(e);}}finally{polling=false;}};
 const choose=id=>{if(selected===id)return;if(selected){drafts.set(selected,draft.value);scrollPositions.set(selected,messages.scrollTop);}selected=id;draft.value=drafts.get(id)||'';context=null;ready=false;pending=null;onceMode=false;onceButton.textContent='View once: off';onceButton.setAttribute('aria-pressed','false');signature='';renderedId=null;messages.replaceChildren();draw().catch(e=>{fail(e);});};

 const send=action('Send',async()=>{if(!selected||!context||!ready||!draft.value.trim())return;const id=selected,text=draft.value.trim();if(onceMode){const cipher=await QzuCrypto.encrypt(context,text);if(!alive()||selected!==id||document.hidden)throw Error('Chat unavailable.');await api('chats/once/send',{id,cipher});draft.value='';onceMode=false;onceButton.textContent='View once: off';onceButton.setAttribute('aria-pressed','false');return;}if(!pending||pending.id!==id||pending.text!==text){pending={id,text,requestId:crypto.randomUUID(),cipher:await QzuCrypto.encrypt(context,text)};}if(!alive()||selected!==id||document.hidden)throw Error('Chat unavailable.');await api('chats/send',{id,cipher:pending.cipher,requestId:pending.requestId});if(selected===id&&draft.value.trim()===text)draft.value='';pending=null;},'');
 const onceButton=el('button','View once: off','cc-button cc-secondary');onceButton.type='button';onceButton.setAttribute('aria-pressed','false');onceButton.onclick=()=>{onceMode=!onceMode;onceButton.textContent='View once: '+(onceMode?'on':'off');onceButton.setAttribute('aria-pressed',String(onceMode));};
 const attachment=el('input');attachment.type='file';attachment.accept='image/png,image/jpeg,image/webp,audio/webm,audio/mp4,audio/ogg';attachment.hidden=true;
 const attach=action('Attach',async()=>{if(!ready)throw Error('Secure connection is not ready yet.');attachment.click();});
 attachment.onchange=async()=>{const file=attachment.files?.[0];attachment.value='';if(!file||!ready||busy||!context||!selected)return;const id=selected,ctx=context,once=onceMode;busy=true;try{const kind=file.type.startsWith('image/')?'image':'audio';const clean=kind==='image'?await QzuMetadata.cleanImage(file):file;const cipher=await QzuCrypto.encryptMedia(ctx,kind,clean);if(!alive()||id!==selected||document.hidden)throw Error('Chat changed.');await api('chats/media/send',{id,kind,cipher,once});onceMode=false;onceButton.textContent='View once: off';onceButton.setAttribute('aria-pressed','false');}catch(e){fail(e);}finally{busy=false;}};
 async function viewAttachment(room,m,ctx,once){
  if(!alive()||selected!==room||document.hidden)return;
  const data=await api(once?'chats/once':'chats/media',{id:room,messageId:m.id});if(!alive()||selected!==room||document.hidden)return;
  const d=el('dialog','','cc-seller-dialog');let url=null;
  if(data.kind==='text'){d.append(el('p',await QzuCrypto.decrypt(ctx,data.cipher,false)));}
  else{const blob=await QzuCrypto.decryptMedia(ctx,data.kind,data.cipher,m.mine);if(!alive()||selected!==room||document.hidden)return;url=URL.createObjectURL(blob);const media=el(data.kind==='image'?'img':'audio');media.src=url;if(data.kind==='audio')media.controls=true;media.className='cc-evidence';d.append(media);}
  if(!alive()||selected!==room||document.hidden){if(url)URL.revokeObjectURL(url);return;}
  const close=()=>{if(d.open)d.close();};const b=el('button','Close','cc-button cc-secondary');b.onclick=close;d.append(b);root.append(d);
  const observer=new MutationObserver(()=>{if(!d.isConnected||!alive())cleanup();});const cleanup=()=>{observer.disconnect();if(url){URL.revokeObjectURL(url);url=null;}document.removeEventListener('visibilitychange',hide);d.replaceChildren();d.remove();};const hide=()=>{if(document.hidden)close();};document.addEventListener('visibilitychange',hide);d.addEventListener('close',cleanup,{once:true});observer.observe(document.body,{childList:true,subtree:true});d.showModal();
 }
 const connect=action('Connect',async()=>{const value=contact.value.trim().toUpperCase();if(!/^[A-Z0-9]{6}$/.test(value))throw Error('Enter a valid 6-character connection code.');const result=await api('chats/connect',{code:value,nickname:'Contact'});contact.value='';if(addDialog.open)addDialog.close();if(result.id)choose(result.id);else status.textContent='Connection request sent';});
 const copy=action('Copy my code',()=>{if(!latest?.invite?.code)throw Error('Connection code unavailable.');return navigator.clipboard.writeText(latest.invite.code);});
 const addDialog=el('dialog','','cc-modal cc-chat-add'),add=el('button','+ Add contact','cc-button'),closeAdd=el('button','Close','cc-button cc-secondary');add.type=closeAdd.type='button';add.onclick=()=>{if(alive()&&!addDialog.open){addDialog.showModal();contact.focus();}};closeAdd.onclick=()=>addDialog.close();contact.addEventListener('input',()=>{contact.value=contact.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);});contact.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();connect.click();}});addDialog.append(el('h3','Add contact'),el('p','Enter a connection code to start a conversation.','cc-muted'),contact,connect,el('h4','Your connection code'),code,copy,closeAdd);
 const remove=action('Delete chat',async()=>{const id=selected;if(!id||!await confirmAction?.('Permanently delete this conversation for both participants?'))return;if(!alive()||selected!==id)return;await api('chats/delete',{id,confirmed:true});await vault('room:'+admin+':'+id,null);keys.delete(id);drafts.delete(id);draft.value='';selected=null;context=null;ready=false;pending=null;messages.replaceChildren();},'cc-danger');remove.hidden=true;
 async function deleteContact(id){if(!id||!await confirmAction?.('Delete this contact and all shared private chats for both participants?'))return;if(!alive())return;await api('chats/contact/delete',{id,confirmed:true});const removed=latest.rooms.filter(r=>r.contact?.id===id).map(r=>r.id);for(const room of removed){keys.delete(room);drafts.delete(room);scrollPositions.delete(room);await vault('room:'+admin+':'+room,null);}if(removed.includes(selected)){selected=null;context=null;ready=false;pending=null;draft.value='';messages.replaceChildren();}latest.rooms=latest.rooms.filter(r=>!removed.includes(r.id));latest.contacts=latest.contacts.filter(c=>c.id!==id);await draw();}
 const deletePeer=action('Delete Contact',()=>deleteContact(latest?.rooms.find(r=>r.id===selected)?.contact?.id),'cc-danger');deletePeer.hidden=true;
 const reset=action('Reset browser identity',async()=>{if(!await confirmAction?.('Reset the desktop messenger? Existing desktop private chats and contacts will be removed. Mobile account data is unaffected.'))return;await api('chats/reset',{confirmed:true});await vault('identity:'+admin,null);await pruneVault(admin,new Set());location.reload();},'cc-danger');
 const settings=el('details','','cc-chat-settings');settings.append(el('summary','Messenger settings'),el('p','Resetting removes this browser’s existing encrypted chats.','cc-muted'),reset);toolbar.append(el('h3','Contacts'),add);sidebar.append(toolbar,search,list,settings);profileText.append(header,status);profile.append(avatar(),profileText);const deletionActions=el('div','','cc-chat-deletion-actions');deletionActions.append(remove,deletePeer);heading.append(profile,deletionActions);actions.append(attach,onceButton,attachment,send);composer.append(draft,actions);thread.append(heading,messages,composer);layout.append(sidebar,thread);root.append(layout,addDialog);draft.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(ready&&!busy)send.click();}});search.addEventListener('input',()=>{listSignature='';renderContacts();});
 async function getLocalRoomKey(r){
  const id=r.id;
  if(!roomJobs.has(id))roomJobs.set(id,(async()=>{let local=keys.get(id)||await vault('room:'+admin+':'+id);if(!local&&!r.encryption.own){local=await QzuCrypto.generate(id,localIdentity.sign);await vault('room:'+admin+':'+id,local);}if(local)keys.set(id,local);return local;})());
  const job=roomJobs.get(id);let local;try{local=await job;}finally{if(roomJobs.get(id)===job)roomJobs.delete(id);}return local;
 }
 async function prepareOtherRooms(){
  for(const r of latest.rooms.filter(r=>r.id!==selected&&!r.encryption.confirmed&&(!r.encryption.own||r.encryption.peer)).slice(0,2)){
   if(!alive()||document.hidden||busy)return;
   try{const local=await getLocalRoomKey(r);if(!alive()||document.hidden)return;if(!local)continue;
   if(!r.encryption.own){await api('chats/key',{id:r.id,record:local.record});continue;}
   if(!r.encryption.peer||r.contact?.peerIdentity&&r.contact.peerIdentity!==r.encryption.peer.identity)continue;
   const ctx=await QzuCrypto.establish(r.id,local,r.encryption.own,r.encryption.peer);if(!alive()||document.hidden)return;
   await api('chats/confirm',{id:r.id,code:ctx.code});roomErrors.delete(r.id);
   }catch(e){if(roomErrors.get(r.id)!==e.message){roomErrors.set(r.id,e.message);fail(e);}}
  }
 }
 function renderContacts(){
  if(!alive()||!latest)return;const q=search.value.trim().toLowerCase(),incoming=latest.requests.filter(x=>x.incoming),rooms=latest.rooms.filter(r=>nameFor(r).toLowerCase().includes(q)),saved=latest.contacts.filter(c=>!latest.rooms.some(r=>r.contact?.id===c.id)&&nameFor(c).toLowerCase().includes(q));const fp=JSON.stringify([q,selected,incoming,rooms.map(r=>[r.id,nameFor(r),r.peerRole,r.activeCount,r.messages.at(-1)?.id,r.messages.at(-1)?.opened,r.messages.at(-1)?.deleted,r.messages.filter(m=>m.unread).length]),saved]);if(fp===listSignature)return;listSignature=fp;const top=list.scrollTop;list.replaceChildren();
  if(incoming.length&&!q){list.append(el('div','Requests · '+incoming.length,'cc-chat-section'));for(const r of incoming){const box=el('div','','cc-chat-request');box.append(el('p','Connection request'),action('Accept',async()=>{const x=await api('chats/respond',{id:r.id,accept:true,nickname:'Contact'});if(x.id)choose(x.id);}),action('Decline',()=>api('chats/respond',{id:r.id,accept:false})));list.append(box);}}
  function row(item,isRoom){const last=isRoom?item.messages.at(-1):null,n=el('button','','cc-chat-contact'+(isRoom&&selected===item.id?' selected':'')),info=el('span','','cc-chat-contact-info'),name=el('span','','cc-chat-name'),meta=el('span',last?new Date(last.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'','cc-chat-meta');n.type='button';if(isRoom&&selected===item.id)n.setAttribute('aria-current','true');named(name,item);info.append(name,el('span',preview(last),'cc-chat-preview'));n.append(avatar(item),info,meta);const unread=isRoom?item.messages.filter(m=>m.unread).length:0;if(unread)meta.append(el('span',String(Math.min(unread,99))+(unread>99?'+':''),'cc-chat-unread'));n.onclick=async()=>{if(busy)return;if(isRoom){choose(item.id);return;}busy=true;try{const x=await api('chats/contact',{id:item.id});if(alive())choose(x.id);}catch(e){fail(e);}finally{busy=false;}};return n;}
  if(rooms.length){list.append(el('div','Chats','cc-chat-section'));for(const r of rooms)list.append(row(r,true));}if(saved.length){list.append(el('div','Saved contacts','cc-chat-section'));for(const c of saved){const wrap=el('div','','cc-saved-contact-row');wrap.append(row(c,false),action('Delete Contact',()=>deleteContact(c.id),'cc-danger'));list.append(wrap);}}if(!rooms.length&&!saved.length)list.append(el('p',q?'No matching contacts.':'No conversations yet. Add a contact to get started.','cc-chat-list-empty'));list.scrollTop=top;
 }
 async function draw(){
  if(!alive()||!latest)return;const epoch=++drawEpoch;
  code.textContent=latest.invite?.code||'Unavailable';copy.disabled=!latest.invite;
  renderContacts();
  const r=latest.rooms.find(r=>r.id===selected);remove.hidden=!r;deletePeer.hidden=!r?.contact;composer.hidden=!r;profile.firstElementChild.hidden=!r;
  if(!r){renderedId=null;signature='';ready=false;context=null;draft.disabled=true;send.disabled=true;header.textContent='Messages';status.textContent='Select a conversation';messages.replaceChildren(empty);return;}
  const id=r.id;profile.firstElementChild.classList.toggle('cc-chat-admin-avatar',r.peerRole==='admin');named(header,r);if(!ready||renderedId!==id){draft.disabled=true;send.disabled=true;status.textContent='Connecting securely…';}
  const local=await getLocalRoomKey(r);
  if(!alive()||selected!==id||epoch!==drawEpoch)return;
  if(!local){ready=false;context=null;draft.disabled=send.disabled=true;status.textContent='Encryption key unavailable. Start a new chat.';return;}
  if(!r.encryption.own){ready=false;context=null;draft.disabled=send.disabled=true;await api('chats/key',{id,record:local.record});return;}
  if(!r.encryption.peer){ready=false;context=null;draft.disabled=send.disabled=true;return;}
  if(r.contact?.peerIdentity&&r.contact.peerIdentity!==r.encryption.peer.identity){ready=false;context=null;draft.disabled=send.disabled=true;messages.replaceChildren();status.textContent='Contact identity changed. Verification required in the original client.';return;}
  let established;try{established=await QzuCrypto.establish(id,local,r.encryption.own,r.encryption.peer);}catch(e){if(alive()&&selected===id&&epoch===drawEpoch){ready=false;context=null;draft.disabled=send.disabled=true;messages.replaceChildren();status.textContent='Secure connection unavailable';}throw e;}if(!alive()||selected!==id||epoch!==drawEpoch)return;
  if(!r.encryption.confirmed){await api('chats/confirm',{id,code:established.code});if(!alive()||selected!==id||epoch!==drawEpoch)return;r.encryption.confirmed=true;}
  context=established;ready=Boolean(r.encryption.confirmed&&(r.encryption.offline||r.encryption.peerConfirmed));draft.disabled=!ready;send.disabled=!ready;
  status.textContent=ready?'End-to-end encrypted'+(r.activeCount?' · Active':' · Offline'):'Connecting securely · waiting for the contact’s app';
  const fp=JSON.stringify([id,r.messages,ready]);if(signature===fp)return;
  const fragment=document.createDocumentFragment();
  for(const m of r.messages){
   const text=m.deleted?'Message removed':m.once?(m.opened?'Opened':'View once'):m.kind!=='text'?'Encrypted attachment':m.cipher?await QzuCrypto.decrypt(context,m.cipher,m.mine).catch(()=> 'Encrypted message unavailable'):'Encrypted message unavailable';
   const row=el('div','','cc-bubble '+(m.mine?'mine':'other'));const stamp=el('small',new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),'cc-chat-stamp');if(m.mine){const tick=el('span',m.status==='sent'?'✓':'✓✓','cc-chat-tick'+(m.status==='read'?' read':''));tick.setAttribute('aria-label',m.status||'sent');stamp.append(tick);}row.append(el('p',text),stamp);if(ready&&!m.deleted&&((m.once&&!m.opened&&!m.mine)||(!m.once&&m.kind!=='text'&&m.encryptedMedia)))row.append(action(m.once?'Open once':'Open attachment',()=>viewAttachment(id,m,established,m.once)));fragment.append(row);
  }
  if(!alive()||selected!==id||epoch!==drawEpoch)return;signature=fp;const changed=renderedId!==id,top=messages.scrollTop,bottom=messages.scrollHeight-top-messages.clientHeight<80;messages.replaceChildren(fragment);renderedId=id;messages.scrollTop=changed?(scrollPositions.get(id)??messages.scrollHeight):bottom?messages.scrollHeight:top;if(ready&&!document.hidden){const ids=r.messages.filter(m=>!m.mine&&!m.once&&!m.deleted&&m.unread).slice(0,50).map(m=>m.id);if(ids.length)await api('chats/receipts',{id,ids});}
 }
 try{admin=(await api('inbox')).adminId;localIdentity=await identity(admin);if(!alive())return;await api('chats/identity',{record:localIdentity.record});await refresh();}
 catch(e){fail(e);}
 async function tick(){if(!alive())return;if(!document.hidden)await refresh();if(alive())setTimeout(tick,3000);}
 setTimeout(tick,3000);
};
})();
