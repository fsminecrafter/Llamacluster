import React,{useState} from 'react';import Dialog from './Dialog.jsx';import {api} from '../api.js';
const hf=u=>fetch('https://huggingface.co/api/'+u).then(r=>r.json());
export default function InstallModel({open,onClose,nodes,refresh,preset}){
  const online=nodes.filter(n=>n.online);
  const [q,setQ]=useState('');const [res,setRes]=useState([]);const [f,setF]=useState({repo:'',filename:'',url:''});const [sel,setSel]=useState({});const [err,setErr]=useState('');const [busy,setBusy]=useState(false);
  const targets=online.filter(n=>sel[n.id]??n.id===preset).map(n=>n.id);
  const search=async()=>{if(!q.trim())return;setBusy(true);try{setRes((await hf(`models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&limit=15`)).map(m=>({label:m.id,sub:'↓'+m.downloads,repo:m.id})))}catch(e){setErr('Search failed: '+e.message)}setBusy(false)};
  const files=async repo=>{try{setRes((await hf(`models/${repo}/tree/main`)).filter(x=>x.path.endsWith('.gguf')).map(x=>({label:x.path,sub:Math.round((x.lfs?.size||x.size)/1048576)+' MB'+(/mmproj/i.test(x.path)?' · vision projector':''),repo,file:x.path})))}catch(e){setErr(e.message)}};
  const pick=r=>r.file?setF({...f,repo:r.repo,filename:r.file}):files(r.repo);
  const go=async()=>{if(!targets.length)return setErr('Pick at least one node.');
    const out=await Promise.allSettled(targets.map(id=>api(`/api/nodes/${id}/models/install`,'POST',f)));
    const bad=out.filter(o=>o.status==='rejected').map(o=>o.reason.message);bad.length?setErr(bad.join(' | ')):(setErr(''),onClose());refresh()};
  return <Dialog open={open} onClose={onClose} title="Install model">
    <div className="row"><input style={{flex:1}} value={q} placeholder="Search Hugging Face GGUF, e.g. qwen2.5 7b instruct" onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()}/><button onClick={search} disabled={busy}>Search</button></div>
    <div className="hf">{res.map(r=><div key={r.label} onClick={()=>pick(r)}>{r.label} <span className="mut small">{r.sub}</span></div>)}</div>
    <div className="col2"><label>HF repo<input value={f.repo} onChange={e=>setF({...f,repo:e.target.value})}/></label><label>File<input value={f.filename} onChange={e=>setF({...f,filename:e.target.value})}/></label></div>
    <label>Or a direct .gguf URL<input value={f.url} onChange={e=>setF({...f,url:e.target.value})}/></label>
    <p className="mut small">Download on these nodes:</p>
    {online.map(n=><label key={n.id} className="check"><input type="checkbox" checked={targets.includes(n.id)} onChange={e=>setSel({...sel,[n.id]:e.target.checked})}/>{n.name} <span className="badge">{n.kind}</span></label>)}
    {err&&<p className="err small">{err}</p>}
    <div className="row end"><button onClick={onClose}>Close</button><button className="pri" onClick={go}>Download</button></div>
  </Dialog>;
}
