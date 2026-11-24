import React,{useEffect,useRef,useState} from 'react';
// Small widgets in the spirit of React Bits (reactbits.dev): Status Mark, Call Chip, Thought Line, Lattice Loader and a Rubber Segment control.
// Written without extra dependencies; all motion is CSS and respects prefers-reduced-motion.
export const useClock=(on)=>{const [t,setT]=useState(0),s=useRef(0);useEffect(()=>{if(!on){s.current=0;return}s.current=s.current||Date.now();const i=setInterval(()=>setT(Date.now()-s.current),200);return()=>clearInterval(i)},[on]);return t};
export const fmtDur=ms=>ms<1000?'':(ms/1000).toFixed(ms<10000?1:0)+'s';
// idle ring -> progress arc -> check / cross
export function StatusMark({state='idle',size=16}){
  const cls={run:'run',working:'run',starting:'run',ok:'ok',done:'ok',err:'err',error:'err'}[state]||'idle',r=6,C=2*Math.PI*r;
  return <svg className={'smark '+cls} viewBox="0 0 16 16" width={size} height={size} aria-label={state}>
    <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.6"/>
    {cls==='run'&&<circle className="arc" cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray={`${C*.28} ${C}`}/>}
    {cls==='ok'&&<path d="M4.8 8.4l2.2 2.2 4.2-4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>}
    {cls==='err'&&<path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>}</svg>;
}
// Tool-call chip: the fill sweeps while it runs and a live timer ticks, ends green or shakes red.
export function CallChip({state,label,detail,children}){
  const ms=useClock(state==='run'),[t0]=useState(Date.now()),cls=state==='run'?'run':state==='err'?'err':'ok';
  return <details className={'tc cc '+cls}><summary><StatusMark state={state}/><span className="tcv">{label}</span><span className="tct">{detail}</span>{state==='run'&&<span className="mut small cctime">{fmtDur(ms)||'…'}</span>}</summary>{children}</details>;
}
// Reasoning trace header with a live clock; folds into one line when the reply starts.
export function ThoughtLine({text,live}){
  const ms=useClock(live),[final,setFinal]=useState(0);useEffect(()=>{if(!live&&ms)setFinal(ms)},[live,ms]);
  const steps=String(text||'').split(/\n{2,}/).filter(Boolean);
  return <details className="think thoughtline" open={live||undefined}><summary><StatusMark state={live?'run':'ok'} size={14}/>{live?'Thinking':'Thought'}{(live?ms:final)>=1000&&<span className="mut small"> · {fmtDur(live?ms:final)}</span>}{!live&&steps.length>1&&<span className="mut small"> · {steps.length} steps</span>}</summary><div className="thoughtbody">{text}</div></details>;
}
// A lattice of cells that brightens in a wave while an agent works.
export function LatticeLoader({on,cells=8}){return <span className={'lattice'+(on?' on':'')} aria-hidden>{Array.from({length:cells},(_,i)=><i key={i} style={{animationDelay:i*90+'ms'}}/>)}</span>}
// Segmented control whose thumb glides to the chosen option.
export function Segment({value,options,onChange,label}){
  const ref=useRef(),[box,setBox]=useState({x:0,w:0});
  useEffect(()=>{const el=ref.current?.querySelector('[aria-checked="true"]');if(el)setBox({x:el.offsetLeft,w:el.offsetWidth})},[value,options.length]);
  return <div className="segc" role="radiogroup" aria-label={label} ref={ref}><i className="thumb" style={{transform:`translateX(${box.x}px)`,width:box.w}}/>
    {options.map(([v,l,t])=><button key={v} role="radio" aria-checked={v===value} title={t} className={v===value?'on':''} onClick={()=>onChange(v)}>{l}</button>)}</div>;
}
