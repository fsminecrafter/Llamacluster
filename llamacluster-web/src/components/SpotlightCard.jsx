import React from 'react';
// React Bits "Spotlight Card" pattern: a soft light that follows the pointer.
export default function SpotlightCard({children,className='',...p}){
  const move=e=>{const r=e.currentTarget.getBoundingClientRect();e.currentTarget.style.setProperty('--mx',e.clientX-r.left+'px');e.currentTarget.style.setProperty('--my',e.clientY-r.top+'px')};
  return <div className={'spot '+className} onMouseMove={move} {...p}>{children}</div>;
}
