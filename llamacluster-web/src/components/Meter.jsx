import React from 'react';
// Usage bar: the fill glides when the number changes and turns amber / red when the resource runs low.
const f=n=>n>=100?Math.round(n):Math.round(n*10)/10;
export default function Meter({label,used=0,total=0,unit='GB',title}){
  const pct=total>0?Math.max(0,Math.min(100,used/total*100)):0,lvl=pct>92?'crit':pct>75?'warn':'';
  return <div className="meter" title={title}><div className="mrow"><span>{label}</span><span className="mut">{f(used)} / {f(total)} {unit}</span></div>
    <div className={'mbar '+lvl} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used}><i style={{width:pct+'%'}}/></div></div>;
}
