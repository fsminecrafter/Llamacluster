import React,{useEffect,useRef,useState} from 'react';
import ShinyText from './ShinyText.jsx';
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
// Collapsible reasoning trace header with a live clock.
export function ThoughtLine({text,live,style='classic'}){
  const ms=useClock(live),[final,setFinal]=useState(0);useEffect(()=>{if(!live&&ms)setFinal(ms)},[live,ms]);
  const steps=String(text||'').split(/\n{2,}/).filter(Boolean);
  return <details className="think thoughtline">
    <summary>
      {style==='lattice'?<LatticeLoader on={live}/>:<StatusMark state={live?'run':'ok'} size={14}/>}
      {live?(style==='lattice'?'Thinking':<ShinyText>Thinking…</ShinyText>):'Thought'}
      {(live?ms:final)>=1000&&<span className="mut small"> · {fmtDur(live?ms:final)}</span>}
      {!live&&steps.length>1&&<span className="mut small"> · {steps.length} steps</span>}
    </summary>
    <div className="thoughtbody">{text||'No reasoning text has arrived yet.'}</div>
  </details>;
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
// Small popover: opens under (or above) its trigger, closes on outside click / Escape.
export function Pop({trigger,children,up=false,align='left',className='',label}){
  const [open,setOpen]=useState(false),ref=useRef();
  useEffect(()=>{if(!open)return;const k=e=>{if(e.key==='Escape')setOpen(false)},c=e=>{if(!ref.current?.contains(e.target))setOpen(false)};document.addEventListener('keydown',k);document.addEventListener('mousedown',c);return()=>{document.removeEventListener('keydown',k);document.removeEventListener('mousedown',c)}},[open]);
  return <span className={'pop '+className} ref={ref}><button className={'popbtn'+(open?' open':'')} aria-haspopup="true" aria-expanded={open} aria-label={label} onClick={()=>setOpen(!open)}>{trigger}</button>
    {open&&<div className={'popmenu '+(up?'up ':'')+align}>{typeof children==='function'?children(()=>setOpen(false)):children}</div>}</span>;
}
export const Icon=({d,size=18,fill})=><svg viewBox="0 0 24 24" width={size} height={size} fill={fill?'currentColor':'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d}/></svg>;
export const ICONS={back:'M15 18l-6-6 6-6',send:'M12 19V5M5 12l7-7 7 7',stop:'M7 7h10v10H7z',plus:'M12 5v14M5 12h14',sliders:'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',chev:'M6 9l6 6 6-6',check:'M5 12l5 5 9-10',folder:'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',trash:'M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3',clip:'M21 12l-8.5 8.5a5 5 0 01-7-7L14 5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 8',copy:'M9 9h10v10H9zM5 15V5h10',redo:'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6'};
