import React,{useLayoutEffect,useRef,useState} from 'react';

export default function GlideSelect({options,value,onChange,label}){
  const ref=useRef(null),[hover,setHover]=useState(-1),[highlight,setHighlight]=useState({top:0,height:0});
  const selected=options.findIndex(option=>option.value===value),active=hover>=0?hover:selected;
  useLayoutEffect(()=>{
    const option=ref.current?.querySelectorAll('[role="option"]')[active];
    if(option)setHighlight({top:option.offsetTop,height:option.offsetHeight});
  },[active,options.length]);
  return <div className="glide-select" role="listbox" aria-label={label} ref={ref} onMouseLeave={()=>setHover(-1)}>
    <span className="glide-select-highlight" aria-hidden="true" style={{height:highlight.height,transform:`translateY(${highlight.top}px)`}}/>
    {options.map((option,i)=><button key={option.value} type="button" role="option" aria-selected={i===selected}
      className="glide-select-option" onMouseEnter={()=>setHover(i)} onFocus={()=>setHover(i)} onClick={()=>onChange(option.value)}>
      <span className="grow">{option.label}</span>{option.detail&&<span className="mut small">{option.detail}</span>}
      {i===selected&&<span className="glide-select-check" aria-hidden="true">✓</span>}
    </button>)}
  </div>;
}
