'use strict';
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const svg=(name,cls)=>{const node=document.createElementNS('http://www.w3.org/2000/svg','svg');if(cls)node.setAttribute('class',cls);node.setAttribute('aria-hidden','true');const use=document.createElementNS(node.namespaceURI,'use');use.setAttribute('href','#'+name);node.append(use);return node;};
const page=location.pathname==='/settings'?'settings':location.pathname==='/connect'?'connect':'chat';
const mobile=matchMedia('(max-width:700px)');
let state={rooms:[],invite:null,pinState:null,resetRequest:null},offset=0,selected=null,mobileOpen=false,sequence=0,started=false,renderedRoom=null,renderedMessages=[],contactKey='',qrKey='',pinPrompt=false,stream=null,scanFrame=0,scannerLoad=null,modalLocked=false,online=true;
const modal=$('modal'),body=$('modalBody');
const fmtTime=ms=>new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'}).format(new Date(ms));
const clock=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
const serverNow=()=>Date.now()+offset;
const nameFor=r=>'Chat '+r.id.slice(0,4).toUpperCase();
function stopCamera(){cancelAnimationFrame(scanFrame);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}}
function closeModal(){if(modalLocked)return;stopCamera();if(modal.open)modal.close();body.replaceChildren();}
$('modalClose').addEventListener('click',closeModal);
modal.addEventListener('cancel',e=>{e.preventDefault();closeModal();});
modal.addEventListener('close',()=>{stopCamera();body.replaceChildren();modalLocked=false;});
function show(title,content,locked=false){
 stopCamera();modalLocked=locked;$('modalClose').hidden=locked;$('modalTitle').textContent=title;body.replaceChildren(...content);
 if(!modal.open)modal.showModal();
}
function button(text,fn,cls='primary-button'){const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;}
function info(title,message){show(title,[el('p','',message),button('OK',closeModal)]);}
function errorMessage(error){return error instanceof Error?error.message:'Try again.';}
function showError(error){info('qzu.',errorMessage(error));}
function modalError(error){let p=body.querySelector('.modal-error');if(!p){p=el('p','modal-error');body.append(p);}p.textContent=errorMessage(error);}
async function api(path,data){
 const write=data!==undefined;
 if(write)sequence++;
 let res;
 try{res=await fetch('/api/'+path,{method:write?'POST':'GET',headers:write?{'Content-Type':'application/json','X-QZU':'1'}:{},body:write?JSON.stringify(data):undefined,cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(8000)});}
 catch{throw new Error('Connection unavailable.');}
 const result=await res.json().catch(()=>({}));
 if(!res.ok)throw new Error(result.error||'Try again.');
 return result;
}
function applyTheme(value){document.documentElement.dataset.theme=value;try{localStorage.setItem('qzu-theme',value);}catch{}}
let theme='system';try{theme=localStorage.getItem('qzu-theme')||'system';}catch{}
if(!['system','light','dark'].includes(theme))theme='system';
applyTheme(theme);$('theme').value=theme;
$('theme').addEventListener('change',()=>applyTheme($('theme').value));
function setViewport(){const h=window.visualViewport?.height||window.innerHeight;document.documentElement.style.setProperty('--app-height',Math.round(h)+'px');}
setViewport();window.addEventListener('resize',setViewport);window.visualViewport?.addEventListener('resize',setViewport);
function selectRoom(id,open=true){
 if(selected!==id){$('message').value='';$('send').disabled=true;}
 selected=id;mobileOpen=open;renderedRoom=null;renderChat();
}
function renderChat(){
 if(page!=='chat')return;
 const now=serverNow(),rooms=state.rooms.filter(r=>r.expires>now);
 if(!rooms.some(r=>r.id===selected)){
  if(selected!==null){$('message').value='';$('send').disabled=true;mobileOpen=false;}
  selected=!mobile.matches?rooms[0]?.id||null:null;
 }
 const current=rooms.find(r=>r.id===selected);
 $('chatPage').classList.toggle('thread-open',Boolean(current&&mobileOpen));
 $('chatCount').textContent=rooms.length?String(rooms.length):'';
 const key=JSON.stringify(rooms.map(r=>[r.id,r.messages.at(-1)?.id,r.id===selected]));
 if(key!==contactKey){
  contactKey=key;const list=$('contacts'),top=list.scrollTop;list.replaceChildren();
  if(!rooms.length){const box=el('div','empty-list');box.append(el('p','','No chats'));const a=el('a','subtle-link','New chat');a.href='/connect';box.append(a);list.append(box);}
  for(const r of rooms){
   const last=r.messages.at(-1),b=el('button','contact'+(r.id===selected?' active':''));b.type='button';
   const content=el('div','contact-body');content.append(el('span','contact-name',nameFor(r)),el('span','contact-preview',last?last.text:'New chat'));
   b.append(svg('avatar','avatar'),content,el('span','contact-time',fmtTime(last?.at||r.created)));
   b.addEventListener('click',()=>selectRoom(r.id));list.append(b);
  }
  list.scrollTop=top;
 }
 $('emptyThread').hidden=Boolean(current);
 for(const id of ['threadHeader','messages','composer'])$(id).hidden=!current;
 if(!current){$('messages').replaceChildren();renderedRoom=null;renderedMessages=[];return;}
 $('threadName').textContent=nameFor(current);$('chatTimer').textContent=clock(current.expires-now);
 const container=$('messages'),ids=current.messages.map(m=>m.id);
 const sameRoom=renderedRoom===current.id;
 const appendOnly=sameRoom&&renderedMessages.length<=ids.length&&renderedMessages.every((v,i)=>ids[i]===v);
 if(appendOnly&&renderedMessages.length===ids.length)return;
 const follow=!sameRoom||container.scrollHeight-container.scrollTop-container.clientHeight<100||current.messages.at(-1)?.mine;
 if(!appendOnly)container.replaceChildren();
 const start=appendOnly?renderedMessages.length:0;
 for(const m of current.messages.slice(start)){
  const row=el('div','message-row'+(m.mine?' mine':''));const bubble=el('div','bubble',m.text);
  bubble.append(el('span','bubble-time',fmtTime(m.at)));row.append(bubble);container.append(row);
 }
 renderedRoom=current.id;renderedMessages=ids;
 if(follow)container.scrollTop=container.scrollHeight;
}
function renderConnect(){
 if(page!=='connect')return;
 const inv=state.invite&&state.invite.expires>serverNow()?state.invite:null;
 $('inviteCode').textContent=inv?.code||'– – – – – –';
 $('inviteTimer').textContent=inv?clock(inv.expires-serverNow()):'No active code';
 $('copyCode').disabled=!inv;
 const key=inv?inv.code+':'+inv.expires:'';
 if(key!==qrKey){qrKey=key;$('qrImage').hidden=!inv;$('qrPlaceholder').hidden=Boolean(inv);
  if(inv)$('qrImage').src='/api/qr?v='+inv.expires;else $('qrImage').removeAttribute('src');
 }
}
function renderSettings(){
 if(page!=='settings')return;
 $('resetPin').disabled=!state.pinState;
 $('emergency').disabled=!state.pinState;
}
function render(){renderChat();renderConnect();renderSettings();}
function purgeExpired(){
 const now=serverNow();
 if(state.rooms.some(r=>r.expires<=now)||state.invite&&state.invite.expires<=now){
  state.rooms=state.rooms.filter(r=>r.expires>now);if(state.invite?.expires<=now)state.invite=null;render();
 }
 const room=state.rooms.find(r=>r.id===selected);
 if(room)$('chatTimer').textContent=clock(room.expires-now);
 if(page==='connect'&&state.invite)$('inviteTimer').textContent=clock(state.invite.expires-now);
}
function clearVolatile(){
 sequence++;state.rooms=[];state.invite=null;selected=null;mobileOpen=false;
 $('message').value='';$('send').disabled=true;render();
}
async function refresh(){
 const ticket=++sequence;const data=await api('state');
 if(ticket!==sequence||document.hidden)return;
 online=true;offset=data.now-Date.now();state=data;
 if(page==='chat'&&!selected){let target=null;try{target=sessionStorage.getItem('qzu-open');sessionStorage.removeItem('qzu-open');}catch{}
  if(target&&data.rooms.some(r=>r.id===target)){selected=target;mobileOpen=true;}
 }
 render();purgeExpired();
 if(['new','approved'].includes(state.pinState)&&!pinPrompt&&!modal.open)offerPin();
}
function offerPin(){
 pinPrompt=true;
 const first=state.pinState==='new';
 const action=button('Generate PIN',async()=>{
  action.disabled=true;
  try{
   const result=await api('pin/issue',{});
   state.pinState='active';
   const done=button('Saved',()=>{modalLocked=false;closeModal();refresh().catch(()=>{});});
   show('Your PIN',[el('p','','Save this PIN. It is shown only once.'),el('strong','pin-display',result.pin),done],true);
   if(first)api('invite',{}).then(()=>refresh()).catch(()=>{});
  }catch(e){action.disabled=false;modalError(e);}
 });
 show('Security PIN',[el('p','','One-time PIN for emg.exe.'),action],true);
}
$('backToChats').addEventListener('click',()=>{mobileOpen=false;selected=null;renderedRoom=null;$('message').value='';$('send').disabled=true;renderChat();});
mobile.addEventListener('change',()=>{if(!mobile.matches)mobileOpen=false;renderChat();});
$('message').addEventListener('input',()=>{$('send').disabled=!$('message').value.trim();});
$('message').addEventListener('keydown',e=>{if(!mobile.matches&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}});
$('composer').addEventListener('submit',async e=>{
 e.preventDefault();const id=selected,text=$('message').value.trim();if(!id||!text||$('send').disabled)return;
 $('send').disabled=true;
 try{await api('message',{id,text});if(selected===id&&$('message').value.trim()===text)$('message').value='';await refresh();}
 catch(err){showError(err);}finally{$('send').disabled=!$('message').value.trim();}
});
$('deleteChat').addEventListener('click',()=>{
 const id=selected;if(!id)return;
 const confirm=button('Delete for both',async()=>{confirm.disabled=true;try{await api('chat/delete',{id});closeModal();clearVolatile();await refresh();}catch(e){confirm.disabled=false;modalError(e);}},'primary-button danger-button');
 show('Delete chat?',[el('p','','This removes the conversation for both participants.'),confirm,button('Cancel',closeModal,'secondary-button')]);
});
$('newCode').addEventListener('click',async()=>{
 $('newCode').disabled=true;try{await api('invite',{});await refresh();}catch(e){showError(e);}finally{$('newCode').disabled=false;}
});
$('copyCode').addEventListener('click',async()=>{
 const inv=state.invite;if(!inv||inv.expires<=serverNow())return;
 try{await navigator.clipboard.writeText(inv.code);info('Copied',inv.code);}catch{info('Your code',inv.code);}
});
$('enterCode').addEventListener('input',()=>{$('enterCode').value=$('enterCode').value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);});
$('connectForm').addEventListener('submit',async e=>{
 e.preventDefault();const code=$('enterCode').value.trim();if(!/^[A-Z0-9]{6}$/.test(code)){info('Connect','Enter a 6-character code.');return;}
 const submit=$('connectForm').querySelector('button');submit.disabled=true;
 try{const result=await api('connect',{code});try{sessionStorage.setItem('qzu-open',result.id);}catch{}location.assign('/chat');}
 catch(err){showError(err);submit.disabled=false;}
});
function loadScanner(){
 if(window.jsQR)return Promise.resolve();
 if(!scannerLoad)scannerLoad=new Promise((resolve,reject)=>{const script=el('script');script.src='/vendor/jsqr.js';script.onload=resolve;script.onerror=()=>{script.remove();scannerLoad=null;reject(new Error('Scanner unavailable.'));};document.head.append(script);});
 return scannerLoad;
}
function parseScan(raw){
 const value=raw.trim().toUpperCase();if(/^[A-Z0-9]{6}$/.test(value))return value;
 try{const url=new URL(raw);if(url.origin!==location.origin||url.pathname!=='/connect')return null;const code=url.hash.slice(1).toUpperCase();return /^[A-Z0-9]{6}$/.test(code)?code:null;}catch{return null;}
}
$('scanCode').addEventListener('click',async()=>{
 if(!navigator.mediaDevices?.getUserMedia){info('Scan QR','Camera requires HTTPS. You can enter a code instead.');return;}
 const video=el('video');video.autoplay=true;video.muted=true;video.playsInline=true;
 show('Scan QR',[video,button('Cancel',closeModal,'secondary-button')]);
 try{
  await loadScanner();
  if(!modal.open||!body.contains(video))return;
  const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(!modal.open||!body.contains(video)){camera.getTracks().forEach(t=>t.stop());return;}
  stream=camera;video.srcObject=camera;await video.play();
  const canvas=el('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let last=0;
  function frame(ts){
   if(!stream||!modal.open||!body.contains(video))return;
   if(ts-last>150&&video.readyState>=2){last=ts;const scale=Math.min(1,640/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
    if(canvas.width&&canvas.height){ctx.drawImage(video,0,0,canvas.width,canvas.height);const image=ctx.getImageData(0,0,canvas.width,canvas.height);const hit=window.jsQR(image.data,image.width,image.height,{inversionAttempts:'dontInvert'});
     if(hit){const code=parseScan(hit.data);if(code){closeModal();$('enterCode').value=code;$('enterCode').focus();return;}}
    }
   }scanFrame=requestAnimationFrame(frame);
  }scanFrame=requestAnimationFrame(frame);
 }catch(e){stopCamera();if(modal.open&&body.contains(video))modalError(new Error('Camera unavailable. Enter a code instead.'));}
});
$('resetPin').addEventListener('click',()=>{
 if(['new','approved'].includes(state.pinState)){offerPin();return;}
 const request=button('Request',async()=>{request.disabled=true;try{const {ref}=await api('pin/reset',{});state.resetRequest=ref;showReference(ref);}catch(e){request.disabled=false;modalError(e);}});
 if(state.resetRequest){showReference(state.resetRequest);return;}
 show('New PIN',[el('p','','Developer approval is required.'),request,button('Cancel',closeModal,'secondary-button')]);
});
function showReference(ref){
 show('Reset request',[el('p','','Send this reference to a developer.'),el('strong','pin-display reference',ref),button('Copy',async()=>{try{await navigator.clipboard.writeText(ref);info('Copied',ref);}catch{info('Reset reference',ref);}}),button('Close',closeModal,'secondary-button')]);
}
$('emergency').addEventListener('click',()=>{
 if(state.pinState!=='active'){info('emg.exe','PIN unavailable. Request a new PIN.');return;}
 const pin=el('input','pin-input');pin.type='password';pin.inputMode='numeric';pin.maxLength=6;pin.autocomplete='off';pin.setAttribute('aria-label','Six-digit security PIN');pin.placeholder='••••••';
 const execute=button('Execute',async()=>{
  if(!/^\d{6}$/.test(pin.value))return;
  execute.disabled=true;
  try{await api('emergency',{pin:pin.value});pin.value='';state.pinState='used';clearVolatile();info('emg.exe','Your chats were removed.');await refresh();}
  catch(e){pin.value='';modalError(e);execute.disabled=true;pin.focus();}
 },'primary-button danger-button');
 execute.disabled=true;
 pin.addEventListener('input',()=>{pin.value=pin.value.replace(/\D/g,'').slice(0,6);execute.disabled=pin.value.length!==6;});
 show('emg.exe',[el('p','','Delete all your conversations for both sides. This PIN can only be used once.'),pin,execute,button('Cancel',closeModal,'secondary-button')]);
 pin.focus();
});
if(page==='connect'&&location.hash){const code=location.hash.slice(1).toUpperCase();if(/^[A-Z0-9]{6}$/.test(code))$('enterCode').value=code;history.replaceState(null,'',location.pathname);}
function loseConnection(){online=false;clearVolatile();stopCamera();}
window.addEventListener('offline',loseConnection);
window.addEventListener('online',()=>{if(started&&!document.hidden)refresh().catch(loseConnection);});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearVolatile();stopCamera();}else if(started)refresh().catch(loseConnection);});
window.addEventListener('pagehide',()=>{clearVolatile();stopCamera();});
window.addEventListener('pageshow',e=>{if(e.persisted&&started)refresh().catch(loseConnection);});
setInterval(purgeExpired,250);
async function loop(){if(started&&!document.hidden){try{await refresh();}catch{loseConnection();}}setTimeout(loop,1500);}
async function start(){
 try{
  await api('session',{});$(page+'Page').hidden=false;$('loading').hidden=true;started=true;
  await refresh();loop();
 }catch(e){
  started=false;show('qzu.',[el('p','',errorMessage(e)),button('Retry',()=>{closeModal();start();})]);
 }
}
start();
