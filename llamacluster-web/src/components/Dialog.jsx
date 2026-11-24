import React,{useEffect,useRef} from 'react';
export default function Dialog({open,onClose,title,children,wide}){
  const r=useRef();useEffect(()=>{const d=r.current;if(open&&!d.open)d.showModal();if(!open&&d.open)d.close()},[open]);
  return <dialog ref={r} className={'dlg'+(wide?' wide':'')} onClose={onClose}><h2>{title}</h2>{children}</dialog>;
}
