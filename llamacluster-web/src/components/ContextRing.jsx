import React,{useEffect,useRef,useState} from 'react';
import {fmtTok} from '../chat/engine.js';
// Hollow ring next to the message box: the outline fills with context use (orange at 75 %, red at 95 %); click for the breakdown.
export default function ContextRing({s}){
  const [open,setOpen]=useState(false),ref=useRef();
  useEffect(()=>{if(!open)return;const k=e=>{if(e.key==='Escape')setOpen(false)},c=e=>{if(!ref.current?.contains(e.target))setOpen(false)};document.addEventListener('keydown',k);document.addEventListener('mousedown',c);return()=>{document.removeEventListener('keydown',k);document.removeEventListener('mousedown',c)}},[open]);
  const C=2*Math.PI*9,cap=s.cap,where=!cap?'No ready node reports a context size.':`${cap.name}${cap.par>1?` · ${fmtTok(cap.size)} ÷ ${cap.par} slots`:''}${!cap.fixed?` · smallest of ${cap.nodes} nodes`:''}`;
  return <span className="ctxwrap" ref={ref}><button className={'ctx '+s.level} onClick={()=>setOpen(!open)} aria-label="Context usage"
      title={s.size?`Context: ${Math.round(s.pct)}% full (${fmtTok(s.used)} / ${fmtTok(s.size)} tokens) — click for details`:`Context: ≈ ${fmtTok(s.used)} tokens — click for details`}>
    <svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--line)" strokeWidth="2.6"/>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" transform="rotate(-90 12 12)" strokeDasharray={`${s.pct/100*C} ${C}`} style={{opacity:s.pct>0?1:0}}/></svg></button>
    {open&&<div className="ctxmenu"><div className="row small"><b>Context</b><span className="grow"/><span>{s.size?Math.round(s.pct)+'% full':'≈ '+fmtTok(s.used)+' tokens'}</span></div>
      <div className="mut small">{s.size?fmtTok(s.used)+' / '+fmtTok(s.size)+' tokens · ':''}{where}</div>
      <div className="ctxbar">{s.segs.filter(x=>x.tokens>0).map(x=><i key={x.id} title={x.label} style={{width:x.pct+'%',background:x.color}}/>)}</div>
      {s.segs.filter(x=>(x.id!=='image'||x.tokens>0)&&(x.id!=='free'||s.size)).map(x=><div key={x.id} className="row small"><i className="sw" style={{background:x.color}}/><span className="grow">{x.label}</span><span className="mut">{fmtTok(x.tokens)} · {x.pct<0.1&&x.tokens?'<0.1':x.pct.toFixed(1)}%</span></div>)}
      <p className="mut small">≈ estimate{s.calibrated?', matched to the last reply':''}. “Tool” is the tool definitions, “Tool others” the call JSON, “Tool outputs” the returned results.</p></div>}</span>;
}
