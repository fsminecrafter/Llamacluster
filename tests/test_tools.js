// node tests/test_tools.js  - the page-side question and task tools (extracted from ui.html), with a tiny fake DOM
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','ui.html'),'utf8');
const blk=src.slice(src.indexOf('// ---- question & task tools'),src.indexOf('// ---- end question & task tools'));
const mkEl=()=>({hidden:true,_h:'',set innerHTML(v){this._h=v},get innerHTML(){return this._h},onclick:null,onkeydown:null,value:'',focus(){},scrollIntoView(){},
  btns:[],querySelectorAll(sel){const n=(this._h.match(/data-i="/g)||[]).length;this.btns=Array.from({length:n},(_,i)=>({dataset:{i:String(i)},onclick:null}));return this.btns}});
const els={};const $=sel=>els[sel]||(els[sel]=mkEl());
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const F=new Function('$','esc','document','CH','saveChat','getAbort',`let chatAbort=null;const setAbort=v=>{chatAbort=v};${blk};return {cleanQuestion,askUser,taskTool,taskRun,renderTasks,setAbort}`);
const CH={tasks:[],taskSeq:0};
const api=F($,esc,{body:{classList:{contains:()=>true}}},CH,()=>{},()=>null);
let fails=0;const ok=(c,m)=>{if(!c){fails++;console.log('FAIL',m)}else console.log('ok  ',m)};
const tick=()=>new Promise(r=>setTimeout(r,0));
(async()=>{
  // cleanQuestion
  let q=api.cleanQuestion({question:'  Which?  ',options:['A','A',' B ','',null,'C','D','E','F','G','H','I']});
  ok(q.question==='Which?'&&q.options.join()==='A,B,C,D,E,F,G,H','trim, dedupe, cap options at 8');
  ok(api.cleanQuestion({question:'x',options:'one\ntwo'}).options.join()==='one,two','options given as a newline string');
  ok(api.cleanQuestion({}).question==='','missing question -> empty');
  // question flow
  const box=$('#cAsk');
  let p=api.askUser({question:'Pick one',options:['Red','Blue']});await tick();
  ok(box.hidden===false&&box._h.includes('Pick one')&&box._h.includes('Red'),'card shown with the options');
  box.btns[1].onclick();let r=JSON.parse(await p);
  ok(r.answer==='Blue'&&r.choice===2&&box.hidden===true&&box._h==='','option button -> answer, card hidden');
  p=api.askUser({question:'Name?'});await tick();$('#askIn').value='  Ada  ';$('#askGo').onclick();r=JSON.parse(await p);
  ok(r.answer==='Ada'&&r.custom===true,'typed answer (custom, trimmed)');
  p=api.askUser({question:'Name?',options:['x']});await tick();$('#askIn').value='   ';$('#askGo').onclick();
  let resolved=false;p.then(()=>resolved=true);await tick();ok(!resolved,'empty typed answer is ignored');
  $('#askIn').value='own';$('#askIn').onkeydown({key:'Enter',shiftKey:false,preventDefault(){}});r=JSON.parse(await p);ok(r.answer==='own','Enter submits');
  p=api.askUser({question:'Q'});await tick();$('#askSkip').onclick();r=JSON.parse(await p);ok(r.skipped===true&&r.answer===null,'skip');
  r=JSON.parse(await api.askUser({question:'  '}));ok(!!r.error,'empty question -> error, no card');
  // Stop button while a question is open
  let listeners=[];const ac={signal:{aborted:false,addEventListener:(t,f)=>listeners.push(f),removeEventListener:(t,f)=>{listeners=listeners.filter(x=>x!==f)}}};
  api.setAbort(ac);p=api.askUser({question:'Q'});await tick();listeners.forEach(f=>f());r=JSON.parse(await p);
  ok(r.error&&box.hidden===true&&listeners.length===0,'Stop closes the card, returns an error and removes its listener');
  // tasks
  const st={tasks:[],seq:0};
  r=api.taskTool(st,{action:'add',titles:['Plan','Build'],title:'Test'});ok(r.ok&&r.added.join()==='1,2,3'||r.added.join()==='1,2,3'||r.added.length===3,'add several: '+JSON.stringify(r.added));
  r=api.taskTool(st,{action:'set',id:1,status:'in progress'});ok(r.ok&&st.tasks[0].status==='doing','set: "in progress" -> doing');
  r=api.taskTool(st,{action:'set',id:'2',status:'done',title:'Build it'});ok(st.tasks[1].status==='done'&&st.tasks[1].title==='Build it','set: string id, status and title together');
  r=api.taskTool(st,{action:'set',id:99,status:'done'});ok(r.error,'set unknown id -> error');
  r=api.taskTool(st,{action:'set',id:1});ok(r.error,'set without status/title -> error');
  r=api.taskTool(st,{action:'set',id:1,status:'banana'});ok(r.error&&st.tasks[0].status==='doing','bad status rejected, task unchanged');
  r=api.taskTool(st,{action:'remove',ids:[1,42]});ok(r.ok&&r.removed.join()==='1'&&r.not_found.join()==='42'&&st.tasks.length===2,'remove: some found, some not');
  r=api.taskTool(st,{action:'remove',id:42});ok(r.error,'remove only unknown -> error');
  r=api.taskTool(st,{action:'add',title:'Later'});ok(r.added[0]===4,'ids are never reused after a removal');
  r=api.taskTool(st,{action:'list'});ok(r.tasks.length===3&&r.open===2,'list: 3 tasks, 2 open');
  r=api.taskTool(st,{action:'add'});ok(r.error,'add without title -> error');
  r=api.taskTool(st,{action:'add',title:'x',status:'zzz'});ok(r.error,'add with bad status -> error');
  r=api.taskTool(st,{action:'explode'});ok(r.error,'unknown action -> error');
  const big={tasks:Array.from({length:50},(_,i)=>({id:i+1,title:'t',status:'todo'})),seq:50};ok(api.taskTool(big,{action:'add',title:'one more'}).error,'capped at 50 tasks');
  ok(api.taskTool({tasks:[],seq:0},{action:'add',title:'x'.repeat(500)}).tasks[0].title.length===200,'titles cut at 200 chars');
  // taskRun persists in CH
  r=JSON.parse(api.taskRun({action:'add',title:'Persist me'}));ok(CH.tasks.length===1&&CH.taskSeq===1&&r.ok,'taskRun stores tasks and the id counter in the chat state');
  r=JSON.parse(api.taskRun({action:'remove',id:1}));ok(CH.tasks.length===0&&CH.taskSeq===1,'taskRun remove');
  console.log(fails?fails+' FAILED':'ALL PASSED');process.exit(fails?1:0);
})();
