import React,{useEffect,useState} from 'react';
import {useWebGPUNode,isSharing,checkSupport,listModels,pickDefault,isCached,defaultName,keepAwakePref,start,stop} from '../webgpu/node.js';
const gb=mb=>(Math.round(mb/102.4)/10).toFixed(1);
export function Progress({st}){
  const pct=Math.round((st.progress||0)*100);
  return <div className="dl"><div className="small mut">{st.text||'Loading…'}</div><div className="bar live"><div style={{width:pct+'%'}}/></div></div>;
}
// "Use this device (WebGPU)": run a model in this browser tab on this device's GPU and add it to the cluster as a node.
export default function ThisDevice({onStarted}){
  const st=useWebGPUNode();
  const [open,setOpen]=useState(false);
  const [sup,setSup]=useState(null);          // result of the WebGPU check
  const [models,setModels]=useState(null);    // models this GPU can run
  const [model,setModel]=useState('');
  const [name,setName]=useState(defaultName);
  const [awake,setAwake]=useState(keepAwakePref);
  const [cached,setCached]=useState(false);
  const [err,setErr]=useState('');
  const sharing=isSharing(st);

  useEffect(()=>{
    if(!open)return;let on=true;
    (async()=>{
      const s=await checkSupport();if(!on)return;setSup(s);if(!s.ok)return;
      try{const m=await listModels(s);if(!on)return;setModels(m);setModel(pickDefault(m))}catch(e){on&&setErr('Could not load the model list: '+e.message)}
    })();
    return()=>{on=false};
  },[open]);
  useEffect(()=>{let on=true;setCached(false);if(model)isCached(model).then(c=>on&&setCached(c));return()=>{on=false}},[model]);

  const rec=models?.find(m=>m.id===model);
  const go=async()=>{setErr('');await start(model,{name,keepAwake:awake,models});onStarted?.()};

  if(sharing)return <div className="thisdev">
    <div className="row"><strong>This device</strong><span className="badge">WebGPU</span><span className="grow"/>
      <button className="danger" onClick={()=>stop()}>Stop sharing</button></div>
    <p className="small"><b>{st.model}</b> — {st.phase==='ready'?'serving as “'+st.nodeName+'”':st.phase==='loading'?'loading…':'failed'}</p>
    {st.phase==='loading'&&<Progress st={st}/>}
    {st.phase==='error'&&<p className="err small">{st.error}</p>}
    {st.phase==='ready'&&<p className="mut small">Keep this tab open: sharing stops when it is closed or reloaded.</p>}
  </div>;

  return <div className="thisdev">
    <div className="row"><strong>This device</strong><span className="badge">WebGPU</span><span className="grow"/>
      {!open&&<button className="pri" onClick={()=>setOpen(true)}>Use this device (WebGPU)</button>}</div>
    <p className="mut small">Run a model right here, in this browser tab, on this device’s GPU — nothing to install.</p>
    {st.notice&&<p className="small">{st.notice}</p>}
    {st.error&&!open&&<p className="err small">{st.error}</p>}
    {open&&<>
      {!sup&&<p className="mut small">Checking WebGPU…</p>}
      {sup&&!sup.ok&&<p className="err small">{sup.message}</p>}
      {sup?.ok&&<>
        <p className="small mut">{sup.software?'⚠ Software (CPU) WebGPU only — it will be very slow. ':'✓ WebGPU available · '}{sup.name}{!sup.features.includes('shader-f16')&&' · no 16-bit shaders (only the f32 models are listed)'}</p>
        <label>Name<input value={name} onChange={e=>setName(e.target.value)}/></label>
        <label>Model{models?<select value={model} onChange={e=>setModel(e.target.value)}>
          {models.map(m=><option key={m.id} value={m.id}>{m.id.replace(/-MLC(-1k)?$/,'')}{m.id.endsWith('-1k')?' (1k ctx)':''} · {gb(m.vramMB)} GB{m.vision?' · vision':''}</option>)}
        </select>:<select disabled><option>Loading model list…</option></select>}</label>
        {rec&&<p className="small mut">Needs about {gb(rec.vramMB)} GB of GPU memory · {rec.ctx.toLocaleString()} tokens of context · {cached?'already downloaded':'downloads once, then cached by the browser'}
          {rec.vision?' · reads images':''} · no tool calling (chat tools won’t run on this node).</p>}
        <label className="check"><input type="checkbox" checked={awake} onChange={e=>setAwake(e.target.checked)}/>Keep this device awake while sharing</label>
        {err&&<p className="err small">{err}</p>}
        <div className="row end"><button onClick={()=>setOpen(false)}>Cancel</button><button className="pri" disabled={!model} onClick={go}>Start sharing this device</button></div>
      </>}
    </>}
  </div>;
}
