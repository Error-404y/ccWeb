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
 let lastPollError='';let selected=null,latest=null,busy=false,polling=false,localIdentity=null,admin=null,context=null,ready=false,signature='',pending=null,drawEpoch=0,onceMode=false;const roomJobs=new Map();
 const drafts=new Map(),keys=new Map();
 const action=(label,fn,cls='cc-secondary')=>{const b=el('button',label,'cc-button '+cls);b.type='button';b.onclick=async()=>{if(!alive()||busy)return;busy=true;b.disabled=true;err.textContent='';try{await fn();}catch(e){fail(e);}finally{busy=false;if(alive())b.disabled=false;}};return b;};
 const refresh=async()=>{if(!alive()||polling||busy)return;polling=true;try{const d=await api('chats');if(!alive())return;latest=d;const active=new Set(d.rooms.map(r=>r.id));for(const id of keys.keys())if(!active.has(id))keys.delete(id);await pruneVault(admin,active);await draw();await prepareOtherRooms();lastPollError='';}catch(e){if(lastPollError!==e.message){lastPollError=e.message;fail(e);}}finally{polling=false;}};
 const choose=id=>{if(selected)drafts.set(selected,draft.value);selected=id;draft.value=drafts.get(id)||'';context=null;ready=false;pending=null;onceMode=false;onceButton.textContent='View once: off';signature='';draw().catch(e=>{fail(e);});};

 const send=action('Send',async()=>{if(!selected||!context||!ready||!draft.value.trim())return;const id=selected,text=draft.value.trim();if(onceMode){const cipher=await QzuCrypto.encrypt(context,text);if(!alive()||selected!==id||document.hidden)throw Error('Chat unavailable.');await api('chats/once/send',{id,cipher});draft.value='';onceMode=false;onceButton.textContent='View once: off';return;}if(!pending||pending.id!==id||pending.text!==text){pending={id,text,requestId:crypto.randomUUID(),cipher:await QzuCrypto.encrypt(context,text)};}if(!alive()||selected!==id||document.hidden)throw Error('Chat unavailable.');await api('chats/send',{id,cipher:pending.cipher,requestId:pending.requestId});if(selected===id&&draft.value.trim()===text)draft.value='';pending=null;},'');
 const onceButton=el('button','View once: off','cc-button cc-secondary');onceButton.type='button';onceButton.onclick=()=>{onceMode=!onceMode;onceButton.textContent='View once: '+(onceMode?'on':'off');};
 const attachment=el('input');attachment.type='file';attachment.accept='image/png,image/jpeg,image/webp,audio/webm,audio/mp4,audio/ogg';attachment.hidden=true;
 const attach=action('Attach',async()=>{if(!ready)throw Error('Secure connection is not ready yet.');attachment.click();});
 attachment.onchange=async()=>{const file=attachment.files?.[0];attachment.value='';if(!file||!ready||busy||!context||!selected)return;const id=selected,ctx=context,once=onceMode;busy=true;try{const kind=file.type.startsWith('image/')?'image':'audio';const clean=kind==='image'?await QzuMetadata.cleanImage(file):file;const cipher=await QzuCrypto.encryptMedia(ctx,kind,clean);if(!alive()||id!==selected||document.hidden)throw Error('Chat changed.');await api('chats/media/send',{id,kind,cipher,once});onceMode=false;onceButton.textContent='View once: off';}catch(e){fail(e);}finally{busy=false;}};
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
 const connect=action('Connect',async()=>{const result=await api('chats/connect',{code:contact.value.trim().toUpperCase(),nickname:'Contact'});contact.value='';if(result.id)choose(result.id);});
 const copy=action('Copy my code',()=>navigator.clipboard.writeText(latest.invite.code));
 const reset=action('Reset browser identity',async()=>{if(!await confirmAction?.('Reset the desktop messenger? Existing desktop private chats and contacts will be removed. Mobile account data is unaffected.'))return;await api('chats/reset',{confirmed:true});await vault('identity:'+admin,null);await pruneVault(admin,new Set());location.reload();},'cc-danger');
 actions.append(onceButton,attach,send,attachment);sidebar.append(el('h3','Your desktop connection code'),code,copy,contact,connect,list,reset);thread.append(header,status,messages,draft,actions);layout.append(sidebar,thread);root.append(layout);
 async function getLocalRoomKey(r){
  const id=r.id;
  if(!roomJobs.has(id))roomJobs.set(id,(async()=>{let local=keys.get(id)||await vault('room:'+admin+':'+id);if(!local&&!r.encryption.own){local=await QzuCrypto.generate(id,localIdentity.sign);await vault('room:'+admin+':'+id,local);}if(local)keys.set(id,local);return local;})());
  const job=roomJobs.get(id);let local;try{local=await job;}finally{if(roomJobs.get(id)===job)roomJobs.delete(id);}return local;
 }
 async function prepareOtherRooms(){
  for(const r of latest.rooms.filter(r=>r.id!==selected&&!r.encryption.confirmed&&(!r.encryption.own||r.encryption.peer)).slice(0,2)){
   if(!alive()||document.hidden||busy)return;
   try{const local=await getLocalRoomKey(r);if(!local||!alive()||document.hidden)return;
   if(!r.encryption.own){await api('chats/key',{id:r.id,record:local.record});continue;}
   if(!r.encryption.peer||r.contact?.peerIdentity&&r.contact.peerIdentity!==r.encryption.peer.identity)continue;
   const ctx=await QzuCrypto.establish(r.id,local,r.encryption.own,r.encryption.peer);if(!alive()||document.hidden)return;
   await api('chats/confirm',{id:r.id,code:ctx.code});
   }catch(e){if(lastPollError!==e.message){lastPollError=e.message;fail(e);}}
  }
 }
 async function draw(){
  if(!alive()||!latest)return;const epoch=++drawEpoch;
  code.textContent=latest.invite?.code||'Unavailable';copy.disabled=!latest.invite;
  list.replaceChildren();
  for(const r of latest.requests.filter(x=>x.incoming)){const box=el('div','','cc-card');box.append(el('p','Connection request'),action('Accept',async()=>{const x=await api('chats/respond',{id:r.id,accept:true,nickname:'Contact'});if(x.id)choose(x.id);}),action('Decline',()=>api('chats/respond',{id:r.id,accept:false})));list.append(box);}
  for(const r of latest.rooms){const n=el('button',r.contact?.nickname||'Chat '+r.id.slice(0,4),'cc-button cc-secondary');if(r.peerRole==='admin'||r.peerRole==='verified-seller')n.append(el('span',' ✓',r.peerRole==='admin'?'cc-admin-mark':'cc-seller-mark'));n.onclick=()=>{if(!busy)choose(r.id);};list.append(n);}
  for(const c of latest.contacts.filter(c=>!latest.rooms.some(r=>r.contact?.id===c.id)))list.append(action(c.nickname,async()=>{const x=await api('chats/contact',{id:c.id});choose(x.id);}));
  const r=latest.rooms.find(r=>r.id===selected);ready=false;context=null;draft.disabled=true;send.disabled=true;
  if(!r){header.textContent='Private chats';status.textContent='Choose a chat or connect using a code.';messages.replaceChildren();return;}
  const id=r.id;header.textContent=r.contact?.nickname||'Private chat';status.textContent='Connecting securely…';
  const local=await getLocalRoomKey(r);
  if(!alive()||selected!==id||epoch!==drawEpoch)return;
  if(!local){status.textContent='Encryption key unavailable. Start a new chat.';return;}
  if(!r.encryption.own){await api('chats/key',{id,record:local.record});return;}
  if(!r.encryption.peer)return;
  if(r.contact?.peerIdentity&&r.contact.peerIdentity!==r.encryption.peer.identity){status.textContent='Contact identity changed. Verification required in the original client.';return;}
  const established=await QzuCrypto.establish(id,local,r.encryption.own,r.encryption.peer);if(!alive()||selected!==id||epoch!==drawEpoch)return;
  if(!r.encryption.confirmed){await api('chats/confirm',{id,code:established.code});if(!alive()||selected!==id||epoch!==drawEpoch)return;r.encryption.confirmed=true;}
  context=established;ready=Boolean(r.encryption.confirmed&&(r.encryption.offline||r.encryption.peerConfirmed));draft.disabled=!ready;send.disabled=!ready;
  status.textContent=ready?'End-to-end encrypted':'Connecting securely · waiting for the contact’s app';
  const fp=JSON.stringify([id,r.messages,ready]);if(signature===fp)return;
  const fragment=document.createDocumentFragment();
  for(const m of r.messages){
   const text=m.deleted?'Message removed':m.once?(m.opened?'Opened':'View once'):m.kind!=='text'?'Encrypted attachment':m.cipher?await QzuCrypto.decrypt(context,m.cipher,m.mine).catch(()=> 'Encrypted message unavailable'):'Encrypted message unavailable';
   const row=el('div','','cc-bubble '+(m.mine?'mine':'other'));row.append(el('p',text),el('small',new Date(m.at).toLocaleTimeString()));if(ready&&!m.deleted&&((m.once&&!m.opened&&!m.mine)||(!m.once&&m.kind!=='text'&&m.encryptedMedia)))row.append(action(m.once?'Open once':'Open attachment',()=>viewAttachment(id,m,established,m.once)));fragment.append(row);
  }
  if(!alive()||selected!==id||epoch!==drawEpoch)return;signature=fp;const bottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;messages.replaceChildren(fragment);if(bottom)messages.scrollTop=messages.scrollHeight;if(ready&&!document.hidden){const ids=r.messages.filter(m=>!m.mine&&!m.once&&!m.deleted&&m.unread).slice(0,50).map(m=>m.id);if(ids.length)await api('chats/receipts',{id,ids});}
 }
 try{admin=(await api('inbox')).adminId;localIdentity=await identity(admin);if(!alive())return;await api('chats/identity',{record:localIdentity.record});await refresh();}
 catch(e){fail(e);}
 async function tick(){if(!alive())return;if(!document.hidden)await refresh();if(alive())setTimeout(tick,3000);}
 setTimeout(tick,3000);
};
})();
