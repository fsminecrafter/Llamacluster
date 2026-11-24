// Shared chat state. Deliberately framework-free: the engine mutates `CH` in place exactly like the old ui.html did,
// then calls emit(); React reads it through useChat() (useSyncExternalStore). Persisted under the same localStorage key
// ('lc_chat') as ui.html, so existing chats, agents, tasks and settings carry over.
import {useSyncExternalStore} from 'react';
export {IMGS,idbPut,idbGet,idbClear,newId} from './img.js';
import {clamp} from './strength.js';
export {clamp};
export const short=(s,n)=>{s=String(s??'');return s.length>n?s.slice(0,n)+'…':s};
export {sleep} from '../api.js';
export const AGENT_NAMES=['Hydrogen','Indium','Sulfur'];
export const MODES={dev:'🛠 Dev',ask:'❓ Ask',plan:'🧭 Plan',orchestra:'🎼 Orchestra',leader:'👑 Leader',software:'💻 Software'};

const OLD_OPEN="You are a helpful assistant running on the user's own LlamaCluster. Today is {{date}}.";
const OLD_NEW_OPEN=`You are Calcium, an AI assistant created by XLABS, running on the user's own LlamaCluster. Today is {{date}}.

Identity: your name is Calcium and you were made by XLABS. When asked who you are, what you are called or who created you, say so plainly. Never say you are made by, or named after, any other company or model. If asked which underlying model powers you, say you don't know the details.`;
export const NEW_OPEN=OLD_NEW_OPEN.replace("If asked which underlying model powers you, say you don't know the details.",
  "Gender identity: he. Use he/him pronouns. If asked which underlying model powers you, say you don't know the details.");
export const DEFAULT_SYS=`${NEW_OPEN}

Spawned helpers are separate models in this same chat. Their tools and abilities can differ from yours and from each other. A model with vision can inspect and understand images; vision does not mean it can generate or edit images. Do not promise image generation unless an available tool explicitly supports it.

You can call tools:
- web_search / fetch_url: look things up on the web (searches run from the user's computer). Use them for anything recent or that you are unsure of, read the best results with fetch_url, and mention the URLs you relied on.
- list_files / read_file / search_files / write_file / edit_file / delete_file: work with files in the user's workspace folder ({{workspace}}). Read a file before editing it, and only change files when asked.
- exec_command: run a shell command (in the workspace by default) and read its output. Prefer the file tools for reading and editing; use it for builds, tests, git and the like. Some calls ask the user for approval first - if one is declined, do not try to get around it.

Be concise. Never claim to have done something unless a tool result confirms it.`;
export const TOOL_DEFAULTS={search:true,fetch:true,read:true,write:true,exec:true};

const load=()=>{try{return JSON.parse(localStorage.getItem('lc_chat')||'null')}catch{return null}};
export const CH=(()=>{
  const c={msgs:[],btw:[],temp:0.7,max:2048,effort:'',model:'',route:'',steps:10,toolTok:3000,mode:'dev',leader:'',tasks:[],taskSeq:0,maxSub:4,perm:'semi',compactMode:'ai',swMin:30,summary:'',sw:null,dummy:false,...(load()||{})};
  if(!Array.isArray(c.msgs))c.msgs=[];
  if(!Array.isArray(c.btw))c.btw=[];
  if(!Array.isArray(c.queue))c.queue=[];
  if(!Array.isArray(c.tasks))c.tasks=[];
  if(!Array.isArray(c.agents))c.agents=[];
  if(!Array.isArray(c.agentNotes))c.agentNotes=[];
  c.dummy=!!c.dummy;
  if(typeof c.agentInterrupt!=='boolean')c.agentInterrupt=false;
  c.agents=c.agents.filter(a=>a&&typeof a.id==='string'&&typeof a.name==='string'&&typeof a.model==='string'&&Array.isArray(a.messages));
  c.agents.forEach(a=>{   // a page reload killed their request: they wait for the next message
    if(!Array.isArray(a.inbox))a.inbox=[];if(!Array.isArray(a.sharedUpdates))a.sharedUpdates=[];
    if(['starting','working','interrupted'].includes(a.status))a.status='waiting'});
  c.tools={...TOOL_DEFAULTS,...(c.tools||{})};
  if(!MODES[c.mode])c.mode='dev';
  if(!c.sys2||typeof c.sys2!=='string')c.sys2=DEFAULT_SYS;
  else if(c.sys2.startsWith(OLD_OPEN))c.sys2=NEW_OPEN+c.sys2.slice(OLD_OPEN.length);
  c.msgs.forEach(m=>{delete m.streaming});   // nothing is streaming after a reload
  return c;
})();

// runtime state that is never saved
export const rt={nodes:[],toolinfo:null,chatAbort:null,permOverride:null,swRun:false,ask:null,askTree:'',wsOpenPath:null,wsIsNew:false,
  agentRuns:new Map(),agentProcessing:new Set(),err:''};

// ---- change notification: batched to one notify per animation frame so streaming chunks stay cheap
let ver=0,pending=0;const subs=new Set();
const flush=()=>{pending=0;ver++;subs.forEach(f=>f())};
export const emit=()=>{if(pending)return;pending=typeof requestAnimationFrame==='function'?requestAnimationFrame(flush):setTimeout(flush,16)};
export const emitNow=()=>{if(pending){(typeof cancelAnimationFrame==='function'?cancelAnimationFrame:clearTimeout)(pending);pending=0}flush()};
export function useChat(){useSyncExternalStore(f=>{subs.add(f);return()=>subs.delete(f)},()=>ver);return {CH,rt,ver}}
export const saveChat=()=>{try{CH.msgs=CH.msgs.slice(-300);CH.agents.forEach(a=>{a.messages=a.messages.slice(-120)});localStorage.setItem('lc_chat',JSON.stringify(CH))}catch{}};

// ---- nodes (fed from useNodes in the Chat page) and what the selected model/node can do
export const setNodes=n=>{rt.nodes=n||[];emit()};
export const readyNodes=()=>rt.nodes.filter(n=>n.info?.server?.state==='ready'&&n.info.server.config?.model);
export function capsFor(model,route){
  const ready=rt.nodes.filter(n=>n.info?.server?.state==='ready'&&(!route||n.name===route||n.id===route)&&(!model||n.info.server.config?.model===model));
  const r=ready.map(n=>(n.info.models||[]).find(x=>x.name===n.info.server.config?.model)?.meta?.reasoning||null);
  const same=r.length&&r.every(x=>x&&x.kind===r[0].kind&&JSON.stringify(x.levels)===JSON.stringify(r[0].levels));
  return {reasoning:same?r[0]:null,vision:!!ready.length&&ready.every(n=>n.info.server.vision)};
}
export const capsNow=()=>capsFor(CH.model,CH.route);
export const effPerm=()=>rt.permOverride||CH.perm;   // the override is never saved, so a closed tab can't leave you in Uncontrolled
// context tokens one conversation can use on the node(s) that will answer: ctx_size / parallel slots (smallest if several)
export function ctxCapacity(){
  const rdy=rt.nodes.filter(n=>n.info?.server?.state==='ready');let c=rdy,fixed=false;
  const pick=f=>{const l=rdy.filter(f);if(l.length){c=l;return true}return false};
  if(CH.mode==='leader'&&CH.leader)fixed=pick(n=>n.name===CH.leader);
  else if(CH.route)fixed=pick(n=>n.name===CH.route);
  else if(CH.model)pick(n=>n.info.server.config?.model===CH.model);
  const x=c.map(n=>{const cf=n.info.server.config||{},par=Math.max(1,+cf.parallel||1),size=+cf.ctx_size||0;return {name:n.name,size,par,tokens:Math.floor(size/par)}}).filter(v=>v.tokens>0);
  if(!x.length)return null;
  const m=x.reduce((a,b)=>b.tokens<a.tokens?b:a);return {...m,nodes:x.length,fixed:fixed||x.length===1};
}
