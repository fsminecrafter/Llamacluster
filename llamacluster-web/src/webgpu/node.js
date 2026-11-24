// "Use this device (WebGPU)": turns this browser tab into a LlamaCluster node.
//
// A page can't accept connections, so the tab reaches out instead (see "browser nodes" in controller.py):
//   register  POST /api/browser-nodes              -> shows up as a node of kind "browser"
//   poll      GET  /api/browser-nodes/<id>/poll    -> long poll: the next chat request(s) + which ones to abort
//   stream    POST /api/browser-nodes/<id>/jobs/<job>  -> OpenAI chunks as WebLLM produces them
//   heartbeat POST /api/browser-nodes/<id>/hb      -> state / progress / GPU info (also returns aborts)
// The model runs with WebLLM (WebGPU) inside a Web Worker. This module is a singleton, so sharing keeps going while you
// move between the dashboard and the chat; it stops when the tab is closed or reloaded.
import {useSyncExternalStore} from 'react';
import {authHeaders,askToken} from '../api.js';
import {buildRequest,withTimings,isFatal} from './request.js';

const NAME_KEY='lc_webgpu_name',MODEL_KEY='lc_webgpu_model',AWAKE_KEY='lc_webgpu_awake';
const ls={get:(k,d='')=>{try{return localStorage.getItem(k)??d}catch{return d}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}}};
// one id per tab (survives reloads of that tab), so a re-registering tab gets its node back instead of a duplicate
export const clientId=(()=>{
  const mk=()=>(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)+Date.now().toString(36));
  try{let id=sessionStorage.getItem('lc_webgpu_client');if(!id){id=mk();sessionStorage.setItem('lc_webgpu_client',id)}return id}catch{return mk()}
})();

// ------------------------------------------------------------------ observable state
const IDLE={phase:'idle',model:'',progress:0,text:'',error:'',notice:'',nodeId:'',nodeName:'',conn:'ok',busy:false,queued:0,served:0,tps:0,vision:false,ctx:0,sizeMB:0,gpu:''};
let S={...IDLE};const subs=new Set();
const set=p=>{S={...S,...p};subs.forEach(f=>f())};
export const getState=()=>S;
export const subscribe=f=>{subs.add(f);return()=>subs.delete(f)};
export const useWebGPUNode=()=>useSyncExternalStore(subscribe,getState);
export const isSharing=st=>st.phase==='loading'||st.phase==='ready'||st.phase==='error';

// ------------------------------------------------------------------ http
class HttpError extends Error{constructor(status,msg){super(msg);this.status=status}}
async function call(path,method='GET',body,signal,_retry){
  const r=await fetch(path,{method,headers:authHeaders({'Content-Type':'application/json'}),body:body===undefined?undefined:JSON.stringify(body),signal});
  if(r.status===401&&!_retry&&askToken())return call(path,method,body,signal,true);
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new HttpError(r.status,d.error?.message||d.error||'HTTP '+r.status);
  return d;
}
const sleep=(ms,signal)=>new Promise(res=>{const t=setTimeout(res,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);res()},{once:true})});

// ------------------------------------------------------------------ device + models
export async function checkSupport(){
  if(typeof window==='undefined'||!window.isSecureContext)return {ok:false,code:'insecure',message:
    'WebGPU only works on a secure origin (https:// or http://localhost). This page was opened over plain http:// on the network. '+
    'On the computer that runs the controller, open http://localhost:'+(location.port||'7870')+' instead. On another device, serve the controller over https, '+
    'or (Chrome / Edge) allow this address in chrome://flags/#unsafely-treat-insecure-origin-as-secure.'};
  if(!navigator.gpu)return {ok:false,code:'nogpu',message:'This browser has no WebGPU. Use a recent Chrome or Edge (113+), Safari 26+ or Firefox 141+ (Windows), and make sure hardware acceleration is on.'};
  let adapter=null;
  try{adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'})||await navigator.gpu.requestAdapter()}catch{}
  if(!adapter)return {ok:false,code:'noadapter',message:'The browser supports WebGPU but found no usable GPU (disabled hardware acceleration or a blocklisted driver).'};
  let info=adapter.info;
  if(!info&&adapter.requestAdapterInfo){try{info=await adapter.requestAdapterInfo()}catch{}}
  info=info||{};
  const name=info.description||[info.vendor,info.architecture].filter(Boolean).join(' ')||'WebGPU GPU';
  return {ok:true,name,vendor:info.vendor||'',architecture:info.architecture||'',features:[...adapter.features],
    maxStorage:adapter.limits?.maxStorageBufferBindingSize||0,software:!!info.isFallbackAdapter};
}

let llm;
export const loadWebLLM=()=>llm||(llm=import('@mlc-ai/web-llm'));

// Prebuilt WebLLM models this GPU can run, smallest first.
export async function listModels(support){
  const w=await loadWebLLM(),have=new Set(support?.features||[]);
  return w.prebuiltAppConfig.model_list.filter(m=>m.model_type!==w.ModelType.embedding).map(m=>({
    id:m.model_id,vramMB:Math.round(m.vram_required_MB||0),low:!!m.low_resource_required,vision:m.model_type===w.ModelType.VLM,
    ctx:m.overrides?.context_window_size||4096,
    // many f16 builds don't list shader-f16 as required, but their kernels need it
    features:/f16/i.test(m.model_id)&&!(m.required_features||[]).includes('shader-f16')?[...(m.required_features||[]),'shader-f16']:(m.required_features||[]),bufferBytes:m.buffer_size_required_bytes||0,
    toolsNative:w.functionCallingModelIds.includes(m.model_id)}))
    .filter(m=>m.features.every(f=>have.has(f))&&!(support?.maxStorage&&m.bufferBytes>support.maxStorage))
    .sort((a,b)=>a.vramMB-b.vramMB||a.id.localeCompare(b.id));
}
export function pickDefault(models){
  const last=ls.get(MODEL_KEY);if(last&&models.some(m=>m.id===last))return last;
  for(const id of ['Llama-3.2-1B-Instruct-q4f16_1-MLC','Llama-3.2-1B-Instruct-q4f32_1-MLC','Qwen2.5-1.5B-Instruct-q4f16_1-MLC'])if(models.some(m=>m.id===id))return id;
  return models.find(m=>m.vramMB>=700)?.id||models[0]?.id||'';
}
export async function isCached(id){try{const w=await loadWebLLM();return await w.hasModelInCache(id)}catch{return false}}
export function defaultName(){
  const saved=ls.get(NAME_KEY);if(saved)return saved;
  const ua=navigator.userAgent,b=/Edg\//.test(ua)?'Edge':/OPR\//.test(ua)?'Opera':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'Browser';
  const o=/Android/.test(ua)?'Android':/iPhone|iPad/.test(ua)?'iOS':/Windows/.test(ua)?'Windows':/Mac OS/.test(ua)?'macOS':/Linux|X11/.test(ua)?'Linux':'';
  return `${b}${o?' on '+o:''} (WebGPU)`;
}
export const keepAwakePref=()=>ls.get(AWAKE_KEY,'1')!=='0';

// ------------------------------------------------------------------ the running session
let sess=null;
const wake=s=>{const w=s.wake;s.wake=null;w&&w()};
const info=s=>({
  state:S.phase==='ready'?'ready':S.phase==='loading'?'loading':S.phase==='error'?'error':'idle',
  model:S.model,progress:S.progress,text:S.text,error:S.error,busy:S.busy,vision:S.vision,tools:false,ctx:S.ctx,size_mb:S.sizeMB,
  cores:navigator.hardwareConcurrency||0,memory_gb:navigator.deviceMemory,
  gpu:{name:s.support.name,vendor:s.support.vendor,architecture:s.support.architecture}});
async function register(s){
  const d=await call('/api/browser-nodes','POST',{name:s.name,client_id:clientId,info:info(s)},s.ac.signal);
  s.nodeId=d.id;set({nodeId:d.id,nodeName:d.name,conn:'ok'});return d;
}
async function heartbeat(s){
  if(!s.alive||!s.nodeId)return;
  try{const d=await call(`/api/browser-nodes/${s.nodeId}/hb`,'POST',{info:info(s)},s.ac.signal);(d.cancel||[]).forEach(id=>cancelJob(s,id))}catch{/* the poll loop deals with 404 / 410 / outages */}
}
let hbAt=0;
const hbSoon=(s,force=true)=>{const n=performance.now();if(force||n-hbAt>1500){hbAt=n;heartbeat(s)}};

// ask WebLLM to stop the running generation (once per job)
function interrupt(s,ctl){if(ctl.interrupted)return;ctl.interrupted=true;try{s.engine?.interruptGenerate()}catch{}}
function cancelJob(s,id){
  const ctl=s.jobs.get(id);if(!ctl)return;
  ctl.cancelled=true;
  if(s.cur===id)interrupt(s,ctl);
}

async function pollLoop(s){
  let fails=0;
  while(s.alive){
    try{
      const d=await call(`/api/browser-nodes/${s.nodeId}/poll?wait=15`,'GET',undefined,s.ac.signal);
      if(fails){fails=0;set({conn:'ok'})}
      (d.cancel||[]).forEach(id=>cancelJob(s,id));
      for(const j of d.jobs||[]){s.jobs.set(j.id,{cancelled:false});s.queue.push(j)}
      if(d.jobs?.length){set({queued:s.queue.length});wake(s)}
    }catch(e){
      if(!s.alive)return;
      if(e.status===410){remoteRemoved(s);return}                 // removed from the dashboard
      fails++;set({conn:'reconnecting'});
      if(e.status===404){try{await register(s);fails=0;set({conn:'ok'});continue}catch{}}   // controller restarted / forgot us
      await sleep(Math.min(8000,500*2**Math.min(fails,4)),s.ac.signal);
    }
  }
}

async function runner(s){
  while(s.alive){
    const job=s.queue.shift();
    if(!job){await new Promise(r=>{s.wake=r});continue}
    const ctl=s.jobs.get(job.id);
    if(ctl&&!ctl.cancelled)await runJob(s,job,ctl);
    s.jobs.delete(job.id);
  }
}

async function runJob(s,job,ctl){
  s.cur=job.id;set({busy:true,queued:s.queue.length});hbSoon(s);
  const url=`/api/browser-nodes/${s.nodeId}/jobs/${job.id}`;
  let buf=[],last=0,chain=Promise.resolve(),dropped=false,usage=null;
  // posts go out one after another so the controller sees the chunks in order
  const send=payload=>{chain=chain.then(async()=>{
    if(dropped)return;
    try{await call(url,'POST',payload,s.ac.signal)}
    catch(e){if(e.status===404){dropped=true;ctl.cancelled=true;interrupt(s,ctl)}}   // controller dropped it (Stop)
  });return chain};
  const flush=extra=>{const chunks=buf;buf=[];last=performance.now();return send({chunks,...extra})};
  try{
    const stream=await s.engine.chat.completions.create(buildRequest(job.body,{vision:s.vision}));
    for await(const c of stream){
      // after a Stop keep draining (WebLLM wants the stream finished, not abandoned): interrupting ends it within a token
      if(ctl.cancelled){interrupt(s,ctl);continue}
      if(c.usage)usage=c.usage;
      buf.push(withTimings(c));
      if(performance.now()-last>60)flush();
    }
    if(!ctl.cancelled)await flush({done:true});
    else await chain;
    const tps=usage?.extra?.decode_tokens_per_s;
    set({served:S.served+1,...(tps?{tps:Math.round(tps*10)/10}:{})});
  }catch(e){
    const msg=String(e?.message||e);
    if(!ctl.cancelled)await flush({done:true,error:msg});
    if(isFatal(msg))fail(s,'The GPU stopped responding: '+msg);
  }finally{
    s.cur=null;set({busy:false,queued:s.queue.length});hbSoon(s);
  }
}

function fail(s,msg){set({phase:'error',error:msg,busy:false});hbSoon(s)}

function remoteRemoved(s){teardown(s,'This device was removed from the cluster in the controller.')}
async function teardown(s,notice=''){
  if(sess===s)sess=null;
  s.alive=false;s.ac.abort();clearInterval(s.hbTimer);wake(s);
  try{s.lock?.release()}catch{}
  const eng=s.engine;
  try{await Promise.race([eng?.unload(),sleep(3000)])}catch{}
  try{s.worker?.terminate()}catch{}
  set({...IDLE,notice});
}

async function keepAwake(s){
  try{if(s.keepAwake&&'wakeLock' in navigator&&!s.lock){s.lock=await navigator.wakeLock.request('screen');s.lock.addEventListener('release',()=>{s.lock=null})}}catch{}
}
if(typeof document!=='undefined'){
  document.addEventListener('visibilitychange',()=>{if(sess?.alive&&document.visibilityState==='visible')keepAwake(sess)});
  // closing / reloading the tab: drop the node right away instead of letting it time out
  addEventListener('pagehide',e=>{if(sess?.nodeId&&!e.persisted)try{fetch(`/api/browser-nodes/${sess.nodeId}`,{method:'DELETE',keepalive:true,headers:authHeaders()})}catch{}});
}

// WebLLM engine in a Web Worker. (Test seam: tests/test_webgpu_node.mjs swaps in a fake engine to drive the real protocol.)
let engineFactory=null;
export const _setEngineFactory=f=>{engineFactory=f};
async function makeEngine(s,modelId,onProgress){
  if(engineFactory)return engineFactory(modelId,onProgress);
  const w=await loadWebLLM();
  if(!s.alive)throw new Error('stopped');
  s.worker=new Worker(new URL('./llm.worker.js',import.meta.url),{type:'module'});
  return w.CreateWebWorkerMLCEngine(s.worker,modelId,{initProgressCallback:onProgress});
}

// ------------------------------------------------------------------ public actions
export async function start(modelId,{name,keepAwake:awake=true,models}={}){
  if(sess)await stop();
  const support=await checkSupport();
  if(!support.ok){set({...IDLE,phase:'error',error:support.message});return}
  const rec=(models||await listModels(support)).find(m=>m.id===modelId);
  if(!rec){set({...IDLE,phase:'error',error:'This GPU cannot run that model.'});return}
  name=(name||'').trim()||defaultName();ls.set(NAME_KEY,name);ls.set(MODEL_KEY,modelId);ls.set(AWAKE_KEY,awake?'1':'0');
  const s=sess={alive:true,name,support,keepAwake:awake,nodeId:'',engine:null,worker:null,queue:[],jobs:new Map(),cur:null,wake:null,lock:null,
    ac:new AbortController(),vision:rec.vision};
  set({...IDLE,phase:'loading',model:modelId,text:'Starting…',vision:rec.vision,ctx:rec.ctx,sizeMB:rec.vramMB,gpu:support.name});
  try{
    await register(s);                                            // visible on the dashboard right away, as "loading"
    s.hbTimer=setInterval(()=>heartbeat(s),5000);
    pollLoop(s);keepAwake(s);
    let lastEmit=0;
    s.engine=await makeEngine(s,modelId,r=>{
      if(!s.alive)return;const n=performance.now();if(n-lastEmit<250&&r.progress<1)return;lastEmit=n;
      set({progress:Math.max(0,Math.min(1,r.progress||0)),text:String(r.text||'').slice(0,160)});hbSoon(s,false);
    });
    if(!s.alive){try{await s.engine.unload()}catch{}return}
    set({phase:'ready',progress:1,text:''});
    await heartbeat(s);                                           // the controller knows we are ready when start() returns
    runner(s);
  }catch(e){
    if(!s.alive)return;
    const m=String(e?.message||e);
    fail(s,/failed to fetch|networkerror|load failed/i.test(m)?'Could not download the model files. This browser needs access to huggingface.co and github.com (the first time; they are cached afterwards).':m);
    await heartbeat(s);
  }
}

export async function stop(){
  const s=sess;if(!s)return;
  if(s.nodeId){try{await call(`/api/browser-nodes/${s.nodeId}`,'DELETE')}catch{}}
  await teardown(s);
}
