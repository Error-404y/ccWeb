import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
function extract(start,end){
  const i=app.indexOf(start),j=app.indexOf(end,i);
  assert.ok(i>=0&&j>i);
  return app.slice(i,j);
}

test('view-once icon and opened state are shared by text, photos and the composer',()=>{
  const label=runInNewContext(extract('function onceLabel(','\nfunction onceAllowed(')+'\nonceLabel');
  assert.equal(label({kind:'text'}),'Message');
  assert.equal(label({kind:'image'}),'Photo');
  assert.equal(label({kind:'image',opened:true}),'Opened');
  assert.match(html,/id="viewOnceIcon"/);assert.match(html,/id="viewOnceOpened"/);
  assert.match(html,/id="onceShortcut"[^>]*aria-pressed="false"/);
  assert.match(css,/\.once-message\.once-opened/);
  assert.ok(app.includes("open.prepend(svg(message.opened?'viewOnceOpened':'viewOnceIcon'))"));
  assert.ok(app.includes('open.disabled = message.mine || message.opened'));
  assert.ok(app.includes("toggle.append(svg('viewOnceIcon'))"));
});

test('view once is available only in eligible direct rooms with required encryption',()=>{
  const ctx={serverNow:()=>100,encryptionRequired:r=>Boolean(r.encryption),encryptionReady:r=>r.ready,state:{capabilities:{encryptedOnce:true}}};
  const allowed=runInNewContext(extract('function onceAllowed(','\nfunction syncOnceToggle(')+'\nonceAllowed',ctx);
  const room={expires:200};
  assert.equal(allowed(room),true);
  for(const extra of [{group:true},{admin:true},{support:true},{readOnly:true},{expires:100},{encryption:true,ready:false}])assert.equal(allowed({...room,...extra}),false);
  assert.equal(allowed({...room,encryption:true,ready:true}),true);
  ctx.state.capabilities.encryptedOnce=false;
  assert.equal(allowed({...room,encryption:true,ready:true}),false);
});

function setup(kind='text',encrypted=true){
  const message={id:'msg',kind,opened:false,mine:false,deleted:false,text:'',cipher:null};
  const room={id:'room',expires:500,encryption:encrypted,messages:[message]};
  const calls=[],views=[],nodes=[];let resolveOpen,resolveDecrypt;
  const pending=new Promise(resolve=>{resolveOpen=resolve;});
  const decrypted=new Promise(resolve=>{resolveDecrypt=resolve;});
  const node=(tag,cls,text)=>({tag,cls,text,prepend(){}});
  const key={context:{}};
  const ctx={openingOnce:new Set(),unlockToken:'token',authEpoch:1,selected:'room',document:{hidden:false},modal:{open:false},
    body:{contains:n=>nodes.includes(n)},state:{rooms:[room],capabilities:{encryptedOnce:true}},
    roomKeys:new Map([['room',key]]),serverNow:()=>100,encryptionReady:()=>true,el:node,svg:()=>({}),button:()=>({}),
    show(title,content){nodes.splice(0,nodes.length,...content);ctx.modal.open=true;views.push({title,content});},
    closeModal(){nodes.length=0;ctx.modal.open=false;},
    api(path,args){calls.push({path,args});return pending;},
    QzuCrypto:{decrypt:()=>decrypted,decryptMedia:()=>decrypted},
    showMedia(r,k,source,id){views.push({kind:k,source,id});},
    render(){},refresh:async()=>{},haptic(){},modalError(e){views.push({error:e.message});},showError(e){views.push({error:e.message});}
  };
  const open=runInNewContext(extract('async function openOnceMessage(','\nfunction currentMediaRoom(')+'\nopenOnceMessage',ctx);
  return {room,message,calls,views,ctx,open,resolveOpen,resolveDecrypt};
}

test('recipient tap consumes encrypted text once; concurrent and later taps never fetch again',async()=>{
  const h=setup();const first=h.open(h.room,h.message);
  await h.open(h.room,h.message);assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].path,'encryption/once/open');
  h.resolveOpen({kind:'text',cipher:{data:'cipher'}});
  h.resolveDecrypt('secret text');await first;
  assert.equal(h.message.opened,true);assert.equal(h.message.text,'');assert.equal(h.message.cipher,null);
  assert.equal(h.views.at(-1).content[0].text,'secret text');
  h.ctx.closeModal();await h.open(h.room,h.message);
  assert.equal(h.calls.length,1);assert.equal(h.ctx.modal.open,false);
});

test('photo opens in dedicated viewer, but closing during decryption never reveals it',async()=>{
  const h=setup('image');const first=h.open(h.room,h.message);
  h.resolveOpen({kind:'image',cipher:{data:'cipher'}});await Promise.resolve();await Promise.resolve();
  h.ctx.closeModal();h.resolveDecrypt('photo-data');await first;
  assert.equal(h.message.opened,true);assert.equal(h.views.some(v=>v.kind==='image'),false);
  await h.open(h.room,h.message);assert.equal(h.calls.length,1);
});

test('sender and opened messages cannot request the one-time payload',async()=>{
  const h=setup();h.message.mine=true;await h.open(h.room,h.message);
  h.message.mine=false;h.message.opened=true;await h.open(h.room,h.message);
  assert.equal(h.calls.length,0);
});

test('unencrypted legacy photo still uses dedicated consume endpoint',async()=>{
  const h=setup('image',false);const first=h.open(h.room,h.message);
  h.resolveOpen({kind:'image',media:{mime:'image/png',data:'abc'}});await first;
  assert.equal(h.calls[0].path,'message/open');assert.equal(h.views.at(-1).source,'data:image/png;base64,abc');
  assert.equal(h.message.opened,true);
});
