import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=app.indexOf('function attachMessageGesture('),end=app.indexOf('\nfunction beginReply(',start);
assert.ok(start>=0&&end>start);

function setup(replyEnabled=true){
  const listeners=new Map(),classes=new Set(),styles=new Map(),timers=new Map();
  const events=[];let capture=null,nextTimer=0;
  const child={closest:()=>null},control={closest:()=>control};
  const bubble={
    isConnected:true,closest:()=>null,append(){},
    classList:{add(...names){names.forEach(n=>classes.add(n));},remove(...names){names.forEach(n=>classes.delete(n));},contains(n){return classes.has(n);},toggle(n,on){on?classes.add(n):classes.delete(n);}},
    style:{setProperty(k,v){styles.set(k,v);},removeProperty(k){styles.delete(k);}},
    addEventListener(n,fn){listeners.set(n,fn);},
    setPointerCapture(id){capture=id;},
    hasPointerCapture(id){return capture===id;}
  };
  const attach=runInNewContext(app.slice(start,end)+'\nattachMessageGesture',{
    svg:()=>({}),haptic:()=>events.push('haptic'),
    native:true,devicePlugin:{haptic:()=>Promise.resolve()},
    setTimeout(fn){timers.set(++nextTimer,fn);return nextTimer;},clearTimeout(id){timers.delete(id);}
  });
  attach(bubble,replyEnabled?()=>events.push('reply'):null,()=>events.push('actions'));
  function emit(name,overrides={}){
    const e={pointerId:1,isPrimary:true,button:0,clientX:100,clientY:100,target:child,detail:1,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...overrides};
    listeners.get(name)?.(e);return e;
  }
  function swipe(id=1){
    emit('pointerdown',{pointerId:id});
    emit('pointermove',{pointerId:id,clientX:70});
    emit('lostpointercapture',{pointerId:id,target:child});
    emit('pointermove',{pointerId:id,clientX:35});
    emit('pointerup',{pointerId:id,clientX:35});
    capture=null;emit('lostpointercapture',{pointerId:id,target:bubble});
  }
  return {events,classes,styles,timers,emit,swipe,bubble,child,control,lose(){capture=null;}};
}

test('nested implicit touch capture transfer does not cancel repeated swipes',()=>{
  const h=setup();h.swipe();h.swipe();h.swipe(2);
  assert.deepEqual(h.events,['haptic','reply','haptic','reply','haptic','reply']);
  assert.equal(h.classes.has('swipe-tracking'),false);
  assert.equal(h.classes.has('swipe-ready'),false);
  assert.equal(h.styles.has('--reply-shift'),false);
  assert.equal(h.timers.size,0);
});

test('actual capture loss cancels; another pointer cannot cancel the next swipe',()=>{
  const h=setup();h.emit('pointerdown');h.emit('pointermove',{clientX:30});h.lose();
  h.emit('lostpointercapture',{target:h.bubble});h.emit('pointerup',{clientX:30});
  assert.deepEqual(h.events,[]);
  h.emit('pointerdown',{pointerId:2});h.emit('pointermove',{pointerId:2,clientX:25});
  h.emit('pointercancel',{pointerId:1});h.emit('lostpointercapture',{pointerId:1,target:h.bubble});
  h.emit('pointerup',{pointerId:2,clientX:25});
  assert.deepEqual(h.events,['haptic','reply']);
});

test('vertical, short, cancelled and unavailable reply gestures do not reply',()=>{
  const h=setup();
  h.emit('pointerdown');h.emit('pointermove',{clientX:95,clientY:170});h.emit('pointerup',{clientX:20,clientY:170});
  h.emit('pointerdown');h.emit('pointermove',{clientX:75});h.emit('pointerup',{clientX:75});
  h.emit('pointerdown');h.emit('pointermove',{clientX:20});h.emit('pointerup',{clientX:20,clientY:190});
  h.emit('pointerdown');h.emit('pointermove',{clientX:20});h.emit('pointercancel');h.emit('pointerup',{clientX:20});
  assert.deepEqual(h.events,[]);
  const noReply=setup(false);noReply.swipe();assert.deepEqual(noReply.events,[]);
});

test('swipe suppresses its own click but not subsequent media controls or keyboard actions',()=>{
  const h=setup();h.swipe();
  assert.equal(h.emit('click').prevented,true);
  h.swipe();h.emit('pointerdown',{target:h.control});
  assert.equal(h.emit('click',{target:h.control}).prevented,undefined);
  h.swipe();assert.equal(h.emit('click',{detail:0}).prevented,undefined);
  h.emit('keydown',{key:'Enter',target:h.bubble});
  assert.equal(h.events.at(-1),'actions');
});

test('long press opens actions once and the next swipe still works',()=>{
  const h=setup();h.emit('pointerdown');[...h.timers.values()][0]();
  h.emit('contextmenu');h.emit('pointerup');assert.deepEqual(h.events,['haptic','actions']);
  h.swipe();assert.deepEqual(h.events,['haptic','actions','haptic','reply']);
});
