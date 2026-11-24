import React,{useState} from 'react';
// Small, dependency-free markdown renderer. It builds React elements (never HTML strings), so model output can't inject markup.
// Handles: fenced code, headings, lists, blockquotes, tables, rules, **bold**, *italic*, ~~strike~~, `code` and http(s) links.
const safeUrl=u=>/^https?:\/\//i.test(u)?u:null;
function inline(s,k=''){
  const out=[];let i=0,key=0;const re=/(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)/g;let m;
  while((m=re.exec(s))){
    if(m.index>i)out.push(s.slice(i,m.index));const t=m[0],id=k+key++;
    if(m[1])out.push(<code key={id}>{t.slice(1,-1)}</code>);
    else if(m[2])out.push(<strong key={id}>{inline(t.slice(2,-2),id)}</strong>);
    else if(m[3])out.push(<del key={id}>{inline(t.slice(2,-2),id)}</del>);
    else if(m[4]){const mm=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(t),u=safeUrl(mm[2]);out.push(u?<a key={id} href={u} target="_blank" rel="noreferrer noopener">{mm[1]}</a>:t)}
    else out.push(<em key={id}>{inline(t.slice(1,-1),id)}</em>);
    i=m.index+t.length;
  }
  if(i<s.length)out.push(s.slice(i));return out;
}
export function CodeBlock({code,lang}){
  const [ok,setOk]=useState(false);
  return <div className="codeblk"><div className="codehead"><span>{lang||'text'}</span><button className="ghost small" onClick={()=>{navigator.clipboard?.writeText(code);setOk(true);setTimeout(()=>setOk(false),1400)}}>{ok?'Copied':'Copy'}</button></div><pre><code>{code}</code></pre></div>;
}
export default function Markdown({text}){
  const lines=String(text||'').replace(/\r/g,'').split('\n'),out=[];let i=0,k=0;
  const isTable=j=>/^\s*\|.*\|\s*$/.test(lines[j]||'')&&/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[j+1]||'');
  while(i<lines.length){
    const l=lines[i],f=/^\s*```\s*([\w+-]*)/.exec(l);
    if(f){const code=[];i++;while(i<lines.length&&!/^\s*```\s*$/.test(lines[i]))code.push(lines[i++]);i++;out.push(<CodeBlock key={k++} code={code.join('\n')} lang={f[1]}/>);continue}
    if(!l.trim()){i++;continue}
    const h=/^(#{1,4})\s+(.*)$/.exec(l);if(h){const T='h'+Math.min(4,h[1].length+1);out.push(React.createElement(T,{key:k++},inline(h[2])));i++;continue}
    if(/^\s*([-*_])\1{2,}\s*$/.test(l)){out.push(<hr key={k++}/>);i++;continue}
    if(isTable(i)){
      const cells=r=>r.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());const head=cells(l);i+=2;const rows=[];
      while(i<lines.length&&/^\s*\|.*\|\s*$/.test(lines[i]))rows.push(cells(lines[i++]));
      out.push(<div className="tblwrap" key={k++}><table><thead><tr>{head.map((c,x)=><th key={x}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r,y)=><tr key={y}>{r.map((c,x)=><td key={x}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);continue}
    if(/^\s*>/.test(l)){const q=[];while(i<lines.length&&/^\s*>/.test(lines[i]))q.push(lines[i++].replace(/^\s*>\s?/,''));out.push(<blockquote key={k++}><Markdown text={q.join('\n')}/></blockquote>);continue}
    const li=/^(\s*)([-*+]|\d+[.)])\s+/.exec(l);
    if(li){const ord=/\d/.test(li[2]),items=[];
      while(i<lines.length){const m=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);if(m)items.push({d:Math.min(2,Math.floor(m[1].length/2)),t:m[3]});else if(/^\s{2,}\S/.test(lines[i])&&items.length)items[items.length-1].t+=' '+lines[i].trim();else break;i++}
      out.push(React.createElement(ord?'ol':'ul',{key:k++},items.map((x,y)=><li key={y} style={x.d?{marginLeft:x.d*18}:undefined}>{inline(x.t)}</li>)));continue}
    const p=[l];i++;while(i<lines.length&&lines[i].trim()&&!/^\s*(```|#{1,4}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])&&!isTable(i))p.push(lines[i++]);
    out.push(<p key={k++}>{p.map((x,y)=><React.Fragment key={y}>{y>0&&<br/>}{inline(x)}</React.Fragment>)}</p>);
  }
  return <div className="md">{out}</div>;
}
