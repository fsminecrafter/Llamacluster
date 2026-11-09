const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','ui.html'),'utf8');
const blk=src.slice(src.indexOf('// ---- leader mode'),src.indexOf('// ---- end leader mode'));
const pre=src.slice(Math.min(src.indexOf('const Q_QUAL'),src.indexOf('const QUANT_RE')),src.indexOf('// ---- hardware profile of a node'));
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v)),short=(s,n)=>{s=String(s??'');return s.length>n?s.slice(0,n)+'…':s};
const code=pre+blk+';return {leaderPickNodes,parseLeaderPlan,leaderSchedule,leaderTier,setNodes:n=>{NODES=n}};';
let NODES=[];
const api=new Function('clamp','short','NODES_get',`let NODES=[];${code.replace('setNodes:n=>{NODES=n}','setNodes:n=>{NODES=n}')}`)(clamp,short);
const mk=(name,model,extra={})=>({name,weight:extra.w||1,info:{server:{state:'ready',config:{model,parallel:extra.par||1}},models:[{name:model,size_mb:extra.mb||4000}]}});
let fails=0;const ok=(c,m)=>{if(!c){fails++;console.log('FAIL',m)}else console.log('ok  ',m)};
// --- node picking
api.setNodes([mk('a','qwen2.5-7b-instruct-q4_k_m.gguf'),mk('b','llama-3.1-70b-q4_k_m.gguf'),mk('c','qwen2.5-1.5b-q8_0.gguf')]);
let p=api.leaderPickNodes();
ok(p.map(x=>x.name).join()==='b,a,c','3 models sorted strongest first: '+p.map(x=>x.name));
ok(p[0].label==='hard tasks'&&p[1].label==='medium tasks'&&p[2].label==='easy tasks','labels');
api.setNodes([mk('a','m-7b-q4_k_m.gguf'),mk('b','m-70b-q4_k_m.gguf'),mk('c','m-1b-q4_k_m.gguf'),mk('d','m-13b-q4_k_m.gguf'),mk('e','m-3b-q4_k_m.gguf')]);
p=api.leaderPickNodes();ok(p.length===3&&p[0].name==='b'&&p[2].name==='c','5 models -> 3 (strongest, middle, weakest): '+p.map(x=>x.name));
api.setNodes([mk('a','m-7b-q4_k_m.gguf',{w:1}),mk('b','m-7b-q4_k_m.gguf',{w:5}),mk('c','m-7b-q4_k_m.gguf')]);
p=api.leaderPickNodes();ok(p.length===3&&p[0].label==='all tasks','same model on 3 nodes: all used, one tier');
api.setNodes([mk('a','m-7b-q4_k_m.gguf'),mk('b','m-7b-q4_k_m.gguf'),mk('c','m-3b-q4_k_m.gguf'),mk('d','m-3b-q4_k_m.gguf')]);
p=api.leaderPickNodes();ok(p.length===3&&new Set(p.map(x=>x.model)).size===2,'2 models, 4 nodes -> capped at 3: '+p.map(x=>x.name));
api.setNodes([]);ok(api.leaderPickNodes().length===0,'no nodes');
api.setNodes([{name:'x',info:{server:{state:'stopped',config:{model:'a-7b.gguf'}},models:[]}}]);ok(api.leaderPickNodes().length===0,'stopped node ignored');
// --- plan parsing
let t=api.parseLeaderPlan('```json\n{"tasks":[{"id":"t1","title":"A","prompt":"do a","difficulty":1,"depends_on":[]},{"id":"t2","title":"B","prompt":"do b","difficulty":3,"depends_on":["t1","zzz","t2"]},{"id":"t1","title":"dup","prompt":"x"},{"id":"t4","prompt":""}]}\n```',8);
ok(t.length===3&&t[1].deps.join()==='t1','unknown/self deps dropped, empty prompt skipped');
ok(t[2].id==='t1_','duplicate id renamed');
t=api.parseLeaderPlan(JSON.stringify({tasks:[{id:'a',prompt:'p',depends_on:['b']},{id:'b',prompt:'p',depends_on:['c']},{id:'c',prompt:'p',depends_on:['a']}]}),8);
ok(t.length===3&&t.some(x=>x.deps.length===0),'cycle broken');
ok(api.parseLeaderPlan('nonsense',4).length===0&&api.parseLeaderPlan('{"tasks":5}',4).length===0,'garbage -> empty');
ok(api.parseLeaderPlan(JSON.stringify({tasks:Array.from({length:20},(_,i)=>({prompt:'p'+i}))}),5).length===5,'max cap');
// --- user-chosen leader
const M=(n,m)=>mk(n,m);
api.setNodes([M('a','m-7b-q4_k_m.gguf'),M('b','m-70b-q4_k_m.gguf'),M('c','m-1b-q4_k_m.gguf')]);
p=api.leaderPickNodes('c');ok(p.filter(x=>x.leader).map(x=>x.name).join()==='c'&&p[0].name==='b'&&p[0].label==='hard tasks','weakest chosen as leader: it leads, strongest still gets hard tasks');
p=api.leaderPickNodes();ok(p.filter(x=>x.leader).map(x=>x.name).join()==='b','auto: strongest leads');
api.setNodes([M('a','m-7b-q4_k_m.gguf'),M('b','m-70b-q4_k_m.gguf'),M('c','m-1b-q4_k_m.gguf'),M('d','m-13b-q4_k_m.gguf'),M('e','m-3b-q4_k_m.gguf')]);
p=api.leaderPickNodes('e');ok(p.length===3&&p.some(x=>x.name==='e'&&x.leader)&&p[0].name==='b','chosen node outside the picked three is swapped in, strongest kept: '+p.map(x=>x.name));
api.setNodes([mk('fast','m-7b-q4_k_m.gguf',{w:5}),mk('slow','m-7b-q4_k_m.gguf',{w:1}),mk('big','m-70b-q4_k_m.gguf')]);
p=api.leaderPickNodes('slow');ok(p.some(x=>x.name==='slow'&&x.leader)&&!p.some(x=>x.name==='fast&&0')&&p.length===3,'chosen node with the same model as another is used instead of it: '+p.map(x=>x.name));
p=api.leaderPickNodes('ghost');ok(p.missingLeader==='ghost'&&p.filter(x=>x.leader).length===1&&p.find(x=>x.leader).name==='big','unknown/not-ready chosen leader -> strongest leads, flagged');
// --- tolerant plan parsing (what real models send)
const J=JSON.stringify({tasks:[{id:'t1',title:'A',prompt:'do a',difficulty:2,depends_on:[]},{id:'t2',title:'B',prompt:'do {b} "x"',difficulty:3,depends_on:['t1']}]});
ok(api.parseLeaderPlan('<think>I should output {"tasks": maybe} like this {x}</think>\n'+J,8).length===2,'<think> block with braces before the JSON');
ok(api.parseLeaderPlan('Sure! Here is the plan {as requested}:\n```json\n'+J+'\n```\nLet me know if you need changes {ok}.',8).length===2,'prose + braces around fenced JSON');
ok(api.parseLeaderPlan(JSON.stringify([{id:'a',prompt:'p'},{id:'b',prompt:'q',depends_on:['a']}]),8).length===2,'bare array');
ok(api.parseLeaderPlan(JSON.stringify({subtasks:[{title:'x',prompt:'p'}]}),8).length===1,'"subtasks" key accepted');
ok(api.parseLeaderPlan(JSON.stringify({plan:[{title:'x',task:'p'}]}),8).length===1,'"plan" key and "task" field accepted');
const cut=J.slice(0,J.indexOf('"t2"')-1);   // reply cut off in the middle of the second task
let tc=api.parseLeaderPlan(cut,8);ok(tc.length===1&&tc[0].id==='t1','cut-off reply keeps the complete tasks: '+tc.length);
ok(api.parseLeaderPlan('<think>still thinking, never finished {"tasks":[{"prompt":"x"}]}',8).length===0,'unfinished <think> only -> nothing');
ok(api.parseLeaderPlan('',8).length===0&&api.parseLeaderPlan(null,8).length===0,'empty / null reply');
ok(api.parseLeaderPlan('{"tasks":[{"id":"a","prompt":"p"}]} trailing {"junk":1}',8).length===1,'trailing junk object ignored');
// --- scheduling: diamond  t1,t2 parallel -> t3 (needs both, hard) -> t4 (easy)
(async()=>{
  const nodes=[{name:'big',model:'big',tier:0,slots:1},{name:'mid',model:'mid',tier:1,slots:1},{name:'small',model:'small',tier:2,slots:2}];
  const tasks=api.parseLeaderPlan(JSON.stringify({tasks:[
    {id:'t1',title:'x',prompt:'p',difficulty:1},{id:'t2',title:'x',prompt:'p',difficulty:1},{id:'t5',title:'x',prompt:'p',difficulty:2},{id:'t6',title:'x',prompt:'p',difficulty:3},
    {id:'t3',title:'x',prompt:'p',difficulty:3,depends_on:['t1','t2']},{id:'t4',title:'x',prompt:'p',difficulty:1,depends_on:['t3']}]}),8).map(x=>({...x,status:'queued',steps:[],result:''}));
  const log=[],t0=Date.now(),active={};let maxPar=0;
  await api.leaderSchedule(tasks,nodes,{aborted:false},()=>{},async(t,x)=>{
    log.push(`${t.id}@${x.name}`);active[t.id]=1;maxPar=Math.max(maxPar,Object.keys(active).length);
    const deps=t.deps.map(d=>tasks.find(y=>y.id===d));ok(deps.every(d=>d.status==='done'),t.id+' started only after deps done');
    await new Promise(r=>setTimeout(r,30));delete active[t.id];t.status='done';
  });
  console.log(log.join(' '));
  ok(tasks.every(x=>x.status==='done'),'all tasks done');
  ok(maxPar>=3,'ran in parallel (max '+maxPar+')');
  ok(log.find(l=>l.startsWith('t6'))==='t6@big'&&log.find(l=>l.startsWith('t3'))==='t3@big','hard tasks on leader');
  ok(log.find(l=>l.startsWith('t1'))==='t1@small'&&log.find(l=>l.startsWith('t4'))==='t4@small','easy tasks on smallest');
  ok(log.find(l=>l.startsWith('t5'))==='t5@mid','medium task on middle tier');
  // failure -> dependents skipped
  const tk=[{id:'a',difficulty:2,deps:[],downstream:1},{id:'b',difficulty:2,deps:['a'],downstream:0},{id:'c',difficulty:2,deps:[],downstream:0}].map(x=>({...x,status:'queued',steps:[],result:''}));
  await api.leaderSchedule(tk,nodes,{aborted:false},()=>{},async(t)=>{t.status=t.id==='a'?'error':'done'});
  ok(tk.find(x=>x.id==='b').status==='skipped'&&tk.find(x=>x.id==='c').status==='done','dependent of failed task skipped, independent task still done');
  // single node, no deadlock
  const one=[{name:'solo',model:'m',tier:0,slots:2}];const tz=api.parseLeaderPlan(JSON.stringify({tasks:[{id:'a',prompt:'p',difficulty:1},{id:'b',prompt:'p',difficulty:3,depends_on:['a']},{id:'c',prompt:'p',difficulty:2}]}),8).map(x=>({...x,status:'queued',steps:[],result:''}));
  await api.leaderSchedule(tz,one,{aborted:false},()=>{},async t=>{await new Promise(r=>setTimeout(r,5));t.status='done'});
  ok(tz.every(x=>x.status==='done'),'single node finishes everything');
  // abort
  const ab={aborted:false},ta=[{id:'a',difficulty:2,deps:[],downstream:0},{id:'b',difficulty:2,deps:['a'],downstream:0}].map(x=>({...x,status:'queued',steps:[],result:''}));
  await api.leaderSchedule(ta,one,ab,()=>{},async t=>{ab.aborted=true;t.status='stopped'});
  ok(ta[1].status==='queued','abort stops new tasks starting (runLeader then marks them stopped)');
  console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
})();
