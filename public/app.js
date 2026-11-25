'use strict';
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const svg=(name,cls)=>{const node=document.createElementNS('http://www.w3.org/2000/svg','svg');if(cls)node.setAttribute('class',cls);node.setAttribute('aria-hidden','true');const use=document.createElementNS(node.namespaceURI,'use');use.setAttribute('href','#'+name);node.append(use);return node;};
let page=location.pathname==='/settings'?'settings':location.pathname==='/connect'?'connect':'chat';
const mobile=matchMedia('(max-width:700px)');
let state={rooms:[],invite:null,pinState:null,resetPending:false,resetDelivered:false},offset=0,selected=null,mobileOpen=false,sequence=0,started=false,renderedRoom=null,renderedMessages=[],contactKey='',qrKey='',pinPrompt=false,stream=null,scanFrame=0,scannerLoad=null,modalLocked=false,online=true;
const modal=$('modal'),body=$('modalBody');
let unlockToken=null,authEpoch=0,authBusy=false,sessionReady=false,needsSetup=false,lockPromptId=0,qrPending='',loopStarted=false;
let pendingInvite='';
function routeName(path){return path==='/settings'?'settings':path==='/connect'?'connect':'chat';}
function updatePages(){
 for(const name of ['chat','settings','connect'])$(name+'Page').hidden=!unlockToken||name!==page;
 $('loading').hidden=Boolean(unlockToken);
 $('loading').classList.toggle('locked',!unlockToken);
}
function navigate(path,push=true){
 if(push)history.pushState(null,'',path);
 page=routeName(location.pathname);
 if(page==='connect'&&pendingInvite&&unlockToken){$('enterCode').value=pendingInvite;pendingInvite='';}
 updatePages();render();
}
document.addEventListener('click',e=>{
 const a=e.target.closest('a[href]');if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 const url=new URL(a.href);if(url.origin!==location.origin||!['/chat','/connect','/settings','/'].includes(url.pathname))return;
 e.preventDefault();if(unlockToken)navigate(url.pathname);
});
window.addEventListener('popstate',()=>navigate(location.pathname,false));
const fmtTime=ms=>new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'}).format(new Date(ms));
const clock=ms=>{const s=Math.max(0,Math.ceil(ms/1000));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');};
const serverNow=()=>Date.now()+offset;
const nameFor=r=>'Chat '+r.id.slice(0,4).toUpperCase();
function stopCamera(){cancelAnimationFrame(scanFrame);if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}}
function closeModal(){if(modalLocked)return;stopCamera();if(modal.open)modal.close();body.replaceChildren();}
$('modalClose').addEventListener('click',closeModal);
modal.addEventListener('cancel',e=>{e.preventDefault();closeModal();});
modal.addEventListener('close',()=>{if(!modal.open){stopCamera();body.replaceChildren();modalLocked=false;}});
function show(title,content,locked=false){
 stopCamera();modalLocked=locked;$('modalClose').hidden=locked;$('modalTitle').textContent=title;body.replaceChildren(...content);
 if(!modal.open)modal.showModal();
}
function button(text,fn,cls='primary-button'){const b=el('button',cls,text);b.type='button';b.addEventListener('click',fn);return b;}
function info(title,message){if(!unlockToken)return;show(title,[el('p','',message),button('OK',closeModal)]);}
function errorMessage(error){return error instanceof Error?error.message:'Try again.';}
function showError(error){info('qzu.',errorMessage(error));}
function modalError(error){if(!unlockToken)return;dialogError(error);}
function dialogError(error){let p=body.querySelector('.modal-error');if(!p){p=el('p','modal-error');body.append(p);}p.textContent=errorMessage(error);}
async function api(path,data){
 const write=data!==undefined,epoch=authEpoch,token=unlockToken;
 const authRoute=['session','login/setup','login/unlock'].includes(path);
 if(!authRoute&&!token)throw new Error('Locked.');
 if(write)sequence++;
 const headers={};if(write){headers['Content-Type']='application/json';headers['X-QZU']='1';}
 if(token)headers['X-QZU-Unlock']=token;
 let res;
 try{res=await fetch('/api/'+path,{method:write?'POST':'GET',headers,body:write?JSON.stringify(data):undefined,cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(8000)});}
 catch{throw new Error('Connection unavailable.');}
 const result=await res.json().catch(()=>({}));
 if(epoch!==authEpoch||document.hidden){
  if(result.token)revokeToken(result.token);
  throw new Error('Locked.');
 }
 if(res.status===423&&!authRoute){lock();throw new Error('Locked.');}
 if(!res.ok)throw new Error(result.error||'Try again.');
 return result;
}
function revokeToken(token){
 if(!token)return;
 fetch('/api/login/lock',{method:'POST',headers:{'Content-Type':'application/json','X-QZU':'1','X-QZU-Unlock':token},body:'{}',credentials:'same-origin',cache:'no-store',keepalive:true}).catch(()=>{});
}
function pinField(label,placeholder='6-digit PIN'){
 const wrap=el('label','',label),input=el('input','pin-input');
 input.type='password';input.inputMode='numeric';input.autocomplete='off';input.maxLength=6;input.placeholder=placeholder;input.required=true;
 input.pattern='[0-9]{6}';input.setAttribute('aria-label',label);
 input.addEventListener('input',()=>{input.value=input.value.replace(/\D/g,'').slice(0,6);});
 wrap.append(input);return {wrap,input};
}
function pinDialog(title,fields,submitLabel,onSubmit,{locked=false,note='',auth=false}={}){
 const form=el('form','auth-form'),items=fields.map(label=>pinField(label));
 if(note)form.append(el('p','',note));
 for(const item of items)form.append(item.wrap);
 const submit=el('button','primary-button',submitLabel);submit.type='submit';form.append(submit);
 if(!locked)form.append(button('Cancel',closeModal,'secondary-button'));
 const epoch=authEpoch;
 form.addEventListener('submit',async e=>{
  e.preventDefault();if(submit.disabled||epoch!==authEpoch)return;
  const values=items.map(item=>item.input.value);
  if(values.some(v=>!/^\d{6}$/.test(v)))return;
  submit.disabled=true;
  try{await onSubmit(values);}catch(err){if(epoch===authEpoch&&body.contains(form)){dialogError(err);submit.disabled=false;}}
  finally{values.fill('');}
 });
 const brand=el('div','auth-brand');brand.append(svg('logo','wordmark'));
 show(title,auth?[brand,form]:[form],locked);
}
function showLogin(){
 if(document.hidden||unlockToken||!sessionReady)return;
 const setup=needsSetup;
 pinDialog(setup?'Create login PIN':'Unlock',setup?['New PIN','Confirm PIN']:['Login PIN'],setup?'Create':'Unlock',async values=>{
  if(setup&&values[0]!==values[1])throw new Error('PINs do not match.');
  const result=await api(setup?'login/setup':'login/unlock',{pin:values[0]});
  unlockToken=result.token;needsSetup=false;modalLocked=false;closeModal();
  navigate(location.pathname,false);
  try{await refresh();}catch{lock();}
 },{locked:true,auth:true});
}
async function getSession(){
 if(authBusy||document.hidden||unlockToken)return;
 authBusy=true;const epoch=authEpoch;
 try{const result=await api('session',{});if(epoch!==authEpoch)return;sessionReady=true;needsSetup=result.needsSetup;showLogin();}
 catch(e){if(epoch===authEpoch&&!document.hidden)show('qzu.',[el('p','',errorMessage(e)),button('Retry',()=>{getSession();})],true);}
 finally{authBusy=false;if(epoch!==authEpoch&&!document.hidden&&!unlockToken)getSession();}
}
function lock(){
 authEpoch++;sequence++;const old=unlockToken;unlockToken=null;
 revokeToken(old);stopCamera();pinPrompt=false;qrKey='';qrPending='';
 state={rooms:[],invite:null,pinState:null,resetPending:false,resetDelivered:false};
 selected=null;mobileOpen=false;contactKey='';renderedRoom=null;renderedMessages=[];
 $('contacts').replaceChildren();$('messages').replaceChildren();$('message').value='';$('enterCode').value='';
 $('threadName').textContent='Chat';$('chatTimer').textContent='30:00';$('chatCount').textContent='';
 $('inviteCode').textContent='– – – – – –';$('inviteTimer').textContent='No active code';
 $('qrImage').removeAttribute('src');$('qrImage').hidden=true;$('qrPlaceholder').removeAttribute('hidden');
 $('send').disabled=true;updatePages();
 modalLocked=false;closeModal();
 if(!document.hidden)getSession();
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
 if(page!=='chat'||!unlockToken)return;
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
 if(page!=='connect'||!unlockToken)return;
 const inv=state.invite&&state.invite.expires>serverNow()?state.invite:null;
 $('inviteCode').textContent=inv?.code||'– – – – – –';
 $('inviteTimer').textContent=inv?clock(inv.expires-serverNow()):'No active code';
 $('copyCode').disabled=!inv;
 const key=inv?inv.code+':'+inv.expires:'';
 if(key!==qrKey&&key!==qrPending){
  $('qrImage').hidden=true;$('qrImage').removeAttribute('src');$('qrPlaceholder').removeAttribute('hidden');
  if(!inv){qrKey='';qrPending='';return;}
  qrPending=key;
  api('qr').then(({image})=>{
   if(!unlockToken||qrPending!==key||state.invite?.code!==inv.code||state.invite?.expires!==inv.expires)return;
   if(typeof image!=='string'||!image.startsWith('data:image/png;base64,'))return;
   qrKey=key;$('qrImage').src=image;$('qrImage').hidden=false;$('qrPlaceholder').setAttribute('hidden','');
  }).catch(()=>{}).finally(()=>{if(qrPending===key)qrPending='';});
 }
}
function renderSettings(){
 if(page!=='settings')return;
 $('resetPin').disabled=!state.pinState||Boolean(state.resetDelivered)||['new','approved'].includes(state.pinState);
 $('resetLabel').textContent=state.resetDelivered?'Reset pending':'Request Reset';
 $('emergency').disabled=!state.pinState;
 $('changeLogin').disabled=!unlockToken;
}
function render(){renderChat();renderConnect();renderSettings();}
function purgeExpired(){
 if(!unlockToken)return;
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
 if(ticket!==sequence||document.hidden||!unlockToken)return;
 online=true;offset=data.now-Date.now();state=data;
 if(page==='chat'&&!selected){let target=null;try{target=sessionStorage.getItem('qzu-open');sessionStorage.removeItem('qzu-open');}catch{}
  if(target&&data.rooms.some(r=>r.id===target)){selected=target;mobileOpen=true;}
 }
 render();purgeExpired();
 // Emergency PIN setup is deliberately opened from Settings.
}
function offerPin(){
 pinDialog('emg.exe',['New PIN','Confirm PIN'],'Save',async values=>{
  if(values[0]!==values[1])throw new Error('PINs do not match.');
  await api('pin/issue',{pin:values[0]});closeModal();await refresh();info('emg.exe','PIN saved.');
 },{note:'Choose a different PIN from your login PIN. Single-use.'});
}
$('changeLogin').addEventListener('click',()=>{
 pinDialog('Change login PIN',['Current PIN','New PIN','Confirm PIN'],'Save',async values=>{
  if(values[1]!==values[2])throw new Error('PINs do not match.');
  const result=await api('login/change',{current:values[0],next:values[1]});
  unlockToken=result.token;closeModal();await refresh();info('qzu.','PIN changed.');
 });
});
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
 try{const result=await api('connect',{code});navigate('/chat');selected=result.id;mobileOpen=true;renderedRoom=null;await refresh();}
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
 const request=button('Request Reset',async()=>{request.disabled=true;try{await api('pin/reset',{});await refresh();info('Reset requested','Pending developer approval.');}catch(e){request.disabled=false;modalError(e);}});
 if(state.resetDelivered){info('Reset pending','Pending developer approval.');return;}
 show('Request Reset',[request,button('Cancel',closeModal,'secondary-button')]);
});
$('emergency').addEventListener('click',()=>{
 if(['new','approved'].includes(state.pinState)){offerPin();return;}
 if(state.pinState!=='active'){info('emg.exe','Request Reset to set a new PIN.');return;}
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
if(page==='connect'&&location.hash){const code=location.hash.slice(1).toUpperCase();if(/^[A-Z0-9]{6}$/.test(code))pendingInvite=code;history.replaceState(null,'',location.pathname);}
window.addEventListener('offline',()=>{if(unlockToken)lock();});
window.addEventListener('online',()=>{if(!unlockToken)getSession();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)lock();else if(!unlockToken)getSession();});
window.addEventListener('pagehide',lock);
window.addEventListener('pageshow',e=>{if(e.persisted&&!unlockToken)getSession();});
setInterval(purgeExpired,250);
async function loop(){
 if(unlockToken&&!document.hidden){try{await refresh();}catch{if(unlockToken)lock();}}
 setTimeout(loop,1500);
}
updatePages();getSession();loop();
