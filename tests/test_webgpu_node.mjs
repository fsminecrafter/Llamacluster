// node tests/test_webgpu_node.mjs
// Drives the browser-node client (llamacluster-web/src/webgpu/node.js) against a REAL controller.py, with a fake
// WebLLM engine and a fake navigator.gpu - so the whole register / poll / stream / stop / reconnect protocol is exercised
// end to end without a GPU. (Needs `npm install` in llamacluster-web for the react import.)
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.join(here,'..');
let fails=0;const ok=(c,m)=>{if(!c){fails++;console.log('FAIL',m)}else console.log('ok  ',m)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(f,ms=8000,step=25)=>{const t=Date.now();for(;;){const v=await f();if(v)return v;if(Date.now()-t>ms)return false;await sleep(step)}};

const freePort=()=>new Promise(res=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p))})});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lc-webgpu-'));
const port=await freePort(),base=`http://127.0.0.1:${port}`;
let ctl=null;
async function startController(){
  ctl=spawn('python3',['-u',path.join(root,'controller.py'),'--local-only','--port',String(port),'--state',path.join(tmp,'nodes.json'),'--workspace',path.join(tmp,'ws'),'--no-exec'],{stdio:['ignore','pipe','pipe']});
  let out='';ctl.stdout.on('data',d=>out+=d);ctl.stderr.on('data',d=>out+=d);
  if(!await until(()=>/listening on/.test(out),10000))throw new Error('controller did not start:\n'+out);
}
const stopController=async()=>{if(!ctl)return;const c=ctl;ctl=null;c.kill('SIGKILL');await new Promise(r=>c.once('exit',r))};

// ---- a fake browser: page-relative fetch, secure context, a WebGPU adapter
const realFetch=globalThis.fetch;
globalThis.fetch=(u,o)=>realFetch(typeof u==='string'&&u.startsWith('/')?base+u:u,o);
globalThis.window={isSecureContext:true};
globalThis.location={port:String(port),hash:'',pathname:'/',search:''};
const setNav=gpu=>Object.defineProperty(globalThis,'navigator',{configurable:true,value:{hardwareConcurrency:8,userAgent:'node',...(gpu?{gpu:{requestAdapter:async()=>({
  features:new Set(['shader-f16']),limits:{maxStorageBufferBindingSize:1<<30},info:{vendor:'fake',architecture:'test',description:'Fake GPU 9000'}})}}:{})}});
setNav(true);

const chunk=(text,finish=null)=>({id:'c1',object:'chat.completion.chunk',model:'Fake-MLC',choices:[{index:0,delta:text==null?{}:{content:text},finish_reason:finish}]});
const fake={calls:[],interrupts:0,stop:false,unloaded:0,
  chat:{completions:{create:async req=>{
    fake.calls.push(req);fake.stop=false;     // like WebLLM, every generation starts with a clean interrupt flag
    const slow=JSON.stringify(req.messages).includes('SLOW'),words=slow?Array(400).fill('x'):['Hel','lo',' world'];
    return (async function*(){
      for(const w of words){if(fake.stop){fake.stop=false;break}await sleep(15);yield chunk(w)}
      yield chunk(null,'stop');
      yield {id:'c1',object:'chat.completion.chunk',model:'Fake-MLC',choices:[],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8,extra:{decode_tokens_per_s:42.5}}};
    })();
  }}},
  interruptGenerate(){fake.interrupts++;fake.stop=true},
  async unload(){fake.unloaded++}};

const N=await import(pathToFileURL(path.join(root,'llamacluster-web/src/webgpu/node.js')).href);
const MODELS=[{id:'Fake-MLC',vramMB:100,ctx:2048,vision:false}];
N._setEngineFactory(async(id,onProgress)=>{onProgress({progress:.5,text:'half'});onProgress({progress:1,text:'done'});return fake});
const nodes=async()=>(await realFetch(base+'/api/nodes')).json();
const chat=async(body)=>{const r=await realFetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {r,text:await r.text()}};
const sse=t=>t.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6));

try{
  await startController();

  // ---- unsupported browsers get a clear message and nothing is registered
  window.isSecureContext=false;
  await N.start('Fake-MLC',{models:MODELS});
  ok(N.getState().phase==='error'&&/secure origin/.test(N.getState().error),'insecure page: explains that WebGPU needs https or localhost');
  window.isSecureContext=true;setNav(false);
  await N.start('Fake-MLC',{models:MODELS});
  ok(N.getState().phase==='error'&&/no WebGPU/.test(N.getState().error),'browser without navigator.gpu: explains');
  ok((await nodes()).length===0,'nothing registered when WebGPU is missing');
  setNav(true);

  // ---- start sharing
  await N.start('Fake-MLC',{name:'Fake tab',models:MODELS,keepAwake:false});
  ok(N.getState().phase==='ready','phase ready after the model loaded');
  let list=await nodes();
  ok(list.length===1&&list[0].kind==='browser'&&list[0].name==='Fake tab','node registered with its name and kind');
  ok(list[0].online&&list[0].info.server.state==='ready'&&list[0].info.server.config.model==='Fake-MLC'&&list[0].info.server.config.ctx_size===2048,'node is ready with model + context');
  ok(list[0].info.hardware.gpus[0].name==='Fake GPU 9000','GPU name is reported');
  ok(list[0].info.browser.client_id===N.clientId,'dashboard can tell which node is this tab');

  // ---- streaming through the gateway, request translation
  const body={model:'Fake-MLC',stream:true,max_tokens:-1,temperature:0.2,reasoning_effort:'low',
    tools:[{type:'function',function:{name:'t',parameters:{}}}],
    messages:[{role:'user',content:'first'},{role:'system',content:'be brief'},
      {role:'assistant',content:'',tool_calls:[{id:'1',type:'function',function:{name:'read_file',arguments:'{"p":1}'}}]},
      {role:'tool',tool_call_id:'1',content:'file text'},{role:'user',content:[{type:'text',text:'see'},{type:'image_url',image_url:{url:'data:x'}}]}]};
  let {r,text}=await chat(body);
  const ev=sse(text);
  ok(r.status===200&&r.headers.get('x-llamacluster-node')==='Fake tab','gateway streams from the browser node');
  ok(ev.at(-1)==='[DONE]'&&ev.slice(0,-1).map(e=>JSON.parse(e)).map(j=>j.choices[0]?.delta?.content||'').join('')==='Hello world','streamed text arrives in order: Hello world');
  const usage=ev.slice(0,-1).map(e=>JSON.parse(e)).find(j=>j.usage);
  ok(usage?.timings?.predicted_per_second===42.5,'usage chunk also carries llama-server style timings (tok/s)');
  const sent=fake.calls[0];
  ok(!('tools' in sent)&&!('max_tokens' in sent)&&!('reasoning_effort' in sent)&&sent.temperature===0.2,'tools / max_tokens=-1 / unknown fields are not forwarded');
  ok(sent.messages[0].role==='system'&&sent.messages[0].content==='be brief','system text is moved to the front');
  ok(sent.messages.some(m=>m.role==='user'&&/Result of tool/.test(m.content))&&!sent.messages.some(m=>m.role==='tool'),'tool messages are turned into plain text');
  ok(typeof sent.messages.at(-1).content==='string'&&/image omitted/.test(sent.messages.at(-1).content),'images are dropped for a text-only model');

  ({text}=await chat({model:'Fake-MLC',messages:[{role:'user',content:'again'}]}));
  ok(JSON.parse(text).choices[0].message.content==='Hello world','non-streaming request works too');
  ok(await until(()=>{const st=N.getState();return st.served===2&&st.tps===42.5&&!st.busy},3000),'served counter and tok/s are tracked, node idle again');

  // ---- Stop in the chat reaches the engine
  const runId=(await (await realFetch(base+'/api/chat/runs',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({request_id:'r-1',body:{stream:true,model:'Fake-MLC',messages:[{role:'user',content:'SLOW please'}]}})})).json()).id;
  await until(()=>N.getState().busy,3000);
  await realFetch(base+'/api/chat/runs/'+runId,{method:'DELETE'});
  ok(await until(()=>fake.interrupts>0,4000),'Stop in the chat interrupts generation on the GPU');
  await sleep(300);
  ok(fake.interrupts===1,'the interrupt is sent once, not per leftover chunk');
  ok(await until(()=>!N.getState().busy,4000),'node is idle again after the interrupt');
  ({r,text}=await chat({model:'Fake-MLC',messages:[{role:'user',content:'after stop'}]}));
  ok(JSON.parse(text).choices[0].message.content==='Hello world','node keeps serving after a stopped request');

  // ---- controller restart: the tab notices (404) and registers again
  await stopController();
  await sleep(600);
  await startController();
  ok(await until(async()=>{const l=await nodes();return l.length===1&&l[0].online&&l[0].info.server.state==='ready'},25000,200),'after a controller restart the tab re-registers by itself');
  ({text}=await chat({model:'Fake-MLC',messages:[{role:'user',content:'post restart'}]}));
  ok(JSON.parse(text).choices[0].message.content==='Hello world','serving again after re-registering');

  // ---- removed in the dashboard: the tab stops sharing
  const id=(await nodes())[0].id;
  await realFetch(base+'/api/nodes/'+id,{method:'DELETE'});
  ok(await until(()=>N.getState().phase==='idle',4000)&&/removed/.test(N.getState().notice),'removing the node on the controller stops the tab (with a notice)');
  const unloadedAfterRemote=fake.unloaded;
  ok(unloadedAfterRemote>=1,'the engine was unloaded');

  // ---- Stop sharing in the tab removes the node
  await N.start('Fake-MLC',{name:'Fake tab',models:MODELS,keepAwake:false});
  ok((await nodes()).length===1,'sharing again registers a node');
  await N.stop();
  ok(N.getState().phase==='idle'&&(await nodes()).length===0&&fake.unloaded>unloadedAfterRemote,'Stop sharing unregisters the node and frees the engine');

  // ---- load failure: visible, not served, can be cleared
  N._setEngineFactory(async()=>{throw new Error('Cannot find adapter that supports shader-f16')});
  await N.start('Fake-MLC',{name:'Broken tab',models:MODELS,keepAwake:false});
  list=await nodes();
  ok(N.getState().phase==='error'&&/shader-f16/.test(N.getState().error),'a failed model load is reported');
  ok(list.length===1&&list[0].info.server.state==='stopped'&&/shader-f16/.test(list[0].info.browser.error),'the dashboard shows it as not serving, with the reason');
  ({r}=await chat({model:'Fake-MLC',messages:[{role:'user',content:'x'}]}));
  ok(r.status===503,'a node that failed to load takes no requests');
  await N.stop();
  ok((await nodes()).length===0,'cleared');
}catch(e){fails++;console.log('FAIL (exception)',e&&e.stack||e)}
finally{await stopController();fs.rmSync(tmp,{recursive:true,force:true})}
console.log(fails?`\n${fails} FAILED`:'\nall ok');
process.exit(fails?1:0);
