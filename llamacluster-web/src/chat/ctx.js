// Context accounting (port of ctxEstimate / ctxSegments / compactTranscript in ui.html). All numbers are estimates.
import {short} from './store.js';
export const est=s=>Math.ceil(String(s||'').length/3.8);
export const CTX_CAT=[['sys','System prompt','#f87171'],['tools','Tool','#ef4444'],['toolOthers','Tool others','#f97316'],['toolOutputs','Tool outputs','#fb923c'],['user','User','#4ade80'],['image','Image context','#22d3ee'],['free','Free space','#6ea8ff']];
const OVERHEAD=5;   // chat-template tokens around every message
export function ctxEstimate(msgs,tools){
  const t=(n,r)=>Math.ceil((n||0)/r),e={sys:0,tools:0,toolOthers:0,toolOutputs:0,user:0,image:0};
  for(const m of msgs||[]){
    let c=typeof m.content==='string'?m.content:JSON.stringify(m.content||''),images=0;
    if(Array.isArray(m.content)){c='';for(const p of m.content){if(p.type==='text')c+=p.text||'';else if(p.type==='image_url'||p.type==='image')images++;else c+=' '.repeat(2300)}}
    e.image+=images*t(2300,3.8);
    if(m.role==='system')e.sys+=t(c.length,3.8)+OVERHEAD;
    else if(m.role==='tool')e.toolOutputs+=t(c.length,3.2)+OVERHEAD;
    else{e.user+=t(c.length,3.8)+OVERHEAD;if(m.tool_calls?.length)e.toolOthers+=t(JSON.stringify(m.tool_calls).length,3.2)}
  }
  if(tools?.length)e.tools=t(JSON.stringify(tools).length,3.2);
  e.total=e.sys+e.tools+e.toolOthers+e.toolOutputs+e.user+e.image;return e;
}
export function ctxSegments(e,scale,cap){
  const u={};for(const k of ['sys','tools','toolOthers','toolOutputs','user','image'])u[k]=Math.round((e[k]||0)*scale);
  const used=u.sys+u.tools+u.toolOthers+u.toolOutputs+u.user+u.image,size=cap?.tokens||0,free=size?Math.max(0,size-used):0;
  const pct=size?Math.min(100,used/size*100):0,level=!size?'':pct>=95?'crit':pct>=75?'warn':'';   // orange from 75 %, red from 95 %
  const den=Math.max(size,used)||1;
  return {used,size,free,pct,level,segs:CTX_CAT.map(([id,label,color])=>{const tokens=id==='free'?free:u[id];return {id,label,color,tokens,pct:tokens/den*100}})};
}
export function compactTranscript(msgs,budget){
  const parts=[];
  for(const m of msgs){
    if(m.role==='user')parts.push((m.agentName?m.agentName.toUpperCase():'USER')+': '+short(m.content||'',3000)+(m.images?.length?` [${m.images.length} image(s)]`:''));
    else if(m.role==='assistant'){let t=(m.agentName?m.agentName.toUpperCase():'ASSISTANT')+': '+short(m.content||'',3000);(m.tool_calls||[]).forEach(tc=>{t+=`\n  [tool call ${tc.function.name}(${short(tc.function.arguments||'',300)})]`});if(m.error)t+=' [error: '+short(m.error,200)+']';parts.push(t)}
    else if(m.role==='tool')parts.push('  TOOL RESULT ('+(m.name||'')+'): '+short(m.content||'',700));
  }
  let t=parts.join('\n');
  if(t.length>budget){const a=Math.floor(budget*.2);t=t.slice(0,a)+'\n[… middle of the transcript omitted …]\n'+t.slice(-(budget-a))}
  return t;
}
export function scriptCompactSummary(msgs){
  let user='',call='',answer='';
  for(let i=msgs.length-1;i>=0;i--){const m=msgs[i];
    if(!user&&m.role==='user'&&!m.auto)user=String(m.content||'').slice(0,300);
    if(!answer&&m.role==='assistant'&&!m.local&&m.content)answer=String(m.content).slice(0,300);
    if(!call&&m.role==='assistant'&&m.tool_calls?.length){const tc=m.tool_calls[m.tool_calls.length-1];call=(String(tc.function.name||'')+'('+String(tc.function.arguments||'').slice(0,280)+')').slice(0,300)}
    if(user&&call&&answer)break}
  return ['(Automatic summary - no model was used.)',user&&'Latest request: '+user,call&&'Last tool call: '+call,answer&&'Last answer: '+answer,`${msgs.length} earlier messages were folded into this note.`].filter(Boolean).join('\n');
}
export const COMPACT_SYS='You compress a conversation between a user and an AI assistant (which can use tools: files, shell, web search) so the assistant can carry on as if it remembered everything. Write a dense, factual summary in plain text, no preamble. Cover, where present: the user\'s goal and every instruction or preference they gave; decisions made and why; facts, names, paths, commands, numbers and results that matter; what was done so far, what is in progress and what is still open; errors met and how they were solved. Keep exact file paths, identifiers and code snippets that will be needed again. Do not invent anything.';
export const parseArr=s=>{const m=/\[[\s\S]*\]/.exec(s||'');try{return JSON.parse(m[0]).map(x=>typeof x==='string'?x:x.task||x.prompt||x.title||'').filter(Boolean)}catch{return[]}};
export const shrink=(file,max=1280)=>new Promise((res,rej)=>{const u=URL.createObjectURL(file),i=new Image();
  i.onload=()=>{const s=Math.min(1,max/Math.max(i.width,i.height)),c=document.createElement('canvas');c.width=Math.round(i.width*s);c.height=Math.round(i.height*s);c.getContext('2d').drawImage(i,0,0,c.width,c.height);URL.revokeObjectURL(u);res(c.toDataURL('image/jpeg',.85))};
  i.onerror=()=>rej(new Error('Not an image'));i.src=u});
