import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {createMonitoring} from '../lib/monitoring.mjs';

test('monitoring captures only fixed labels, aggregate counters and no secrets',()=>{
 let time=60000,mono=0,cpu=0;const logs=[];
 const m=createMonitoring({now:()=>time,clock:()=>mono,cpu:()=>({user:cpu,system:0}),memory:()=>({rss:123,heapUsed:45}),uptime:()=>60,write:s=>logs.push(s)});
 const req={method:'POST',path:'/api/control/login',headers:{cookie:'PRIVATE_TOKEN'},body:{key:'PRIVATE_KEY',pin:'PRIVATE_PIN'},originalUrl:'/api/control/login?secret=PRIVATE_QUERY'};
 const res=new EventEmitter();res.statusCode=200;m.middleware(req,res,()=>{});mono=30;res.emit('finish');
 m.observe('POST','/api/encryption/message',200,10);
 m.observe('GET','/api/state/live',200,25000);
 m.observe('GET','/api/control/monitoring',200,1);
 m.observe('GET','/api/control/inbox',200,1);
 m.observe('GET','/api/media/PRIVATE_ROOM/PRIVATE_MESSAGE',500,20);
 m.observe('POST','/api/control/login',403,40);
 mono=2000;cpu=500000;
 const d=m.snapshot();assert.equal(d.requests,5);assert.equal(d.errors,1);assert.equal(d.rejected,1);assert.equal(d.messageRequests,1);assert.equal(d.meanResponseMs,25);assert.equal(d.cpuPercent,25);assert.equal(d.rssBytes,123);
 assert.ok(d.events.some(e=>e.label==='Desktop admin sign-in'&&e.status==='ok'));assert.ok(d.events.some(e=>e.status==='rejected'));
 assert.doesNotMatch(JSON.stringify([d,logs]),/PRIVATE_|\/api\/|cookie/i);
 assert.equal(d.events.some(e=>/message/i.test(e.label)),false);
 time+=6*60000;assert.equal(m.snapshot().requests,0);
});
test('monitor console caps history and coalesces repeated events',()=>{
 let time=0;const logs=[];const m=createMonitoring({now:()=>time,capacity:3,write:s=>logs.push(s)});
 for(let i=0;i<100;i++)m.observe('POST','/api/control/login',403,1);
 assert.equal(m.snapshot().events.length,2);assert.equal(logs.length,2);
 for(let i=0;i<5;i++){time+=6000;m.observe('POST','/api/control/login',403,1);}
 assert.equal(m.snapshot().events.length,3);assert.equal(m.snapshot().requests,105);
});
test('monitoring endpoint is behind the existing admin gate and desktop route guard',()=>{
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../public/control.js',import.meta.url),'utf8');
 const gate=server.indexOf("app.use('/api/control',(req,res,next)=>");
 const endpoint=server.indexOf("app.get('/api/control/monitoring'");
 assert.ok(gate>=0&&endpoint>gate);
 assert.ok(server.slice(gate,endpoint).includes('controlSessions.check(readControl(req))'));
 assert.ok(server.includes("['/control','/control.html','/control/monitoring'],(req,res)=>desktopRequest(req)?"));
 assert.match(ui,/\['Operations',\['Monitoring','Audit','Archive'\]\]/);
 assert.ok(ui.includes("api('monitoring')"));
});
