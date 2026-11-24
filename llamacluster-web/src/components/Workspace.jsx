import React,{useCallback,useEffect,useRef,useState} from 'react';
import {api,download} from '../api.js';
import Dialog from './Dialog.jsx';
import {CH,rt,emit,saveChat,DEFAULT_SYS,clamp,useChat} from '../chat/store.js';
import {loadTools,setPerm} from '../chat/engine.js';

const kb=n=>n<1024?n+' B':Math.round(n/1024)+' KB';
const err=e=>alert(e.message||String(e));
// Workspace panel (port of the 🗂 Workspace dialog): Tools & settings, Files (view / edit / download) and a sandboxed Terminal.
export default function Workspace({open,onClose}){
  const {ver}=useChat();
  const [tab,setTab]=useState(()=>{try{return localStorage.getItem('lc_wstab')||'tools'}catch{return 'tools'}});
  const pick=t=>{setTab(t);try{localStorage.setItem('lc_wstab',t)}catch{}};
  useEffect(()=>{if(open)loadTools()},[open]);
  return <Dialog open={open} onClose={onClose} title="Workspace">
    <div className="seg" role="tablist">{[['tools','Tools & settings'],['files','Files'],['term','Terminal']].map(([k,l])=><button key={k} role="tab" aria-selected={tab===k} className={tab===k?'on':''} onClick={()=>pick(k)}>{l}</button>)}<span className="grow"/><button className="ghost" onClick={onClose}>Close</button></div>
    {rt.toolinfo&&<p className="mut small">Workspace folder on the controller: <code>{rt.toolinfo.workspace}</code></p>}
    {tab==='tools'&&<ToolsPane key={ver>>8}/>}
    {tab==='files'&&<FilesPane/>}
    {tab==='term'&&<TermPane/>}
  </Dialog>;
}
function ToolsPane(){
  const tools=rt.toolinfo?.tools||[];let section='';
  const seen=new Set(),groups=tools.filter(t=>!seen.has(t.group)&&seen.add(t.group));
  const set=(k,v)=>{CH[k]=v;saveChat();emit()};
  return <div className="wspane">
    <label>Permissions<select value={CH.perm} onChange={e=>setPerm(e.target.value)}>
      <option value="manual">✋ Manual — ask before every tool call</option><option value="semi">🛡 Semi — ask for writes and commands</option><option value="uncontrolled">⚡ Uncontrolled — never ask</option></select></label>
    <div className="tg">{!rt.toolinfo?<span className="mut">none available — update controller.py</span>:groups.map(t=>{
      const head=t.section&&t.section!==section?<div key={'s'+t.group} className="small" style={{gridColumn:'1/-1',marginTop:8}}><b>{t.section}</b></div>:null;section=t.section||'';
      return <React.Fragment key={t.group}>{head}<label className="check"><input type="checkbox" checked={!!CH.tools[t.group]} onChange={e=>{CH.tools={...CH.tools,[t.group]:e.target.checked};saveChat();emit()}}/>{t.title||t.group}{t.blurb&&<span className="mut small"> — {t.blurb}</span>}</label></React.Fragment>})}</div>
    <div className="col2">
      <label>Max tool steps per reply<input type="number" min="1" max="40" value={CH.steps} onChange={e=>set('steps',clamp(+e.target.value||10,1,40))}/></label>
      <label>Max tool result tokens<input type="number" min="100" max="100000" value={CH.toolTok} onChange={e=>set('toolTok',clamp(+e.target.value||3000,100,100000))}/></label>
      <label>Max sub-tasks (Orchestra / Leader)<input type="number" min="1" max="12" value={CH.maxSub} onChange={e=>set('maxSub',clamp(+e.target.value||4,1,12))}/></label>
      <label>Compaction<select value={CH.compactMode} onChange={e=>set('compactMode',e.target.value)}><option value="ai">Summarised by the model</option><option value="script">Script (no model call)</option></select></label></div>
    <label>System prompt <button className="ghost small" onClick={()=>set('sys2',DEFAULT_SYS)}>Reset</button><textarea rows={8} value={CH.sys2} onChange={e=>set('sys2',e.target.value)}/></label>
  </div>;
}
function FilesPane(){
  const [files,setFiles]=useState(null),[msg,setMsg]=useState(''),[text,setText]=useState(''),[,bump]=useState(0);
  const refresh=useCallback(async()=>{try{setFiles(await api('/api/workspace'))}catch(e){setFiles({error:e.message})}},[]);
  useEffect(()=>{refresh()},[refresh]);
  const path=rt.wsOpenPath,setOpen=(p,isNew)=>{rt.wsOpenPath=p;rt.wsIsNew=isNew;emit();bump(x=>x+1)};
  const openFile=async p=>{setMsg('');try{const d=await api('/api/workspace/file?path='+encodeURIComponent(p));setText(d.content);setOpen(p,false)}catch(e){setMsg(e.message)}};
  const newFile=()=>{const p=prompt('New file path (relative to the workspace), e.g. notes/todo.md');if(!p)return;setText('');setMsg('');setOpen(p.trim(),true)};
  const save=async()=>{try{await api('/api/workspace/file','POST',{path,content:text});setOpen(path,false);setMsg('Saved');refresh()}catch(e){setMsg(e.message)}};
  const del=async()=>{if(rt.wsIsNew)return setOpen(null,false);if(!confirm('Delete '+path+'?'))return;try{await api('/api/workspace/file?path='+encodeURIComponent(path),'DELETE');setOpen(null,false);refresh()}catch(e){setMsg(e.message)}};
  const clear=async()=>{const n=files?.files?.length||0;if(!confirm(`Delete EVERYTHING in the workspace${n?` (${n} file${n>1?'s':''} shown, plus hidden ones)`:''}?\n\nThis cannot be undone.`))return;
    try{const r=await api('/api/workspace/clear','POST',{confirm:true});setOpen(null,false);refresh();setMsg(r.errors?.length?`Cleared, but ${r.errors.length} item(s) could not be removed: ${r.errors[0]}`:`Workspace cleared (${r.removed} item${r.removed===1?'':'s'} removed)`)}catch(e){setMsg('Could not clear the workspace: '+e.message)}};
  return <div className="wspane">
    <div className="row"><button onClick={newFile}>+ New file</button><button onClick={refresh}>↻ Refresh</button><button onClick={()=>download('/api/workspace/download.zip','llamacluster-workspace.zip').catch(err)}>↓ Download all</button><span className="grow"/><button className="danger" onClick={clear}>Clear workspace</button></div>
    {path?<div className="wsed"><div className="row"><b className="grow" style={{overflowWrap:'anywhere'}}>{path}{rt.wsIsNew?' (new)':''}</b>
        {!rt.wsIsNew&&<button onClick={()=>download('/api/workspace/download?path='+encodeURIComponent(path),path.split('/').pop()).catch(err)}>↓</button>}
        <button className="pri" onClick={save}>Save</button><button className="danger" onClick={del}>Delete</button><button onClick={()=>setOpen(null,false)}>Close</button></div>
      <textarea className="mono" rows={16} spellCheck={false} value={text} onChange={e=>setText(e.target.value)}/></div>
    :<div className="wsfiles">{!files?<span className="mut">Loading…</span>:files.error?<span className="err">{files.error}</span>:!files.files.length?<span className="mut">empty — the model (or you) can create files here</span>
      :files.files.map(f=><div key={f.path} className="row wsrow" onClick={()=>openFile(f.path)}><span className="grow" style={{minWidth:0,overflowWrap:'anywhere'}}>{f.path}</span><span className="mut small">{kb(f.size)}</span>
        <button className="small" aria-label={'Download '+f.path} onClick={e=>{e.stopPropagation();download('/api/workspace/download?path='+encodeURIComponent(f.path),f.path.split('/').pop()).catch(err)}}>↓</button></div>)}
      {files?.truncated&&<p className="mut small">…list truncated</p>}</div>}
    {msg&&<p className={/^Saved|cleared/i.test(msg)?'mut small':'err small'}>{msg}</p>}
  </div>;
}
// ---- terminal: xterm.js in the page, shell sandboxed on the controller, input/output over plain HTTP long-polling (term.py)
const b64=u8=>{let s='';for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s)};
const unb64=t=>Uint8Array.from(atob(t),c=>c.charCodeAt(0));
function TermPane(){
  const box=useRef(),T=useRef({id:null,pos:0,q:Promise.resolve(),out:'',timer:0,term:null,fit:null});
  const [e,setE]=useState(''),[info,setInfo]=useState('');
  const poll=useCallback(async id=>{const t=T.current;
    while(t.id===id){
      try{const d=await api(`/api/term/${id}/out?pos=${t.pos}&wait=20`);if(t.id!==id)return;t.pos=d.pos;if(d.data)t.term.write(unb64(d.data));
        if(d.closed){t.term.write('\r\n\x1b[33m[session ended - press ↻ New session]\x1b[0m\r\n');t.id=null;return}}
      catch(x){if(/no such terminal/.test(x.message)){t.term.write('\r\n\x1b[33m[session ended]\x1b[0m\r\n');t.id=null;return}await new Promise(z=>setTimeout(z,1500))}
    }},[]);
  const fresh=useCallback(async()=>{const t=T.current;setE('');if(t.id)api(`/api/term/${t.id}/close`,'POST').catch(()=>{});t.id=null;t.term.reset();try{t.fit.fit()}catch{}
    try{const d=await api('/api/term/open','POST',{rows:t.term.rows,cols:t.term.cols});t.id=d.id;t.pos=0;setInfo(d.network?'network on':'no network');poll(d.id);t.term.focus()}
    catch(x){setE(x.message);t.term.write('\x1b[31m'+x.message.replace(/\n/g,'\r\n')+'\x1b[0m\r\n')}},[poll]);
  useEffect(()=>{
    let dead=false,ro;const t=T.current;
    (async()=>{
      try{const [{Terminal},{FitAddon}]=await Promise.all([import('@xterm/xterm'),import('@xterm/addon-fit'),import('@xterm/xterm/css/xterm.css')]);if(dead)return;
        t.term=new Terminal({fontFamily:'ui-monospace,Menlo,Consolas,monospace',fontSize:13,cursorBlink:true,scrollback:5000,theme:{background:'#0b0f14'}});t.fit=new FitAddon();t.term.loadAddon(t.fit);t.term.open(box.current);
        const flush=()=>{t.timer=0;const data=t.out;t.out='';if(!data||!t.id)return;const id=t.id;t.q=t.q.then(()=>api(`/api/term/${id}/in`,'POST',{data:b64(new TextEncoder().encode(data))})).catch(()=>{})};   // keystrokes are sent in order, a few ms apart
        t.term.onData(d=>{t.out+=d;if(!t.timer)t.timer=setTimeout(flush,4)});
        t.term.onResize(({rows,cols})=>{if(t.id)api(`/api/term/${t.id}/resize`,'POST',{rows,cols}).catch(()=>{})});
        ro=new ResizeObserver(()=>{try{t.fit.fit()}catch{}});ro.observe(box.current);
        setTimeout(()=>{try{t.fit.fit()}catch{}},30);fresh();
      }catch(x){setE('Could not load the terminal: '+x.message)}
    })();
    return()=>{dead=true;ro?.disconnect();if(t.id)api(`/api/term/${t.id}/close`,'POST').catch(()=>{});t.id=null;t.term?.dispose();t.term=null};
  },[fresh]);
  return <div className="wspane"><div className="row"><button onClick={fresh}>↻ New session</button><span className="mut small">{info}</span></div>
    {e&&<p className="err small">{e}</p>}<div ref={box} className="tmbox"/></div>;
}
