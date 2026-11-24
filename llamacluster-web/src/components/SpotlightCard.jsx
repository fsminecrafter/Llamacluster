import React from 'react';
// React Bits "Spotlight Card": a soft light and a glowing edge that follow the pointer (the CSS is in fx.css).
export default function SpotlightCard({children,className='',...p}){
  const move=e=>{const r=e.currentTarget.getBoundingClientRect();e.currentTarget.style.setProperty('--mx',e.clientX-r.left+'px');e.currentTarget.style.setProperty('--my',e.clientY-r.top+'px')};
  return <div className={'spot '+className} onMouseMove={move} {...p}>{children}</div>;
}
