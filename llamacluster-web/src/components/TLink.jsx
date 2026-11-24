import React from 'react';import {Link,useNavigate} from 'react-router-dom';import {flushSync} from 'react-dom';
// <Link> that cross-fades between pages with the View Transitions API where the browser has it; plain navigation elsewhere.
export default function TLink({to,onClick,...p}){
  const nav=useNavigate();
  const go=e=>{
    onClick?.(e);
    if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||p.target==='_blank')return;
    if(!document.startViewTransition||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    e.preventDefault();document.startViewTransition(()=>{flushSync(()=>nav(to))});
  };
  return <Link to={to} onClick={go} {...p}/>;
}
