import React,{useState} from 'react';
import {CH,rt,emit,saveChat,short} from '../chat/store.js';
import {messageLiveAgent,removeLiveAgent,agentCtxState,agentSystemText,agentDefaultPrompt} from '../chat/agents.js';
import {StatusMark,LatticeLoader} from './bits.jsx';
const TINT={Hydrogen:'#f472b6',Indium:'#60a5fa',Sulfur:'#fbbf24'};
// Roster of Calcium's live agents (Hydrogen / Indium / Sulfur): status, context use, last reply, a message box and the prompt.
export default function Agents(){
  if(!CH.agents.length)return null;
  return <div className="agents">{CH.agents.map(a=><AgentCard key={a.id} a={a}/>)}</div>;
}
function AgentCard({a}){
  const [msg,setMsg]=useState(''),[open,setOpen]=useState(false);
  const s=agentCtxState(a),busy=['working','starting','queued','interrupted'].includes(a.status),state=a.status==='error'?'err':busy?'run':'idle';
  const send=interrupt=>{const t=msg.trim();if(!t)return;setMsg('');messageLiveAgent(a,t,interrupt,'User')};
  return <div className={'agent-card'} style={{'--tint':TINT[a.name]||'var(--acc)'}}>
    <div className="row"><StatusMark state={state}/><b>{a.name}</b><span className="badge">{a.status}</span><span className="mut small grow" title={a.model}>{short(a.model,38)} · {a.node}</span><LatticeLoader on={a.status==='working'}/>
      <span className="mut small" title={s.size?`${Math.round(s.pct)}% of ${s.size.toLocaleString()} tokens`:'context size unknown'}>{s.size?Math.round(s.pct)+'%':''}</span></div>
    <div className="mut small">{short(a.task,160)}</div>
    {a.last&&<div className="small">{a.last}</div>}
    <div className="row"><input className="grow" value={msg} placeholder={`Message ${a.name}…`} onChange={e=>setMsg(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')send(e.ctrlKey||e.metaKey)}}/>
      <button onClick={()=>send(false)} disabled={!msg.trim()} title="Queue a message">Tell</button><button onClick={()=>send(true)} disabled={!msg.trim()||!busy} title="Stop the current reply and redirect">Interrupt</button>
      <button className="danger" onClick={()=>removeLiveAgent(a,'removed by the user')}>Remove</button><button className="ghost" onClick={()=>setOpen(!open)}>{open?'Hide':'Details'}</button></div>
    {open&&<div className="agent-detail">
      <label className="small">System prompt<textarea rows={4} value={a.systemPrompt||agentDefaultPrompt(a.name)} onChange={e=>{a.systemPrompt=e.target.value;a.messages[0]={role:'system',content:agentSystemText(a)};saveChat();emit()}}/></label>
      <div className="mut small">Recent activity</div>
      {a.messages.filter(m=>m.role!=='system').slice(-24).map((m,i)=><div key={i} className="small agent-line"><b>{m.agentName||(m.role==='assistant'?a.name:m.role==='tool'?'tool':'message')}</b> {m.tool_calls?.length?m.tool_calls.map(t=>`${t.function.name}(${short(t.function.arguments||'',120)})`).join('\n'):short(typeof m.content==='string'?m.content:'',700)}</div>)}</div>}
  </div>;
}
