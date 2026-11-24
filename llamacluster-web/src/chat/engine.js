// Chat engine: a faithful port of the chat logic in the old ui.html, without any DOM. State lives in store.js (CH / rt);
// everything that used to call renderChat() now calls emit(), and React components render from that state.
import {api,managedChatStream} from '../api.js';
import {CH,rt,emit,emitNow,saveChat,clamp,short,sleep,MODES,IMGS,idbPut,idbGet,idbClear,newId,capsFor,capsNow,effPerm,readyNodes,ctxCapacity} from './store.js';
import {nodeModel} from './strength.js';
import {taskTool,MODE_GROUPS,MODE_DENY} from '../tools.js';
import {parseSchedule} from './schedule.js';
import {ctxEstimate,ctxSegments,compactTranscript,scriptCompactSummary,COMPACT_SYS} from './ctx.js';
import {llmCall,sseHandler,validArgs,addEffort} from './llm.js';
import {pickNodes,parsePlan,LEADER_SYS,tierFor} from './leader.js';
import {runAgentTool,queueSharedChatMessage,flushAgentMessages,clearAgents,agentSpawnSlots,spawnSlots} from './agents.js';

export const fmtTok=n=>Math.round(n).toLocaleString();
const AGENT_TOOLS=['spawn','tell','interrupt','status','despawn','agent_done'];
export const AUTO_COMPACT_PCT=97;
const btwControllers=new Map();let btwSeq=0;
export const lastUserText=()=>{for(let i=CH.msgs.length-1;i>=0;i--)if(CH.msgs[i].role==='user'&&!CH.msgs[i].auto&&!CH.msgs[i].agentName)return CH.msgs[i].content;return ''};
export const notice=text=>{CH.msgs.push({role:'assistant',local:true,content:text});saveChat();emit()};
const DUMMY_ANSWERS=[
  'Absolutely. Start with one small step, then build from there.',
  'The simplest approach is often the easiest to test.',
  'Try breaking the problem into smaller pieces and checking each one.',
  'A quick experiment should give you a useful signal.',
  'Write down the goal, then test one change at a time.'
];
function dummyResponse(images=[]){
  const answer=DUMMY_ANSWERS[Math.floor(Math.random()*DUMMY_ANSWERS.length)];
  const attachments=images.length?`\n\n${images.length} image${images.length===1?'':'s'} received; not analyzed in dummy mode.`:'';
  return `Dummy AI: ${answer}${attachments}`;
}
function waitForDummy(signal,ms){
  return new Promise(resolve=>{
    if(signal.aborted){resolve(false);return}
    let timer;
    const onAbort=()=>{clearTimeout(timer);resolve(false)};
    timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve(true)},ms);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}
async function dummyReply(signal){
  const user=[...CH.msgs].reverse().find(m=>m.role==='user'&&!m.auto&&!m.agentName);
  const a={role:'assistant',content:'',node:'Dummy AI',streaming:true};CH.msgs.push(a);emit();
  const completed=await waitForDummy(signal,2000+Math.floor(Math.random()*8001));
  if(completed&&!signal.aborted)a.content=dummyResponse(user?.images||[]);
  else if(!signal.cleared)a.stopped=true;
  delete a.streaming;
  if(CH.mode==='plan'&&!a.stopped&&!signal.aborted)a.plan='pending';
  emit();return a;
}

// ======================================================================= tools
export async function loadTools(){
  try{rt.toolinfo=await api('/api/tools')}catch{rt.toolinfo=null}
  (rt.toolinfo?.tools||[]).filter(t=>t.optional).forEach(t=>{if(CH.tools[t.group]===undefined)CH.tools[t.group]=!!t.default_on});
  saveChat();emit();
}
export const isOptGroup=g=>!!(rt.toolinfo?.tools||[]).find(t=>t.group===g&&t.optional);
export const playwrightReady=()=>!!rt.wsOpenPath&&!rt.wsIsNew&&/\.html?$/i.test(rt.wsOpenPath);
// which tool groups each mode may use (null = whatever is ticked): plan researches read-only, ask only looks at the workspace
export const groupOk=g=>!!CH.tools[g]&&!(MODE_DENY[CH.mode]||[]).includes(g)&&(!MODE_GROUPS[CH.mode]||MODE_GROUPS[CH.mode].includes(g)||(CH.mode==='plan'&&isOptGroup(g)));
export function chatImageRefs(){
  const refs=[],seen=new Set();
  for(const m of CH.msgs||[]){
    for(const image of m.images||[])if(image?.id&&!seen.has(image.id)&&IMGS[image.id]){seen.add(image.id);refs.push({id:image.id,name:image.name||'chat attachment'})}
    if(m.image&&!seen.has(m.image)&&IMGS[m.image]){seen.add(m.image);refs.push({id:m.image,name:m.image_name||'tool image'})}
  }
  return refs;
}
export function activeTools(model=CH.model,route=CH.route,agentId=null){
  if(!rt.toolinfo)return [];
  return rt.toolinfo.tools.filter(t=>groupOk(t.group)).map(t=>{
    const f=structuredClone(t.function);
    if(f.name==='spawn'){
      const live=CH.agents.length<3&&['Hydrogen','Indium','Sulfur'].some(n=>!CH.agents.some(a=>a.name===n))&&agentSpawnSlots().length>0;
      const slots=spawnSlots(),models=[...new Set([...slots,...(live?agentSpawnSlots():[])].map(x=>x.model))];
      if(!models.length)return null;
      f.parameters.properties.model={type:'string',enum:models,description:'Select one of these ready models; nodes without a free slot will not be used.'};
      f.parameters.properties.mode.enum=[...(live?['agent']:[]),...(slots.length?['parallel','debate']:[])];
      if(!live)f.description+=' No free named-agent slot is currently available; parallel/debate mode may still be used.';
    }
    if(['tell','interrupt','status','despawn'].includes(f.name)){
      const targets=CH.agents.filter(a=>f.name==='status'||a.id!==agentId).map(a=>a.name);
      if(agentId&&(f.name==='tell'||f.name==='interrupt'||f.name==='status'))targets.unshift('Calcium');
      if(!targets.length)return null;
      f.parameters.properties.target={type:'string',enum:targets,description:'Choose a currently active agent.'};
      if(f.name==='status')f.parameters.required=[];
    }
    if(f.name==='agent_done'&&!agentId)return null;
    if(agentId&&(f.name==='question'||f.name==='despawn'))return null;
    if(agentId&&f.name==='interrupt'&&!CH.agents.some(a=>a.id!==agentId))return null;
    if(AGENT_TOOLS.includes(f.name)&&!CH.tools[f.name])return null;
    if(AGENT_TOOLS.includes(f.name)&&['ask','orchestra','leader'].includes(CH.mode))return null;
    if(f.name==='playwright'){
      if(!playwrightReady())return null;
      delete f.parameters.properties.path;f.parameters.required=(f.parameters.required||[]).filter(x=>x!=='path');
      f.description+=' Currently opened file: '+rt.wsOpenPath+'.';
    }
    if(f.name==='view_image'){
      if(!capsFor(model,route).vision)return null;
      const images=chatImageRefs();
      f.parameters.properties.attachment.description='1-based chat image number. Available: '+(images.length?images.map((x,i)=>`${i+1} "${x.name}"`).join(', '):'none')+'. Use path instead for a workspace image.';
      if(images.length)f.parameters.properties.attachment.enum=images.map((_,i)=>i+1);
    }
    return {type:'function',function:f};
  }).filter(Boolean);
}
export function toolNotes(model=CH.model,route=CH.route,agentId=null,compact=false){
  let tools=activeTools(model,route,agentId);
  if(compact){
    const keep=new Set(['list_files','read_file','search_files','write_file','edit_file','delete_file','view_image','calculate','tell','interrupt','status','agent_done']);
    const brief={list_files:'list workspace files',read_file:'read a workspace file',search_files:'search workspace files',write_file:'create a workspace file',edit_file:'edit a workspace file',delete_file:'delete a workspace file',view_image:'inspect (not generate) an image',calculate:'calculate',tell:'message an agent without interrupting',interrupt:'redirect an agent immediately',status:'check agent status',agent_done:'finish your assignment'};
    const notes=tools.filter(t=>keep.has(t.function.name)).map(t=>`- ${t.function.name}: ${brief[t.function.name]}.`);
    return notes.length?'\n\nAvailable tools:\n'+notes.join('\n'):'';
  }
  const names=tools.map(t=>t.function.name),L=[],has=n=>names.includes(n);
  if(has('calculate'))L.push('- calculate: an exact, safe calculator. Use it for any non-trivial arithmetic or maths (big numbers, fractions, matrices, statistics, primes, integrals, derivatives, solving equations) instead of working it out in your head, and report what it returns.');
  if(has('convert_units'))L.push('- convert_units: converts between units (length, mass, temperature, data size ...).');
  if(has('question'))L.push('- question: ask the user a question when you need a decision or information you cannot find yourself. Give 2-6 short options when there are sensible choices (the user can also type their own answer). Ask one question at a time and never ask what you can look up or decide yourself.');
  if(has('task'))L.push('- task: a visible to-do list for the user. For work with several steps, add the tasks first (action add), set a task to doing when you start it and to done when it is finished (action set), and remove tasks that no longer apply (action remove).'+(CH.tasks?.length?'\n  Current tasks:\n'+CH.tasks.map(t=>`  #${t.id} [${t.status}] ${t.title}`).join('\n'):''));
  if(has('date_time'))L.push('- date_time: the current time in any time zone, time zone conversion and date arithmetic.');
  if(has('spawn'))L.push('- spawn: use mode "agent" to add a persistent helper model to this same chat, or "parallel"/"debate" for one-shot helpers. Helpers use their selected model and may have different tools or abilities; vision means they can inspect images, not generate or edit them. Select a model from the tool schema.');
  if(has('tell'))L.push('- tell: send a non-interrupting message to Calcium or another live agent; it waits until a busy recipient finishes its current reply.');
  if(has('interrupt'))L.push('- interrupt: stop a live agent reply and redirect it immediately. You may also interrupt Calcium; it will receive your message and restart on it.');
  if(has('status'))L.push('- status: read agent state without sending a message or interrupting its work.');
  if(has('despawn'))L.push('- despawn: remove a live agent that is no longer needed.');
  if(has('agent_done'))L.push('- agent_done: call this when you consider your own assignment complete; then give a concise final response.');
  if(has('runweb'))L.push('- runweb: use after building or changing a web page to execute its HTML, inspect browser console errors, and review the screenshot when available.');
  if(has('playwright'))L.push('- playwright: use Playwright on the currently open saved HTML file '+(rt.wsOpenPath?'('+rt.wsOpenPath+')':'')+' to inspect console errors and its screenshot after web changes.');
  if(has('view_image'))L.push('- view_image: inspect a workspace image by path, or a previous chat attachment using its listed 1-based attachment number. Use this when you need to examine image contents; the image itself is sent to you.');
  return L.length?'\n\nExtra tools you can use:\n'+L.join('\n'):'';
}
export const sysText=(model=CH.model,route=CH.route)=>((CH.sys2||'').replace(/\{\{date\}\}/g,new Date().toString()).replace(/\{\{workspace\}\}/g,rt.toolinfo?.workspace||'the workspace').trim()+toolNotes(model,route)).trim();

// ---- mode notes
const PLAN_NOTE=`\n\nPLAN MODE is on. Do NOT change anything: you may research with the read-only tools (web_search, fetch_url, list_files, read_file) but must not write, edit or delete, and must not claim to have done so. When you have enough information, reply with a concrete plan in markdown — **Goal**, **Steps** (numbered; say which files or tools each step touches), **Risks / open questions** — and stop. The user will accept or decline it; do not start executing.`;
const ASK_NOTE=()=>`\n\nASK MODE is on. The user wants answers about the files in the workspace (${rt.toolinfo?.workspace||'the workspace'}), nothing else. You only have read-only workspace tools (list_files, read_file, search_files): look at the files before answering, quote file paths and line numbers, and say so plainly when the workspace does not contain the answer. Do not modify anything, do not suggest you already did, and do not run commands.${rt.askTree?`\n\nWorkspace files (may be incomplete):\n${rt.askTree}`:''}`;
export async function loadAskTree(){
  rt.askTree='';
  try{const d=await api('/api/workspace'),f=d.files||[];rt.askTree=f.slice(0,200).map(x=>`${x.path} (${x.size} B)`).join('\n')+(f.length>200||d.truncated?'\n… and more (use list_files / search_files)':'')||'(the workspace is empty)'}catch{}
}
const SOFTWARE_NOTE=sw=>`\n\nSOFTWARE MODE is on. You are a software engineer working completely alone — nobody is available to answer questions — on a fixed time budget (${sw.minutes} minutes in total; every cycle message tells you how much is left). The project goal is:\n"""\n${sw.goal}\n"""\nRules:\n- Work autonomously. Never ask the user a question or wait for confirmation; when something is unclear, pick the most reasonable option and write the assumption down.\n- Keep everything inside the workspace, in one project folder. Use only what is already installed (for example the Python standard library) — assume you cannot download packages.\n- Repeat build → test → troubleshoot → improve. After every change RUN something that checks it (tests, the program, a syntax check) and read the real output. Never claim something works unless a tool result shows it.\n- Commands must not wait for input and must finish by themselves (use short timeouts; never leave a server running in the foreground).\n- Your chat history is trimmed to the most recent messages, so keep a file SOFTWARE_NOTES.md at the top of the project folder and read it at the start of every cycle: the goal, a plan / TODO checklist, what is done, how to run the program and its tests, the latest test results, known bugs, ideas. If it does not exist yet, this is the first cycle: write the plan there, then start building the first working version.\n- Use tools instead of describing what you would do; keep replies to a few lines.`;
const SW_FINAL='[Time is up] The time budget is over, so stop building. Do at most one quick last check (read SOFTWARE_NOTES.md; run the tests once if that is fast), then write the final report for the user: what was built and where (file paths), how to run it and its tests, the latest real test results, known problems, and what you would do next. Do not change any file except SOFTWARE_NOTES.md.';
export const SW_PHASES=[
  {id:'build',label:'Build',ask:'Build the next piece of the project: write or extend the code so it gets closer to the goal.'},
  {id:'test',label:'Test',ask:'Test what exists: write or extend automated tests and RUN them (and run the program itself if it can run on its own). Record the real results.'},
  {id:'fix',label:'Troubleshoot',ask:'Troubleshoot: fix every failing test, error or bug you know of. Read the actual error output, find the root cause, fix it and re-run to confirm. If nothing is failing, hunt for bugs with edge cases and bad input.'},
  {id:'improve',label:'Improve',ask:'Improve: refactor messy code, handle errors and edge cases, improve speed, usability and docs/README, and add the most valuable missing feature.'}];
const pad2=n=>String(n).padStart(2,'0');
export function fmtLeft(ms){ms=Math.max(0,Math.round(ms/1000));const h=Math.floor(ms/3600),m=Math.floor(ms%3600/60),s=ms%60;return h?h+':'+pad2(m)+':'+pad2(s):m+':'+pad2(s)}
const swCycleMsg=(sw,ph)=>`[Cycle ${sw.cycle} · focus: ${ph.label} · time left ${fmtLeft(sw.endsAt-Date.now())}]\nRead SOFTWARE_NOTES.md first. ${ph.ask} If any test or run is currently failing, fix that before anything else, and run something to verify each change. When this cycle is done, update SOFTWARE_NOTES.md (done / next / latest test results / known bugs) and reply with a status of one to three lines.`;
// keep the request small: the latest messages (starting at a user message so chat templates stay valid), older tool output shortened
function swWindow(msgs){
  const KEEP=16;let start=Math.max(0,msgs.length-KEEP);while(start>0&&msgs[start].role!=='user')start--;
  return msgs.slice(start).map((m,i,a)=>m.role==='tool'&&i<a.length-10&&(m.content||'').length>600?{...m,content:m.content.slice(0,600)+' …[older output shortened]'}:m);
}

// ======================================================================= request building
export function userContent(m,vis){   // OpenAI-style multimodal content; text-only models get a note instead of a request they would reject
  const imgs=(m.images||[]).filter(i=>IMGS[i.id]);
  if(!m.images?.length)return m.content;
  if(!vis||!imgs.length)return (m.content||'')+`\n[${m.images.length} image${m.images.length>1?'s':''} attached earlier — not shown to this model]`;
  return [...(m.content?[{type:'text',text:m.content}]:[]),...imgs.map(i=>({type:'image_url',image_url:{url:IMGS[i.id]}}))];
}
function cleanForApi(src){   // drop tool calls with unparseable arguments, and the tool replies that belonged to them
  const dead=new Set();
  const out=src.map(m=>{
    if(m.role!=='assistant'||!m.tool_calls?.length)return m;
    const keep=m.tool_calls.filter(tc=>{const ok=validArgs(tc.function.arguments);if(!ok)dead.add(tc.id);return ok});
    return keep.length===m.tool_calls.length?m:{...m,tool_calls:keep.length?keep:undefined};
  });
  return out.filter(m=>!(m.role==='tool'&&dead.has(m.tool_call_id)));
}
export function apiMessages(extraUser,noImages,model=CH.model,route=CH.route){
  const sys=sysText(model,route)+(CH.mode==='plan'?PLAN_NOTE:CH.mode==='ask'?ASK_NOTE():CH.mode==='software'&&CH.sw?SOFTWARE_NOTE(CH.sw):'')
    +(CH.summary?'\n\n# Earlier in this conversation (summary)\nThe conversation was compacted to save context. What happened before the messages below:\n'+CH.summary:'');
  let src=CH.msgs.filter(m=>m.role!=='orchestra'&&m.role!=='compact'&&!m.local&&!m.streaming);   // (the reply being streamed right now is never sent back)
  if(CH.mode==='software')src=swWindow(src);
  src=cleanForApi(src);
  const vis=!noImages&&capsFor(model,route).vision;
  const msgs=src.map(m=>m.role==='tool'?{role:'tool',tool_call_id:m.tool_call_id,content:m.image&&vis&&IMGS[m.image]?[{type:'text',text:m.content},{type:'image_url',image_url:{url:IMGS[m.image]}}]:m.content+(m.image&&!vis?'\n[screenshot omitted: this model is not vision-capable]':'')}
    :m.role==='assistant'&&m.tool_calls?.length?{role:'assistant',content:m.content||'',tool_calls:m.tool_calls}
    :m.role==='user'&&m.images?.length?{role:'user',content:userContent(m,vis)}
    :{role:m.role,content:m.agentName?`[${m.agentName}]: ${m.content||''}`:m.content});
  if(extraUser)msgs.push({role:'user',content:extraUser});
  return [...(sys?[{role:'system',content:sys}]:[]),...msgs];
}
export function ctxState(){
  const e=ctxEstimate(apiMessages(),activeTools()),last=CH.msgs[CH.msgs.length-1];
  if(last?.streaming){e.user+=Math.ceil((last.content||'').length/3.8);if(last.tool_calls?.length)e.toolOthers+=Math.ceil(JSON.stringify(last.tool_calls).length/3.2)}
  let scale=1,calibrated=false;   // the last reply came with the server's real prompt token count: scale the estimate to it
  for(let i=CH.msgs.length-1;i>=0;i--){const m=CH.msgs[i];if(m.ptok&&m.pest){scale=Math.min(1.8,Math.max(0.6,m.ptok/m.pest));calibrated=true;break}}
  const cap=ctxCapacity();return {...ctxSegments(e,scale,cap),cap,calibrated};
}
const toolTokCap=max=>{const t=clamp(+CH.toolTok||3000,100,100000);return max?Math.min(t,max):t};
export function capTool(s,max){s=String(s??'');const n=toolTokCap(max)*4;return s.length>n?s.slice(0,n)+`\n…[truncated by Max tool result tokens: ${s.length-n} more chars not shown]`:s}
export async function loadMsgImages(){
  let any=false;
  for(const id of new Set([...CH.msgs.flatMap(m=>[...(m.images||[]).map(i=>i.id),...(m.image?[m.image]:[])]),...CH.agents.flatMap(a=>a.messages.flatMap(m=>[...(m.images||[]).map(i=>i.id),...(m.image?[m.image]:[])]))]))
    if(!IMGS[id]){const v=await idbGet(id);if(v){IMGS[id]=v;any=true}}
  if(any)emit();
}

// ======================================================================= the question and task tools
export function askUser(a){
  const q=String(a?.question??'').trim().slice(0,600);
  const o=[...new Set((Array.isArray(a?.options)?a.options:String(a?.options||'').split('\n')).map(x=>String(x).trim().slice(0,120)).filter(Boolean))].slice(0,8);
  if(!q)return Promise.resolve(JSON.stringify({error:'question is required'}));
  if(rt.ask)return Promise.resolve(JSON.stringify({error:'another question is already waiting for the user'}));
  return new Promise(res=>{
    const sig=rt.chatAbort?.signal;
    const done=r=>{if(!rt.ask)return;rt.ask=null;emitNow();res(JSON.stringify(r))};
    sig?.addEventListener('abort',()=>done({error:'stopped by the user'}),{once:true});
    rt.ask={q,o,done};emitNow();
  });
}
export function taskRun(a){const st={tasks:CH.tasks||[],seq:CH.taskSeq||0},r=taskTool(st,a);CH.tasks=st.tasks;CH.taskSeq=st.seq;saveChat();emit();return JSON.stringify(r)}

// ======================================================================= running a tool call
export function approvalText(name,a,why){
  let what;
  if(name==='exec_command')what='run this command'+(a.cwd&&a.cwd!=='.'?' in “'+a.cwd+'”':'')+':\n\n'+short(a.command,600);
  else if(name==='write_file')what='write “'+a.path+'”:\n\n'+short(a.content,400);
  else if(name==='edit_file')what='edit “'+a.path+'”:\n\n- '+short(a.old_str,200)+'\n+ '+short(a.new_str,200);
  else if(name==='delete_file')what='delete “'+a.path+'”';
  else what='call '+name+'('+short(Object.entries(a).map(([k,v])=>k+'='+(typeof v==='string'?v:JSON.stringify(v))).join(', '),300)+')';
  return `Allow the assistant to ${what}\n\n(${why})`;
}
const DECLINED=JSON.stringify({error:'the user declined this tool call - do not retry it; ask what they want instead'});
export async function runTool(tc,context={}){
  let args;try{args=JSON.parse(tc.function.arguments||'{}')}catch(e){return JSON.stringify({error:'arguments were not valid JSON: '+e.message})}
  const name=tc.function.name,info=rt.toolinfo?.tools.find(t=>t.function.name===name);
  if(!info||!CH.tools[info.group])return JSON.stringify({error:'tool is not enabled'});
  if(!groupOk(info.group))return JSON.stringify({error:CH.mode==='plan'?'plan mode is read-only — describe this in the plan instead':CH.mode==='ask'?'ask mode only reads the workspace — this tool is not available here':info.group==='question'?'the user cannot be asked questions in this mode — decide yourself':'tool is not available in this mode'});
  if(name==='view_image'){
    if(!capsFor(context.model||CH.model,context.node||CH.route).vision)return JSON.stringify({error:'view_image requires a running model with image input enabled and a vision projector loaded'});
    if(args.attachment!=null){
      if(args.path)return JSON.stringify({error:'choose either a chat attachment number or a workspace path, not both'});
      const images=chatImageRefs(),index=Number(args.attachment);
      if(!Number.isInteger(index)||index<1||index>images.length)return JSON.stringify({error:'no chat image with attachment number '+args.attachment});
      if(effPerm()==='manual'&&!confirm(approvalText(name,args,'manual mode: every tool call needs your approval')))return DECLINED;
      const image=images[index-1];tc.web_image=image.id;tc.web_image_name=image.name;return JSON.stringify({source:'chat attachment',name:image.name});
    }
    if(!args.path)return JSON.stringify({error:'provide a workspace image path or a chat attachment number'});
  }
  if(name==='question')return askUser(args);   // these two need the user's page, not the controller
  if(name==='task')return taskRun(args);
  if(AGENT_TOOLS.includes(name))return runAgentTool(name,args,context);
  if(name==='playwright'){if(!rt.wsOpenPath||rt.wsIsNew)return JSON.stringify({error:'open and save an HTML file in Workspace → Files before using Playwright'});args.path=rt.wsOpenPath}
  if(rt.toolinfo&&!rt.toolinfo.permissions&&(info.group==='write'||effPerm()==='manual')&&!confirm(approvalText(name,args,'old controller.py without permission levels - restart it to update')))return DECLINED;
  try{
    if(name==='runweb'||name==='playwright')args.screenshot=!!capsFor(context.model||CH.model,context.node||CH.route).vision;
    let r=await api('/api/tools/run','POST',{name,arguments:args,permission:effPerm()});
    if(r.needs_approval){
      if(!confirm(approvalText(name,args,r.reason)))return DECLINED;
      r=await api('/api/tools/run','POST',{name,arguments:args,permission:effPerm(),approved:true});
    }
    if((name==='runweb'||name==='playwright')&&r.result){
      try{const d=JSON.parse(r.result);if(d.screenshot){const id=newId('web');IMGS[id]='data:image/jpeg;base64,'+d.screenshot;await idbPut(id,IMGS[id]);tc.web_image=id;delete d.screenshot}return JSON.stringify(d)}catch{}
    }
    if(name==='view_image'&&r.result){
      const d=JSON.parse(r.result);if(d.error)return JSON.stringify(d);
      if(typeof d.image_base64!=='string'||typeof d.mime_type!=='string')throw new Error('view_image returned an invalid image response');
      const id=newId('view');IMGS[id]=`data:${d.mime_type};base64,${d.image_base64}`;await idbPut(id,IMGS[id]);
      tc.web_image=id;tc.web_image_name=d.path||'workspace image';delete d.image_base64;return JSON.stringify(d);
    }
    return r.result;
  }catch(e){return JSON.stringify({error:e.message})}
}

// ======================================================================= one streamed model reply, and the tool loop
async function streamOnce(signal,opts={}){
  const a={role:'assistant',content:'',reasoning:'',streaming:true};CH.msgs.push(a);emit();
  const mdl=opts.model??CH.model,route=opts.route??CH.route;
  const tl=opts.noTools?[]:activeTools(mdl,route);
  const body={stream:true,stream_options:{include_usage:true},messages:apiMessages(opts.extraUser,false,mdl,route),temperature:+CH.temp};
  if(tl.length)body.tools=tl;if(mdl)body.model=mdl;addEffort(body,mdl,route);if(CH.max)body.max_tokens=+CH.max;
  const est=ctxEstimate(body.messages,body.tools);let chunks=0,tFirst=null,ptok=0;
  const h=sseHandler(d=>{
    if(d.promptTokens)ptok=d.promptTokens;
    a.reasoning+=d.reasoning;a.content+=d.content;
    if(d.hasTools)a.tool_calls=d.toolCalls.filter(Boolean);
    if(d.content||d.reasoning||d.hasTools){chunks++;if(tFirst==null)tFirst=performance.now()}
    if(d.tps)a.tps=d.tps;emit();
  });
  try{a.node=(await managedChatStream(body,route,signal,h)).node||''}
  catch(e){if(e.name==='AbortError')a.stopped=true;else a.error=e.message}
  finally{
    delete a.streaming;
    if(ptok&&est.total){a.ptok=ptok;a.pest=est.total}   // real vs estimated prompt size: calibrates the context gauge
    a.tool_calls=h.calls();
    if(a.error||a.stopped){   // stream died mid-call: the arguments are cut off, and resending them makes llama-server answer HTTP 500 forever
      const bad=a.tool_calls.filter(c=>!validArgs(c.function.arguments));
      if(bad.length){a.tool_calls=a.tool_calls.filter(c=>!bad.includes(c));a.error=(a.error?a.error+' — ':'')+'the reply was cut off while writing a tool call ('+bad.map(c=>c.function.name).join(', ')+'); that partial call was discarded, so press ↻ or send “continue” to retry'}
    }
    if(!a.tool_calls.length)delete a.tool_calls;
    if(!a.tps&&tFirst&&chunks>1)a.tps=(chunks-1)/((performance.now()-tFirst)/1000);
    if(!a.content&&!a.reasoning&&!a.tool_calls&&!a.error&&!a.stopped)a.error='empty reply';
    emit();
  }
  return a;
}
async function agentLoop(sig,opts={}){
  const max=opts.maxSteps||clamp(+CH.steps||10,1,40);let status='done',autoTries=0;
  for(let step=0;step<max;step++){
    if(opts.deadline&&Date.now()>=opts.deadline){status='time';break}
    if(autoTries<2&&needsCompact()){autoTries++;await compactChat('',{auto:true,signal:sig});if(sig.cleared)break;if(sig.aborted){status='stopped';break}}   // nearly full: summarise the older part first
    const a=await streamOnce(sig);if(sig.cleared)break;
    if(!a.tool_calls||a.error||a.stopped){
      if(CH.mode==='plan'&&!a.error&&!a.stopped&&a.content.trim())a.plan='pending';   // the final reply is the plan: ask the user
      status=a.error?'error':a.stopped?'stopped':'done';break;
    }
    for(const tc of a.tool_calls){
      if(sig.aborted)break;
      const content=await runTool(tc);if(sig.cleared)break;
      CH.msgs.push({role:'tool',tool_call_id:tc.id,name:tc.function.name,args:tc.function.arguments,content:capTool(content,opts.toolTok),...(tc.web_image?{image:tc.web_image,image_name:tc.web_image_name||'tool image'}:{})});emit();
    }
    if(sig.aborted){status='stopped';break}
    if(step===max-1){if(opts.quiet)status='cap';else CH.msgs.push({role:'assistant',content:'',error:`Stopped after ${max} tool steps — press ↻ or send “continue” to go on.`})}
  }
  return status;
}

// ======================================================================= compaction
export function needsCompact(){   // full AND the conversation (not the fixed system prompt / tool definitions) is what fills it
  const s=ctxState();if(s.pct<AUTO_COMPACT_PCT||!s.size)return false;
  return s.segs.filter(x=>['user','toolOthers','toolOutputs'].includes(x.id)).reduce((a,x)=>a+x.tokens,0)>=s.size*0.25;
}
export async function compactChat(focus,{auto=false,signal}={}){
  const msgs=CH.msgs.filter(m=>!m.local&&!m.streaming);
  let u=-1;for(let i=msgs.length-1;i>=0;i--)if(msgs[i].role==='user'&&!msgs[i].auto){u=i;break}   // the request being worked on stays word for word
  let j=msgs.length;for(let i=Math.max(u+1,msgs.length-6);i<msgs.length;i++)if(msgs[i].role==='assistant'){j=i;break}   // so do the last few steps
  const keep=m=>m.role==='user'||m.role==='assistant'||m.role==='tool';
  const old=u<0?msgs.slice(0,j).filter(keep):[...msgs.slice(0,Math.max(u,0)),...msgs.slice(u+1,j)].filter(keep);
  if(!old.length&&!CH.summary){if(!auto)notice('📦 Nothing to compact yet — the conversation is still short.');return false}
  const cap=ctxCapacity()?.tokens||8192,budget=Math.max(3000,Math.floor((cap*0.6-1500)*3.2));
  const ask=(CH.summary?`EARLIER SUMMARY (from a previous compaction):\n${CH.summary}\n\n`:'')+`CONVERSATION TO SUMMARISE:\n${compactTranscript(old,budget)}\n\n`+(focus?`Pay special attention to: ${focus}\n\n`:'')+'Write the summary now.';
  const tmp={role:'assistant',local:true,streaming:true,content:'📦 Compacting the conversation…'};CH.msgs.push(tmp);emit();
  let text='',mode=CH.dummy||CH.compactMode==='script'?'script':'ai';
  if(mode==='script')text=scriptCompactSummary(msgs);
  else try{
    const out=await llmCall({messages:[{role:'system',content:COMPACT_SYS},{role:'user',content:ask}],route:CH.route,model:CH.model,signal,max:Math.min(1800,Math.max(300,Math.floor(cap*0.25))),think:false});
    text=(out.content||'').replace(/<think>[\s\S]*?<\/think>/g,'').trim();
  }catch{
    if(signal?.aborted||signal?.cleared){CH.msgs=CH.msgs.filter(m=>m!==tmp);emit();return false}
    mode='script';text=scriptCompactSummary(msgs);
  }
  CH.msgs=CH.msgs.filter(m=>m!==tmp);if(signal?.cleared)return false;
  if(!text){mode='script';text=scriptCompactSummary(msgs)}
  const tail=msgs.slice(j).map(m=>m.role==='tool'&&(m.content||'').length>3000?{...m,content:m.content.slice(0,3000)+'\n…[shortened by compaction]'}:m);
  CH.summary=text.slice(0,8000);
  CH.msgs=[{role:'compact',content:CH.summary,auto,mode,at:Date.now()},...(u>=0?[msgs[u]]:[]),...tail];
  saveChat();emit();return true;
}

// ======================================================================= helper workers (orchestra, leader, spawn parallel/debate)
const CONDUCTOR_SYS=n=>`You are the conductor of an orchestra of AI workers that run on separate machines. Split the user's request into at most ${n} INDEPENDENT subtasks that can be done in parallel by workers who cannot see each other's work. Each worker can use tools (web search, fetching pages, reading and writing files in a shared workspace). Make every subtask prompt fully self-contained. If the request is simple or cannot be split, return a single subtask.\nReply with ONLY JSON, no other text: {"subtasks":[{"title":"short title","prompt":"complete instructions for the worker"}]}`;
const WORKER_NOTE="\n\nYou are a spawned helper model in Calcium's shared chat, running on a worker node. Your tools and abilities may differ from Calcium's and from other helpers'. Do only the subtask you are given, use tools when they help, and finish with a concise, self-contained result (mention any file paths you created or changed). Vision support means image inspection only; it does not provide image generation or editing. Do not claim that it does.";
function parseSubtasks(text,max){
  const t=(text||'').replace(/```(?:json)?/gi,''),a=t.indexOf('{'),b=t.lastIndexOf('}');
  try{return (JSON.parse(t.slice(a,b+1)).subtasks||[]).map(x=>({title:String(x.title||'Subtask').slice(0,80),prompt:String(x.prompt||x.task||'')})).filter(x=>x.prompt.trim()).slice(0,max)}catch{return[]}
}
function nodeOrder(){   // distinct nodes first (fastest first), then extra slots
  const ready=readyNodes().filter(n=>!CH.model||n.info.server.config?.model===CH.model).sort((a,b)=>(b.weight||0)-(a.weight||0));
  return [...ready.map(n=>n.name),...ready.flatMap(n=>Array(clamp((+n.info.server.config?.parallel||1)-1,0,3)).fill(n.name))];
}
const argSummary=tc=>{try{const a=JSON.parse(tc.function.arguments||'{}');return short(a.path||a.command||a.query||a.url||a.expression||Object.values(a).find(v=>typeof v==='string')||'',60)}catch{return ''}};
export async function runWorker(t,node,sig,touch,model,options={}){
  if(model===undefined)model=CH.model;
  t.status='running';t.node=node;touch();
  const msgs=[{role:'system',content:sysText(model,node)+WORKER_NOTE},{role:'user',content:t.fullPrompt||t.prompt}],max=clamp(+CH.steps||10,1,40);
  try{
    for(let step=0;step<max;step++){
      let a;const tl=activeTools(model,node).filter(x=>!options.noSpawn||x.function.name!=='spawn');
      try{a=await llmCall({messages:msgs,tools:tl,route:node,model,signal:sig})}
      catch(e){if(e.name==='AbortError'||!node)throw e;node='';a=await llmCall({messages:msgs,tools:tl,route:'',model,signal:sig})}   // pinned node vanished -> any node
      t.node=a.node||node;if(a.tps)t.tps=a.tps;
      if(!a.tool_calls.length){t.result=a.content;t.status='done';touch();return}
      msgs.push({role:'assistant',content:a.content||'',tool_calls:a.tool_calls});
      for(const tc of a.tool_calls){
        if(sig.aborted)throw new DOMException('aborted','AbortError');
        t.steps.push(tc.function.name+'('+argSummary(tc)+')');touch();
        const content=capTool(await runTool(tc,{model,node}));
        msgs.push({role:'tool',tool_call_id:tc.id,content:tc.web_image&&IMGS[tc.web_image]?[{type:'text',text:content},{type:'image_url',image_url:{url:IMGS[tc.web_image]}}]:content});
      }
    }
    t.result='(stopped after '+max+' tool steps)';t.status='done';
  }catch(e){if(e.name==='AbortError')t.status='stopped';else{t.status='error';t.error=e.message}}
  touch();
}
async function runOrchestra(sig){
  const max=clamp(+CH.maxSub||4,1,12),orch={role:'orchestra',phase:'planning',tasks:[],note:''};CH.msgs.push(orch);emit();
  const touch=()=>emit();
  try{
    const hist=apiMessages(null,true).filter(m=>m.role!=='system');
    const plan=await llmCall({messages:[{role:'system',content:CONDUCTOR_SYS(max)},...hist],route:CH.route,model:CH.model,signal:sig});
    let tasks=parseSubtasks(plan.content,max);
    if(!tasks.length){orch.note='Could not split the request into parts — running it as one task.';tasks=[{title:'Whole request',prompt:lastUserText()}]}
    orch.tasks=tasks.map(t=>({...t,status:'queued',steps:[],result:'',node:''}));orch.phase='running';emit();
    const order=nodeOrder();
    await Promise.all(orch.tasks.map((t,i)=>runWorker(t,order.length?order[i%order.length]:'',sig,touch)));
    orch.tasks.forEach(t=>{t.result=short(t.result,8000)});
    if(sig.aborted){orch.phase='stopped';return}
    const ok=orch.tasks.filter(t=>t.status==='done');if(!ok.length){orch.phase='failed';return}
    if(orch.tasks.length===1){orch.phase='done';CH.msgs.push({role:'assistant',content:ok[0].result,node:ok[0].node,tps:ok[0].tps});return}
    orch.phase='synthesizing';emit();
    const extra='Results from your workers:\n\n'+orch.tasks.map((t,i)=>`### ${i+1}. ${t.title} (${t.status==='done'?'done':'failed: '+(t.error||t.status)})\n${t.status==='done'?short(t.result,6000):''}`).join('\n\n')+"\n\nNow write the final answer to the user's original request, combining these results. Only mention the workers if it helps; do not call tools.";
    await streamOnce(sig,{extraUser:extra,noTools:true});orch.phase='done';
  }catch(e){orch.phase=e.name==='AbortError'?'stopped':'failed';orch.note=e.name==='AbortError'?'':e.message}
  finally{if(['planning','running','synthesizing'].includes(orch.phase))orch.phase='stopped';emit()}
}
// leader mode: the strongest (or the chosen) node plans the job as a graph of tasks - some run in parallel, some wait for
// other tasks - and hands them out by difficulty: hard tasks to the leader, easy ones to smaller models. Then it writes the answer.
async function runLeader(sig){
  const max=clamp(+CH.maxSub||4,1,12),card={role:'orchestra',kind:'leader',phase:'planning',tasks:[],note:'',nodes:[]};CH.msgs.push(card);emit();
  const touch=()=>emit();
  try{
    const nodes=pickNodes(readyNodes(),CH.leader);if(!nodes.length)throw new Error('No node is serving a model.');
    const lead=nodes.find(n=>n.leader),k=new Set(nodes.map(n=>n.model)).size;card.nodes=nodes.map(n=>({name:n.name,model:n.model,tier:n.tier,leader:!!n.leader}));emit();
    const hist=apiMessages(null,true).filter(m=>m.role!=='system');
    const plan=await llmCall({messages:[{role:'system',content:LEADER_SYS(max,k)},...hist],route:lead.name,model:lead.model,signal:sig,max:Math.max(4096,+CH.max||0)});
    let parsed=parsePlan(plan.content,max);
    if(!parsed.length){card.note='The leader did not return a task plan — running the request as one task.';parsed=[{id:'t1',t:'Whole request',prompt:lastUserText(),difficulty:3,deps:[]}]}
    const tasks=card.tasks=parsed.map(p=>({id:p.id,title:p.t,prompt:p.prompt,difficulty:p.difficulty,deps:p.deps,status:'queued',steps:[],result:'',node:''}));
    const by=new Map(tasks.map(t=>[t.id,t]));card.phase='running';emit();
    for(;;){
      tasks.forEach(t=>{if(t.status==='queued'&&t.deps.some(d=>['error','skipped','stopped'].includes(by.get(d).status)))t.status='skipped'});
      const wave=tasks.filter(t=>t.status==='queued'&&t.deps.every(d=>by.get(d).status==='done'));
      if(!wave.length||sig.aborted)break;
      await Promise.all(wave.map(async(t,i)=>{
        const cand=nodes.filter(n=>n.tier<=tierFor(t.difficulty,k)),top=Math.max(...cand.map(n=>n.tier)),pool=cand.filter(n=>n.tier===top),n=pool[i%pool.length];
        t.fullPrompt=(t.deps.length?`Results of the earlier tasks you depend on:\n\n${t.deps.map(id=>`### ${by.get(id).title} (${id})\n${String(by.get(id).result).slice(0,3000)}`).join('\n\n')}\n\n---\n\nYour task:\n`:'')+t.prompt;
        await runWorker(t,n.name,sig,touch,n.model,{noSpawn:true});
        if(t.status==='error'&&n!==lead&&!sig.aborted){t.error='';t.steps=[];await runWorker(t,lead.name,sig,touch,lead.model,{noSpawn:true})}   // a weaker node failed: the leader redoes it
      }));
    }
    tasks.forEach(t=>{t.result=short(t.result,8000)});
    if(sig.aborted){card.phase='stopped';return}
    if(!tasks.some(t=>t.status==='done')){card.phase='failed';return}
    card.phase='synthesizing';emit();
    const extra='Results from your workers:\n\n'+tasks.map(t=>`### ${t.title} [${t.status}]\n${t.status==='done'?short(t.result,6000):(t.error||t.status)}`).join('\n\n')+"\n\nNow write the final answer to the user's original request, combining these results. Say what is missing if a task failed; do not call tools.";
    await streamOnce(sig,{extraUser:extra,noTools:true,model:lead.model,route:lead.name});card.phase='done';
  }catch(e){card.phase=e.name==='AbortError'?'stopped':'failed';card.note=e.name==='AbortError'?'':e.message}
  finally{if(['planning','running','synthesizing'].includes(card.phase))card.phase='stopped';emit()}
}

// ======================================================================= software mode
export const swState=()=>{const sw=CH.sw,left=sw&&sw.active?sw.endsAt-Date.now():0,going=!rt.swRun&&sw&&sw.active&&left>0;
  return {running:rt.swRun,going,left,sw,label:rt.swRun&&sw?`${fmtLeft(left)} left · cycle ${sw.cycle} · ${SW_PHASES[(sw.cycle-1+4)%4].label.toLowerCase()}`:going?`paused · ${fmtLeft(left)} left — send a message to continue`:sw&&sw.done?'finished':''}};
async function runSoftware(sig){
  const now=Date.now();let sw=CH.sw;const fresh=!(sw&&sw.active&&sw.endsAt>now);
  const say=error=>{CH.msgs.push({role:'assistant',content:'',error});emit()};
  if(!(groupOk('write')||groupOk('exec'))){say('Software mode needs the file-writing and/or shell tools. Switch them on under Workspace → Tools.');return}
  if(fresh){const mins=clamp(+CH.swMin||30,0.1,720);sw=CH.sw={goal:lastUserText(),minutes:mins,endsAt:now+mins*60000,cycle:0,active:true,done:false,started:now}}
  if(CH.perm!=='uncontrolled'&&confirm(`Software mode works on its own for ${fmtLeft(sw.endsAt-now)}. With ${CH.perm==='manual'?'Manual':'Semi'} permissions it stops and waits for you at every command that needs approval, which stalls it while you are away.\n\nOK  = run this session as ⚡ Uncontrolled (the model can run any shell command and change files without asking, as you, on the controller computer)\nCancel = keep ${CH.perm==='manual'?'Manual':'Semi'}`))rt.permOverride='uncontrolled';
  rt.swRun=true;let lock=null;try{lock=await navigator.wakeLock?.request('screen')}catch{}
  let fails=0,idle=0,first=true,clean=true;
  try{
    while(!sig.aborted&&Date.now()<sw.endsAt){
      sw.cycle++;const ph=SW_PHASES[(sw.cycle-1)%SW_PHASES.length];
      if(!first)CH.msgs.push({role:'user',auto:true,label:`cycle ${sw.cycle} · ${ph.label} · ${fmtLeft(sw.endsAt-Date.now())} left`,content:swCycleMsg(sw,ph)});
      first=false;saveChat();emit();
      const before=CH.msgs.filter(m=>m.role==='tool').length;
      const st=await agentLoop(sig,{deadline:sw.endsAt,quiet:true,toolTok:1000});
      if(sig.aborted||st==='stopped'){clean=false;break}
      fails=st==='error'?fails+1:0;idle=CH.msgs.filter(m=>m.role==='tool').length===before?idle+1:0;
      if(fails>=3){say('Software mode stopped: the model failed 3 times in a row (see the error above). Send a message to try again.');clean=false;break}
      if(idle>=3){say('Software mode paused: the model answered 3 cycles in a row without using a tool. Check that it supports tool calling (llama-server --jinja) and that the file/shell tools are switched on, then send a message to resume.');clean=false;break}
      await sleep(st==='error'?4000:500);
    }
    if(clean&&!sig.aborted){CH.msgs.push({role:'user',auto:true,label:'time is up · final report',content:SW_FINAL});emit();await agentLoop(sig,{maxSteps:8,quiet:true,toolTok:1000});if(!sig.aborted){sw.active=false;sw.done=true}}
  }finally{rt.swRun=false;rt.permOverride=null;try{await lock?.release()}catch{}emit()}
}

// ======================================================================= plan mode
export const planMsg=()=>{for(let i=CH.msgs.length-1;i>=0;i--)if(CH.msgs[i].plan==='pending')return CH.msgs[i];return null};
export function planAccept(){const m=planMsg();if(!m||rt.chatAbort)return;m.plan='accepted';setMode('dev');CH.msgs.push({role:'user',content:'The plan is approved. Execute it now, step by step, using your tools. Report briefly when you are done.'});chatSend(true)}
export function planDecline(){const m=planMsg();if(!m)return;m.plan='declined';saveChat();emit()}
export function planRevise(fb){const m=planMsg();fb=String(fb||'').trim();if(!m||rt.chatAbort||!fb)return;m.plan='revised';CH.msgs.push({role:'user',content:'Revise the plan: '+fb});chatSend(true)}

// ======================================================================= settings that have side effects
export function setMode(v){
  if(CH.mode==='software'&&v!=='software'&&rt.swRun&&rt.chatAbort)rt.chatAbort.abort();   // leaving Software mode stops the run
  CH.mode=MODES[v]?v:'dev';saveChat();emit();
}
export function setPerm(v){
  if(v==='uncontrolled'&&CH.perm!=='uncontrolled'&&!confirm('Uncontrolled: the model can run ANY shell command and change files without asking - as you, on the controller computer. Web pages it reads could try to steer it. Continue?'))return false;
  CH.perm=v;saveChat();emit();return true;
}

// ======================================================================= sending
function repairHistory(){   // every tool call needs an answer, or the next request is invalid
  const out=[];
  CH.msgs.forEach((m,i)=>{
    out.push(m);
    (m.tool_calls||[]).forEach(tc=>{
      let j=i+1;while(j<CH.msgs.length&&CH.msgs[j].role==='tool'&&CH.msgs[j].tool_call_id!==tc.id)j++;
      if(!(j<CH.msgs.length&&CH.msgs[j].role==='tool'&&CH.msgs[j].tool_call_id===tc.id))out.push({role:'tool',tool_call_id:tc.id,name:tc.function.name,args:tc.function.arguments,content:JSON.stringify({error:'cancelled before it ran'})});
    });
  });
  CH.msgs=out;
}
export function wipeChat(){   // everything that can end up in the model's context goes: messages (incl. tool results), summary, software-mode state, pending question
  idbClear();CH.msgs=[];for(const c of btwControllers.values())c.abort();btwControllers.clear();clearAgents();
  CH.btw=[];CH.queue=[];CH.tasks=[];CH.taskSeq=0;CH.summary='';CH.sw=null;rt.ask?.done({error:'the chat was cleared'});rt.ask=null;saveChat();emitNow();
}
export function clearChat(){const run=rt.chatAbort;if(run){run.cleared=true;run.signal.cleared=true;run.abort()}wipeChat()}   // a run that is still going must not write into the new, empty chat
export function stop(){rt.chatAbort?.abort()}
export function regen(){if(rt.chatAbort)return;while(CH.msgs.length&&CH.msgs[CH.msgs.length-1].role!=='user')CH.msgs.pop();if(CH.msgs.length)chatSend(true)}
// Runs one turn: the model loop of the selected mode. regen=true means the last message is already in CH.msgs.
export async function chatSend(){
  const turnStart=CH.msgs.length-1;
  if(!CH.dummy){
    if(!rt.toolinfo)await loadTools();
    if(CH.mode==='ask')await loadAskTree();
  }
  repairHistory();
  const ctl=rt.chatAbort=new AbortController();emit();
  try{
    if(CH.dummy)await dummyReply(ctl.signal);
    else if(CH.mode==='orchestra')await runOrchestra(ctl.signal);
    else if(CH.mode==='leader')await runLeader(ctl.signal);
    else if(CH.mode==='software')await runSoftware(ctl.signal);
    else await agentLoop(ctl.signal);
  }catch(e){if(!ctl.cleared)CH.msgs.push({role:'assistant',content:'',error:e.message})}
  finally{
    if(ctl.cleared)wipeChat();else repairHistory();
    rt.chatAbort=null;flushAgentMessages();const resume=CH.agentInterrupt;CH.agentInterrupt=false;
    if(!CH.dummy)CH.msgs.slice(Math.max(0,turnStart)).filter(m=>m.role==='assistant'&&!m.agentName&&!m.streaming&&!m.tool_calls?.length&&m.content?.trim()).forEach(m=>queueSharedChatMessage(m));
    saveChat();emit();
    if(resume)setTimeout(()=>{if(!rt.chatAbort)chatSend()},0);else if(CH.queue.length)setTimeout(dispatchQueuedMessage,0);
  }
}
rt.hooks={chatSend};
export async function sendMessage(text,images=[]){
  text=String(text||'').trim();
  const cmd=/^\/(compact|clear|models|read|view|schedule)(?:\s+([\s\S]*))?$/i.exec(text);
  if(cmd&&!images.length&&(!rt.chatAbort||['models','read','view','schedule'].includes(cmd[1].toLowerCase()))){if(dispatchBtw(text))return true;await runSlash(cmd[1].toLowerCase(),(cmd[2]||'').trim());return true}
  if(dispatchBtw(text))return true;
  if(rt.chatAbort){rt.chatAbort.abort();return false}   // Send doubles as Stop while a reply is running
  if(!text&&!images.length)return false;
  if(images.length&&!CH.dummy&&!capsNow().vision){rt.err='The selected model can’t read images — remove the picture(s) or pick a vision model.';emit();return false}
  const pm=planMsg();if(pm)pm.plan='revised';   // typing instead of clicking = feedback on the pending plan
  const message={role:'user',content:text,...(images.length?{images}:{})};
  CH.msgs.push(message);if(!CH.dummy)queueSharedChatMessage(message);rt.err='';saveChat();emit();
  chatSend();return true;
}
// ---- message queue (Ctrl+Enter): messages wait and are sent one after another
export function queueMessage(text,images=[]){
  text=String(text||'').trim();if(!text&&!images.length)return false;
  if(CH.queue.length>=50){alert('The message queue is full (50 messages).');return false}
  CH.queue.push({text,images});saveChat();emit();if(!rt.chatAbort)dispatchQueuedMessage();return true;
}
export function unqueue(i){CH.queue.splice(i,1);saveChat();emit()}
function dispatchQueuedMessage(){
  if(rt.chatAbort||!CH.queue.length)return;
  const next=CH.queue[0];
  if(next.images?.length&&!CH.dummy&&!capsNow().vision){alert('A queued message contains images, but the selected model cannot read images. Select a multimodal model before sending the queue.');return}
  CH.queue.shift();const message={role:'user',content:next.text||'',...(next.images?.length?{images:next.images}:{})};
  CH.msgs.push(message);if(!CH.dummy)queueSharedChatMessage(message);saveChat();emit();chatSend();
}

// ======================================================================= /btw: a side question answered in parallel, kept out of the chat
function dispatchBtw(text){const m=/^\/btw(?:\s+([\s\S]+))?$/i.exec(text);if(!m)return false;if(!m[1]?.trim()){notice('Usage: /btw your side question');return true}runBtw(m[1].trim());return true}
async function runBtw(q){
  const id=++btwSeq,ctl=new AbortController(),entry={id:'btw'+id,q,a:'',state:'run'};btwControllers.set(id,ctl);CH.btw.push(entry);emit();
  try{
    if(CH.dummy){entry.a=dummyResponse();entry.state='done';return}
    const ctx=apiMessages(null,true).filter(m=>m.role==='user'||(m.role==='assistant'&&!m.tool_calls?.length)).slice(-8);
    const out=await llmCall({messages:[{role:'system',content:sysText()+'\n\nThe user asks a quick side question. Answer briefly, using the conversation only as background. Do not call tools.'},...ctx,{role:'user',content:q}],route:CH.route,model:CH.model,signal:ctl.signal,think:false});
    entry.a=out.content||out.reasoning||'(no answer)';entry.state='done';
  }catch(e){entry.state='err';entry.a=e.name==='AbortError'?'stopped':e.message}
  finally{btwControllers.delete(id);saveChat();emit()}
}
export function dismissBtw(id){CH.btw=CH.btw.filter(b=>b.id!==id);saveChat();emit()}

// ======================================================================= slash commands
export const SLASH=[['/btw','Ask a side question without interrupting the current reply'],['/models','List ready models'],['/read','Read a workspace text file into the chat'],['/view','View a workspace image with the current model'],['/schedule','Schedule a one-time prompt: 09:00-11-28 <prompt> · list · cancel <id>'],['/compact','Summarise older messages to free context'],['/clear','Empty the conversation']];
async function runSlash(cmd,arg){
  if(cmd==='clear')return clearChat();
  if(cmd==='models'){const r=readyNodes();return notice(r.length?'Ready models:\n'+r.map(n=>`- ${n.name}: ${nodeModel(n)}`).join('\n'):'No model is currently ready.')}
  if(cmd==='read'||cmd==='view')return runFileSlash(cmd,arg);
  if(cmd==='schedule')return runScheduleSlash(arg);
  const ctl=rt.chatAbort=new AbortController();emit();
  try{await compactChat(arg,{signal:ctl.signal})}
  finally{
    if(ctl.cleared)wipeChat();rt.chatAbort=null;flushAgentMessages();const resume=CH.agentInterrupt;CH.agentInterrupt=false;saveChat();emit();
    if(resume)setTimeout(()=>{if(!rt.chatAbort)chatSend()},0);
  }
}
async function runFileSlash(cmd,path){
  path=String(path||'').trim().replace(/^(["'])(.*)\1$/,'$2');
  if(!path)return notice(`Usage: /${cmd} workspace-relative-path`);
  if(rt.chatAbort)return notice(`Stop the current reply before using /${cmd}.`);
  try{
    let content,images;
    if(cmd==='read'){
      const r=JSON.parse((await api('/api/tools/run','POST',{name:'read_file',arguments:{path},permission:'semi'})).result||'{}');if(r.error)throw new Error(r.error);
      content=`Read this workspace file and respond to its contents. File: ${r.path}\n\n${r.content}${r.truncated?'\n[File content was truncated.]':''}`;
    }else{
      if(!capsNow().vision)throw new Error('Select a model with image input enabled before using /view.');
      const r=JSON.parse((await api('/api/tools/run','POST',{name:'view_image',arguments:{path},permission:'semi'})).result||'{}');if(r.error)throw new Error(r.error);
      if(!r.image_base64||!r.mime_type)throw new Error('The image tool returned no image data.');
      const id=newId('view');IMGS[id]=`data:${r.mime_type};base64,${r.image_base64}`;await idbPut(id,IMGS[id]);
      content=`View and describe this workspace image: ${r.path||path}`;images=[{id,name:r.path||path}];
    }
    const message={role:'user',content,...(images?{images}:{})};CH.msgs.push(message);queueSharedChatMessage(message);saveChat();emit();await chatSend();
  }catch(e){notice(`/${cmd} failed: ${e.message}`)}
}
export async function syncScheduled(){try{const {tasks}=await api('/api/scheduled-tasks');rt.scheduled=tasks;emit();return tasks}catch(e){rt.scheduled=null;rt.scheduledErr=e.message;emit();return false}}
export async function cancelSchedule(id){try{await api('/api/scheduled-tasks/'+encodeURIComponent(id),'DELETE');await syncScheduled()}catch(e){notice('Could not cancel scheduled task: '+e.message)}}
async function runScheduleSlash(arg){
  const text=String(arg||'').trim();
  if(/^list$/i.test(text)){const t=await syncScheduled();if(t&&!t.length)notice('No scheduled tasks.');return}
  const c=/^cancel\s+([\w-]+)$/i.exec(text);if(c)return cancelSchedule(c[1]);
  try{const p=parseSchedule(text),t=await api('/api/scheduled-tasks','POST',{prompt:p.prompt,due_at:p.dueAt/1000,model:CH.model,target:CH.route,system_prompt:CH.sys2});await syncScheduled();notice(`Scheduled task ${t.id} for ${p.localTime} (local time): ${p.prompt}. It runs on the controller without chat tools.`)}
  catch(e){notice('Could not schedule task: '+e.message)}
}
export async function workspaceFiles(){
  if(rt.slashFiles&&Date.now()-rt.slashFilesAt<15000)return rt.slashFiles;
  const d=await api('/api/workspace');rt.slashFilesAt=Date.now();return rt.slashFiles=(d.files||[]).map(f=>f.path);
}
