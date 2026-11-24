import React,{useEffect,useRef,useState} from 'react';
// React Bits "Count Up": eases from the number on screen to the new one (so a changing value glides, it doesn't jump).
const still=()=>!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export default function CountUp({value=0,decimals=0,duration=900,className=''}){
  const [v,setV]=useState(()=>still()?value:0),from=useRef(v);
  useEffect(()=>{
    if(still()){from.current=value;setV(value);return}
    const a=from.current,b=value,t0=performance.now();let raf;
    const step=t=>{const p=Math.min(1,(t-t0)/duration),cur=a+(b-a)*(1-Math.pow(1-p,3));from.current=cur;setV(cur);if(p<1)raf=requestAnimationFrame(step)};
    raf=requestAnimationFrame(step);return()=>cancelAnimationFrame(raf);
  },[value,duration]);
  return <span className={'countup '+className}>{v.toFixed(decimals)}</span>;
}
