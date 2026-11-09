// node tests/test_context.js - the context gauge's maths (extracted from ui.html)
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','ui.html'),'utf8');
const blk=src.slice(src.indexOf('// ---- context gauge'),src.indexOf('// ---- end context gauge'));
const CH={mode:'dev',route:'',model:'',leader:''};
const api=new Function('CH','esc','$','document',`let NODES=[];${blk};return {ctxEstimate,ctxCapacity,ctxSegments,ctxMenuSegments,CTX_CAT,setNodes:v=>{NODES=v}}`)(CH,String,()=>null,{addEventListener(){}});
const setNodes=api.setNodes;
let fails=0;const ok=(c,m)=>{if(!c){fails++;console.log('FAIL',m)}else console.log('ok  ',m)};
const node=(name,model,ctx,par=1,state='ready')=>({name,info:{server:{state,config:{model,ctx_size:ctx,parallel:par}}}});
// categories
let e=api.ctxEstimate([{role:'system',content:'s'.repeat(380)},{role:'user',content:'u'.repeat(380)},
  {role:'assistant',content:'a'.repeat(38),tool_calls:[{id:'1',type:'function',function:{name:'x',arguments:'{}'}}]},{role:'tool',tool_call_id:'1',content:'r'.repeat(320)}],[{type:'function',function:{name:'t',parameters:{}}}]);
ok(e.sys===100+5,'system prompt: 380 chars ≈ 100 tokens + 5 overhead = '+e.sys);
ok(e.user===100+5+10+5,'user: your message + the reply text (+overhead) = '+e.user);
ok(e.toolOthers>0&&e.toolOutputs>100&&e.toolOutputs<110,'tool call JSON and result are counted separately');
ok(e.tools>0,'tools: the definitions = '+e.tools);
ok(e.total===e.sys+e.tools+e.toolOthers+e.toolOutputs+e.user+e.image,'total is the sum');
ok(api.ctxEstimate([],[]).total===0&&api.ctxEstimate(null,null).total===0,'empty / null input');
ok(api.ctxEstimate([{role:'user',content:[{type:'text',text:'hi'}]}],[]).user>0,'array content does not crash');
// segments: ring fraction and colour levels
const mk=(used,size)=>api.ctxSegments({sys:used,tools:0,toolOthers:0,toolOutputs:0,user:0,image:0},1,size?{tokens:size}:null);
let s=mk(500,1000);ok(Math.round(s.pct)===50&&s.level==='','50% -> half ring, no warning');
ok(mk(749,1000).level===''&&mk(750,1000).level==='warn','orange starts at 75%');
ok(mk(949,1000).level==='warn'&&mk(950,1000).level==='crit','red starts at 95%');
s=mk(1500,1000);ok(s.pct===100&&s.level==='crit'&&s.free===0,'over the limit: ring full, red, no free space');
s=mk(300,0);ok(s.pct===0&&s.level===''&&s.size===0,'unknown window size: empty ring, no colour');
// bar segments: names, colours, order, sum
s=api.ctxSegments({sys:100,tools:200,toolOthers:50,toolOutputs:0,user:150,image:0},1,{tokens:1000});
ok(s.segs.map(x=>x.label).join('|')==='System prompt|Tool|Tool others|Tool outputs|User|Image context|Free space','segment order and names');
ok(s.segs.map(x=>x.color).join()==='#f87171,#ef4444,#f97316,#fb923c,#4ade80,#22d3ee,#6ea8ff','Image context is cyan');
ok(s.free===500&&Math.abs(s.segs.reduce((a,x)=>a+x.pct,0)-100)<1e-9,'free space = size - used, bar adds up to 100%');
s=api.ctxSegments({sys:1500,tools:0,toolOthers:0,toolOutputs:0,user:0,image:0},1,{tokens:1000});ok(Math.abs(s.segs.reduce((a,x)=>a+x.pct,0)-100)<1e-9,'bar still adds up to 100% when over the limit');
s=api.ctxSegments({sys:100,tools:0,toolOthers:0,toolOutputs:0,user:0,image:0},2,{tokens:1000});ok(s.used===200,'calibration scale multiplies the estimate');
let imageEstimate=api.ctxEstimate([{role:'user',content:[{type:'text',text:'look'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,abc'}}]}],[]);
ok(imageEstimate.image===Math.ceil(2300/3.8)&&imageEstimate.user===7&&imageEstimate.total===imageEstimate.user+imageEstimate.image,'counts image tokens as Image context, separate from user text');
let imageSegs=api.ctxSegments(imageEstimate,1,{tokens:10000});
ok(api.ctxMenuSegments(imageSegs).some(x=>x.id==='image'),'shows Image context once a vision request includes an image');
ok(!api.ctxMenuSegments(api.ctxSegments(api.ctxEstimate([{role:'user',content:'text only'}],[]),1,{tokens:10000})).some(x=>x.id==='image'),'hides Image context when no image was sent');
// capacity
setNodes([node('a','m1',8192,2),node('b','m2',16384,1),node('c','m1',4096,1,'stopped')]);
let c=api.ctxCapacity();ok(c.tokens===4096&&c.name==='a'&&c.nodes===2&&!c.fixed,'auto: smallest per-slot window of the ready nodes (8192÷2 = 4096)');
CH.route='b';c=api.ctxCapacity();ok(c.tokens===16384&&c.fixed,'pinned to a node: that node');
CH.route='c';c=api.ctxCapacity();ok(c.tokens===4096,'pinned node not ready: falls back to the ready ones');
CH.route='';CH.model='m2';c=api.ctxCapacity();ok(c.name==='b','model chosen: only nodes with that model');
CH.model='';CH.mode='leader';CH.leader='b';c=api.ctxCapacity();ok(c.name==='b'&&c.fixed,'leader mode: the chosen leader');
CH.mode='dev';CH.leader='';
setNodes([node('x','m',0)]);ok(api.ctxCapacity()===null,'unknown ctx_size -> null');
setNodes([]);ok(api.ctxCapacity()===null,'no nodes -> null');
console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
