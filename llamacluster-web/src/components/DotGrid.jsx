import React,{useEffect,useRef} from 'react';
// React Bits "Dot Grid" pattern, written without dependencies: a field of dots that lights up around the pointer.
// `pulse` (a number that changes) sends a ripple across the grid; while `energy` > 0 a slow ripple repeats, so the
// background shows the cluster is alive. Colours come from the theme (--mut, --acc). Draws once, no motion, when
// the visitor prefers reduced motion. The loop sleeps when nothing is moving.
const still=()=>!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const rgb=s=>{s=(s||'').trim();let m=/^#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(s);
  if(m){let h=m[1];if(h.length===3)h=[...h].map(c=>c+c).join('');const n=parseInt(h,16);return[n>>16&255,n>>8&255,n&255]}
  m=/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s);return m?[+m[1],+m[2],+m[3]]:[128,128,128]};
export default function DotGrid({energy=0,pulse=0,gap=26,className=''}){
  const cv=useRef(),S=useRef({ptr:null,rip:[],energy,colors:null,w:0,h:0,dpr:1,raf:0,kick:()=>{}});
  useEffect(()=>{S.current.energy=energy},[energy]);
  useEffect(()=>{if(pulse&&!still()){S.current.rip.push({t:performance.now(),power:1});S.current.kick()}},[pulse]);
  useEffect(()=>{
    const c=cv.current,ctx=c.getContext('2d'),s=S.current,host=c.parentElement,calm=still();
    const colors=()=>{const cs=getComputedStyle(document.documentElement);s.colors={base:rgb(cs.getPropertyValue('--mut')),acc:rgb(cs.getPropertyValue('--acc'))}};
    const draw=now=>{
      const {w,h,dpr,base,acc}={...s,...s.colors};ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      s.rip=s.rip.filter(r=>now-r.t<2600);
      const cols=Math.floor(w/gap)+1,rows=Math.floor(h/gap)+1,ox=(w-(cols-1)*gap)/2,oy=(h-(rows-1)*gap)/2,cx=w/2,cy=h/2;
      for(let i=0;i<cols;i++)for(let j=0;j<rows;j++){
        const x=ox+i*gap,y=oy+j*gap;let k=0;
        if(s.ptr){const d=Math.hypot(x-s.ptr.x,y-s.ptr.y);k=Math.pow(Math.max(0,1-d/150),2)}
        for(const r of s.rip){const age=(now-r.t)/1000,d=Math.hypot(x-cx,y-cy);k=Math.max(k,Math.exp(-Math.pow((d-age*380)/55,2))*(1-age/2.6)*r.power)}
        k=Math.min(1,k);
        const col=base.map((b,n)=>Math.round(b+(acc[n]-b)*k));
        ctx.fillStyle=`rgba(${col[0]},${col[1]},${col[2]},${.26+.74*k})`;
        ctx.beginPath();ctx.arc(x,y,1.3+k*2.4,0,6.2832);ctx.fill();
      }
    };
    const frame=now=>{s.raf=0;draw(now);if(!document.hidden&&(s.ptr||s.rip.length))s.raf=requestAnimationFrame(frame)};
    s.kick=()=>{if(!s.raf&&!document.hidden)s.raf=requestAnimationFrame(frame)};
    const size=()=>{const r=host.getBoundingClientRect();s.dpr=Math.min(2,window.devicePixelRatio||1);s.w=r.width;s.h=r.height;c.width=Math.round(r.width*s.dpr);c.height=Math.round(r.height*s.dpr);draw(performance.now())};
    colors();size();
    const ro=new ResizeObserver(size);ro.observe(host);
    const mo=new MutationObserver(()=>{colors();draw(performance.now())});mo.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    const move=e=>{const r=host.getBoundingClientRect();s.ptr={x:e.clientX-r.left,y:e.clientY-r.top};s.kick()},leave=()=>{s.ptr=null;s.kick()};
    let breath=0;
    if(!calm){host.addEventListener('pointermove',move);host.addEventListener('pointerleave',leave);
      breath=setInterval(()=>{if(s.energy>0&&!document.hidden){s.rip.push({t:performance.now(),power:.55});s.kick()}},7000)}
    return()=>{ro.disconnect();mo.disconnect();clearInterval(breath);cancelAnimationFrame(s.raf);s.raf=0;host.removeEventListener('pointermove',move);host.removeEventListener('pointerleave',leave)};
  },[gap]);
  return <canvas ref={cv} className={'dotgrid '+className} aria-hidden="true"/>;
}
