// Leader mode: a plan of tasks with difficulty + dependencies, run on up to 3 nodes (strongest model leads).
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
import {nodeStrength} from './strength.js';
const strength=n=>nodeStrength(n);   // size x quantisation quality, MoE-aware (same heuristic as the model recommender)
export function pickNodes(ready,leaderName){
  const L=ready.filter(n=>n.info.server.config?.model).map(n=>({name:n.name,model:n.info.server.config.model,score:strength(n)}));
  const by=new Map();L.forEach(x=>{if(!by.has(x.model))by.set(x.model,x)});
  let pick=[...by.values()].sort((a,b)=>b.score-a.score);
  if(pick.length>3)pick=[pick[0],pick[Math.floor(pick.length/2)],pick[pick.length-1]];
  const ch=L.find(x=>x.name===leaderName);
  if(ch&&!pick.includes(ch)){const i=pick.findIndex(p=>p.model===ch.model);if(i>=0)pick[i]=ch;else if(pick.length<3)pick.push(ch);else pick[1]=ch}
  pick.sort((a,b)=>b.score-a.score);const models=[...new Set(pick.map(x=>x.model))];
  pick.forEach(x=>{x.tier=models.indexOf(x.model);x.leader=false});if(pick.length)(pick.includes(ch)?ch:pick[0]).leader=true;return pick;
}
export const LEADER_SYS=(max,k)=>`You are the LEADER of a small cluster of AI workers on separate machines${k>1?` with ${k} model sizes: hard tasks go to the strongest model, easy ones to smaller models`:''}. Break the user's request into at most ${max} tasks. Tasks run in parallel unless one lists another in depends_on; every prompt must be complete and self-contained. difficulty: 1 easy, 2 medium, 3 hard.
Reply with ONLY JSON: {"tasks":[{"id":"t1","title":"short title","prompt":"complete instructions","difficulty":2,"depends_on":[]}]}`;
function end(t,i){const o=t[i],c=o==='{'?'}':']';let d=0,s=false,e=false;for(let j=i;j<t.length;j++){const ch=t[j];if(s){if(e)e=false;else if(ch==='\\')e=true;else if(ch==='"')s=false;continue}if(ch==='"')s=true;else if(ch===o)d++;else if(ch===c){d--;if(!d)return j+1}}return -1}
function extract(text){
  const t=String(text||'').replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/<think>[\s\S]*$/i,'').replace(/```(?:json)?/gi,'');
  const isT=x=>x&&typeof x==='object'&&(typeof x.prompt==='string'||typeof x.task==='string');
  for(let i=0;i<t.length;i++){if(t[i]!=='{'&&t[i]!=='[')continue;const j=end(t,i);if(j<0)continue;let v;try{v=JSON.parse(t.slice(i,j))}catch{continue}
    const l=Array.isArray(v)?v:v&&(v.tasks||v.subtasks||v.plan);if(Array.isArray(l)&&l.some(isT))return l}
  return [];
}
export function parsePlan(text,max){
  const tasks=[],seen=new Set();
  extract(text).slice(0,max).forEach((x,i)=>{const prompt=String(x?.prompt||x?.task||'');if(!prompt.trim())return;
    let id=String(x.id??'t'+(i+1)).replace(/[^\w-]/g,'').slice(0,20)||'t'+(i+1);while(seen.has(id))id+='_';seen.add(id);
    tasks.push({id,t:String(x.title||'Task '+(i+1)).slice(0,80),prompt,difficulty:clamp(Math.round(+x.difficulty||2),1,3),deps:[].concat(x.depends_on||x.dependencies||[]).map(String),state:'queued',node:'',out:''})});
  const ids=new Set(tasks.map(t=>t.id));tasks.forEach(t=>{t.deps=[...new Set(t.deps.filter(d=>ids.has(d)&&d!==t.id))]});
  const done=new Set();let left=[...tasks];   // break dependency cycles
  while(left.length){const ok=left.filter(t=>t.deps.every(d=>done.has(d)));if(!ok.length){left[0].deps=left[0].deps.filter(d=>done.has(d));continue}ok.forEach(t=>done.add(t.id));left=left.filter(t=>!ok.includes(t))}
  return tasks;
}
export const tierFor=(d,k)=>d>=3?0:d<=1?k-1:Math.round((k-1)/2);
export const withDeps=(t,byId)=>(t.deps.length?`Results of the earlier tasks you depend on:\n\n${t.deps.map(id=>`### ${byId.get(id).t} (${id})\n${String(byId.get(id).out).slice(0,3000)}`).join('\n\n')}\n\n---\n\nYour task:\n`:'')+t.prompt;
