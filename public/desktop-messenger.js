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
async function identity(admin){
 const key='identity:'+admin;let pair=await vault(key);
 if(!pair){pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);await vault(key,pair);}
 const publicKey=b64(await crypto.subtle.exportKey('raw',pair.publicKey));
 const sign=async message=>({publicKey,signature:der(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,encoder.encode(message)))});
 const proof=await sign(JSON.stringify(['qzu-room-key-v1','desktop:'+admin,publicKey]));
 return {sign,record:{identity:publicKey,key:publicKey,signature:proof.signature}};
}
window.QzuDesktopMessenger=async function mount(root,api,alive){
 const err=el('p','','cc-error'),layout=el('div','','cc-messenger'),sidebar=el('aside','','cc-messenger-side'),thread=el('section','','cc-messenger-thread'),list=el('div','','cc-messenger-list'),messages=el('div','','cc-messenger-messages'),header=el('h3','Private chats'),status=el('p','','cc-muted'),code=el('code','','cc-secret'),contact=el('input'),draft=el('textarea'),actions=el('div','','cc-actions');
 contact.placeholder='6-character connection code';contact.maxLength=6;draft.placeholder='Write encrypted message…';draft.maxLength=2000;draft.disabled=true;
 let selected=null,latest=null,busy=false,polling=false,localIdentity=null,admin=null,context=null,ready=false,signature='',pending=null;
 const drafts=new Map(),keys=new Map();
 const action=(label,fn,cls='cc-secondary')=>{const b=el('button',label,'cc-button '+cls);b.type='button';b.onclick=async()=>{if(!alive()||busy)return;busy=true;b.disabled=true;err.textContent='';try{await fn();}catch(e){if(alive())err.textContent=e.message;}finally{busy=false;if(alive())b.disabled=false;}};return b;};
 const refresh=async()=>{if(!alive()||polling||busy)return;polling=true;try{const d=await api('chats');if(!alive())return;latest=d;await draw();err.textContent='';}catch(e){if(alive())err.textContent=e.message;}finally{polling=false;}};
 const choose=id=>{if(selected)drafts.set(selected,draft.value);selected=id;draft.value=drafts.get(id)||'';context=null;ready=false;pending=null;signature='';draw().catch(e=>{if(alive())err.textContent=e.message;});};
 const verify=action('Confirm safety code',async()=>{if(!context||!selected)throw Error('Waiting for peer encryption key.');const entered=prompt('Compare this code with your contact. Type the matching safety code:\n'+context.code);if(entered?.trim().toUpperCase()!==context.code)throw Error('Safety code not confirmed.');await api('chats/confirm',{id:selected,code:context.code});},'');
 const send=action('Send',async()=>{if(!selected||!context||!ready||!draft.value.trim())return;const id=selected,text=draft.value.trim();if(!pending||pending.id!==id||pending.text!==text){pending={id,text,requestId:crypto.randomUUID(),cipher:await QzuCrypto.encrypt(context,text)};}await api('chats/send',{id,cipher:pending.cipher,requestId:pending.requestId});if(selected===id&&draft.value.trim()===text)draft.value='';pending=null;},'');
 const connect=action('Connect',async()=>{const result=await api('chats/connect',{code:contact.value.trim().toUpperCase(),nickname:'Contact'});contact.value='';if(result.id)choose(result.id);});
 const copy=action('Copy my code',()=>navigator.clipboard.writeText(latest.invite.code));
 const reset=action('Reset browser identity',async()=>{if(!confirm('Reset the desktop messenger? Existing desktop private chats and contacts will be removed. Mobile account data is unaffected.'))return;await api('chats/reset',{confirmed:true});await vault('identity:'+admin,null);location.reload();},'cc-danger');
 actions.append(verify,send);sidebar.append(el('h3','Your desktop connection code'),code,copy,contact,connect,list,reset);thread.append(header,status,messages,draft,actions);layout.append(sidebar,thread);root.append(err,layout);
 async function draw(){
  if(!alive()||!latest)return;
  code.textContent=latest.invite?.code||'Unavailable';copy.disabled=!latest.invite;
  list.replaceChildren();
  for(const r of latest.requests.filter(x=>x.incoming)){const box=el('div','','cc-card');box.append(el('p','Connection request'),action('Accept',async()=>{const x=await api('chats/respond',{id:r.id,accept:true,nickname:'Contact'});if(x.id)choose(x.id);}),action('Decline',()=>api('chats/respond',{id:r.id,accept:false})));list.append(box);}
  for(const r of latest.rooms){const n=el('button',r.contact?.nickname||'Chat '+r.id.slice(0,4),'cc-button cc-secondary');if(r.peerRole==='admin'||r.peerRole==='verified-seller')n.append(el('span',' ✓',r.peerRole==='admin'?'cc-admin-mark':'cc-seller-mark'));n.onclick=()=>choose(r.id);list.append(n);}
  for(const c of latest.contacts.filter(c=>!latest.rooms.some(r=>r.contact?.id===c.id)))list.append(action(c.nickname,async()=>{const x=await api('chats/contact',{id:c.id});choose(x.id);}));
  const r=latest.rooms.find(r=>r.id===selected);ready=false;context=null;draft.disabled=true;verify.hidden=true;send.disabled=true;
  if(!r){header.textContent='Private chats';status.textContent='Choose a chat or connect using a code.';messages.replaceChildren();return;}
  const id=r.id;header.textContent=r.contact?.nickname||'Private chat';status.textContent='Connecting securely…';
  let local=keys.get(id)||await vault('room:'+admin+':'+id);
  if(!alive()||selected!==id)return;
  if(!local){if(r.encryption.own){status.textContent='Encryption key unavailable. Start a new chat.';return;}local=await QzuCrypto.generate(id,localIdentity.sign);await vault('room:'+admin+':'+id,local);}
  if(!alive()||selected!==id)return;keys.set(id,local);
  if(!r.encryption.own){await api('chats/key',{id,record:local.record});return;}
  if(!r.encryption.peer)return;
  if(r.contact?.peerIdentity&&r.contact.peerIdentity!==r.encryption.peer.identity){status.textContent='Contact identity changed. Verification required in the original client.';return;}
  const established=await QzuCrypto.establish(id,local,r.encryption.own,r.encryption.peer);if(!alive()||selected!==id)return;
  context=established;ready=Boolean(r.encryption.confirmed&&(r.encryption.offline||r.encryption.peerConfirmed));verify.hidden=r.encryption.confirmed;draft.disabled=!ready;send.disabled=!ready;
  status.textContent=ready?'End-to-end encrypted':r.encryption.confirmed?'Waiting for contact to confirm':'Compare safety code: '+context.code;
  const fp=JSON.stringify([id,r.messages,ready]);if(signature===fp)return;
  const fragment=document.createDocumentFragment();
  for(const m of r.messages){
   const text=m.deleted?'Message removed':m.once?'View once — open on supported mobile client':m.kind!=='text'?'Encrypted attachment — desktop preview unavailable':m.cipher?await QzuCrypto.decrypt(context,m.cipher,m.mine).catch(()=> 'Encrypted message unavailable'):'Encrypted message unavailable';
   const row=el('div','','cc-bubble '+(m.mine?'mine':'other'));row.append(el('p',text),el('small',new Date(m.at).toLocaleTimeString()));fragment.append(row);
  }
  if(!alive()||selected!==id)return;signature=fp;const bottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;messages.replaceChildren(fragment);if(bottom)messages.scrollTop=messages.scrollHeight;
 }
 try{admin=(await api('inbox')).adminId;localIdentity=await identity(admin);if(!alive())return;await api('chats/identity',{record:localIdentity.record});await refresh();}
 catch(e){if(alive())err.textContent=e.message;}
 async function tick(){if(!alive())return;if(!document.hidden)await refresh();if(alive())setTimeout(tick,3000);}
 setTimeout(tick,3000);
};
})();
