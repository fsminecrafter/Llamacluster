// node tests/test_chat_features.js - compact snapshots and spawn slot selection extracted from ui.html
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','ui.html'),'utf8');
const ok=(condition,message)=>{if(!condition)throw Error(message);console.log('ok  ',message)};
const compactStart=src.indexOf('function scriptCompactSummary('),compactEnd=src.indexOf('async function compactChat(',compactStart);
if(compactStart<0||compactEnd<0)throw Error('script compact helper not found');
const scriptCompactSummary=new Function('msgs',src.slice(compactStart,compactEnd)+';return scriptCompactSummary(msgs)');
const summary=scriptCompactSummary([
  {role:'user',content:'earlier request'},
  {role:'assistant',content:'earlier answer'},
  {role:'assistant',tool_calls:[{function:{name:'read_file',arguments:'{"path":"old"}'}}]},
  {role:'user',content:'u'.repeat(450)},
  {role:'assistant',tool_calls:[{function:{name:'runweb',arguments:'{"path":"index.html"}'.repeat(30)}}]},
  {role:'assistant',content:'a'.repeat(450)}
]);
const lines=summary.split('\n');
ok(lines[0].startsWith('Last user: ')&&lines[0].slice(11).length===300,'keeps at most 300 chars from the latest user message');
ok(lines[1].startsWith('Last tool call: ')&&lines[1].slice(16).startsWith('runweb(')&&lines[1].slice(16).length<=300,'keeps at most 300 chars from the latest tool call');
ok(lines[2].startsWith('Last AI output: ')&&lines[2].slice(16).length<=300,'keeps at most 300 chars from the latest AI output');
ok(summary.length<=900,'keeps the complete script snapshot within 900 characters');
const btwStart=src.indexOf('function btwMessages('),btwEnd=src.indexOf('function dispatchBtw',btwStart);
if(btwStart<0||btwEnd<0)throw Error('btw history helper not found');
const btwMessages=new Function('apiMessages','question',src.slice(btwStart,btwEnd)+';return btwMessages(question)');
let history=btwMessages(()=>[{role:'system',content:'sys'},{role:'user',content:'active'},{role:'assistant',tool_calls:[{id:'pending'}]}],'side');
ok(!history.some(x=>x.tool_calls)&&history[history.length-1].content==='side','drops an incomplete tool call from side-question history');
history=btwMessages(()=>[{role:'system',content:'sys'},{role:'assistant',tool_calls:[{id:'done'}]},{role:'tool',tool_call_id:'done',content:'result'}],'side');
ok(history.some(x=>x.tool_calls)&&history.some(x=>x.role==='tool'),'keeps complete tool-call groups in side-question history');
const slotsStart=src.indexOf('function spawnSlots(){'),slotsEnd=src.indexOf('// which tool groups',slotsStart);
if(slotsStart<0||slotsEnd<0)throw Error('spawn slot helper not found');
const spawnSlots=new Function('NODES',src.slice(slotsStart,slotsEnd)+';return spawnSlots()');
const available=spawnSlots([
  {name:'busy',gateway_inflight:2,info:{server:{state:'ready',inflight:2,config:{model:'model-a',parallel:2}}}},
  {name:'free',gateway_inflight:1,info:{server:{state:'ready',inflight:0,config:{model:'model-b',parallel:3}}}},
  {name:'offline',info:{server:{state:'stopped',config:{model:'model-c',parallel:4}}}}
]);
ok(available.length===2&&available.every(x=>x.node==='free'&&x.model==='model-b'),'selects only free slots from ready model nodes');
const ctxStart=src.indexOf('const CTX_CAT='),ctxEnd=src.indexOf('function ctxState',ctxStart);
if(ctxStart<0||ctxEnd<0)throw Error('context gauge helpers not found');
const ctxCheck=new Function('msgs','defs','cap',src.slice(ctxStart,ctxEnd)+';const e=ctxEstimate(msgs,defs);return {e,segs:ctxSegments(e,1,cap),cats:CTX_CAT}');
const ctx=ctxCheck([{role:'system',content:'system'},{role:'assistant',tool_calls:[{id:'1',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',content:'o'.repeat(1000)}],[{function:{name:'read_file'}}],{tokens:10000});
ok(ctx.e.tools>0&&ctx.e.toolOthers>0&&ctx.e.toolOutputs>ctx.e.toolOthers,'counts tool definitions, calls and outputs separately');
ok(ctx.cats.some(x=>x[1]==='Tool'&&x[2]==='#ef4444')&&ctx.cats.some(x=>x[1]==='Tool others'&&x[2]==='#f97316')&&ctx.cats.some(x=>x[1]==='Tool outputs'&&x[2]==='#fb923c'),'uses the requested red-to-orange tool categories');
const activeStart=src.indexOf('function activeTools(){'),activeEnd=src.indexOf('function toolInfo(){',activeStart);
if(activeStart<0||activeEnd<0)throw Error('active tool helper not found');
const activeTools=new Function('TOOLINFO','groupOk','wsOpenPath','wsIsNew','spawnSlots','playwrightReady',src.slice(activeStart,activeEnd)+';return activeTools()');
const playwright={group:'playwright',function:{name:'playwright',description:'Use Playwright',parameters:{properties:{path:{type:'string'},timeout:{type:'integer'}},required:['path']}}};
const selected=activeTools({tools:[playwright]},()=>true,'app/index.html',false,()=>[],()=>true);
ok(selected.length===1&&!selected[0].function.parameters.properties.path&&!selected[0].function.parameters.required.includes('path')&&selected[0].function.description.includes('app/index.html'),'Playwright targets the open file without asking the model for a path');
ok(activeTools({tools:[playwright]},()=>true,'app/index.html',true,()=>[],()=>false).length===0&&activeTools({tools:[playwright]},()=>true,'notes.md',false,()=>[],()=>false).length===0,'hides Playwright for new or non-HTML files');
console.log('ALL PASSED');
