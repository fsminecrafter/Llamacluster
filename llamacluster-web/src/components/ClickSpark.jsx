import {useEffect} from 'react';
// React Bits "Click Spark": a short burst where a primary button was pressed. Mounted once for the whole app;
// it watches clicks, so no button needs wiring. Skipped when the visitor prefers reduced motion.
export default function ClickSpark({selector='button.pri,.btn.pri,.sendbtn',count=8}){
  useEffect(()=>{
    if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    const layer=document.createElement('div');layer.className='sparklayer';layer.setAttribute('aria-hidden','true');document.body.append(layer);
    const on=e=>{
      const el=e.target.closest?.(selector);if(!el||el.disabled)return;
      let x=e.clientX,y=e.clientY;if(!e.detail){const r=el.getBoundingClientRect();x=r.left+r.width/2;y=r.top+r.height/2}   // keyboard click
      for(let i=0;i<count;i++){const s=document.createElement('i');s.style.cssText=`left:${x}px;top:${y}px;--a:${i*360/count+Math.random()*14}deg`;layer.append(s);setTimeout(()=>s.remove(),560)}
    };
    document.addEventListener('click',on);return()=>{document.removeEventListener('click',on);layer.remove()};
  },[selector,count]);
  return null;
}
