import React,{useEffect,useState} from 'react';import {Link} from 'react-router-dom';
import {api} from '../api.js';import {useNodes} from '../useNodes.js';import {ThemeSwitcher} from '../theme.jsx';
import SpotlightCard from '../components/SpotlightCard.jsx';import ShinyText from '../components/ShinyText.jsx';import AddNode from '../components/AddNode.jsx';import InstallModel from '../components/InstallModel.jsx';
const gb=mb=>Math.round((mb||0)/102.4)/10;
// Per-(node,model) settings; same localStorage key/shape as the old ui.html so saved configs carry over.
const FIELDS=[['ctx_size','Context size'],['gpu_layers','GPU layers'],['threads','Threads'],['parallel','Parallel slots'],['batch_size','Batch'],['ubatch_size','Ubatch']];
const mc=()=>{try{return JSON.parse(localStorage.getItem('lc_mcfg')||'{}')||{}}catch{return {}}};
const defaults=n=>{const hw=n.info?.hardware||{};return {ctx_size:4096,gpu_layers:(hw.gpus||[]).length?99:0,threads:Math.max(1,Math.floor((hw.cpu_count||4)/2)),parallel:1,batch_size:2048,ubatch_size:512,extra_args:''}};
function Logs({id}){const [t,setT]=useState('');useEffect(()=>{let on=true;const f=async()=>{try{const d=await api(`/api/nodes/${id}/logs`);on&&setT(d.lines.join('\n'))}catch{}};f();const i=setInterval(f,2000);return()=>{on=false;clearInterval(i)}},[id]);return <pre className="log">{t||'No log output yet.'}</pre>}
function NodeCard({n,refresh}){
  const st=n.info?.server?.state||'offline',models=n.info?.models||[],hw=n.info?.hardware||{};
  const [model,setModel]=useState(n.info?.server?.config?.model||models[0]?.name||'');const [err,setErr]=useState('');
  const [cfg,setCfg]=useState(()=>({...defaults(n),...(mc()[n.id+'|'+model]||{})}));const [logs,setLogs]=useState(false);
  const pickModel=m=>{setModel(m);setCfg({...defaults(n),...(mc()[n.id+'|'+m]||{})})};
  const edit=(k,v)=>{const c={...cfg,[k]:v};setCfg(c);const all=mc();all[n.id+'|'+model]=c;try{localStorage.setItem('lc_mcfg',JSON.stringify(all))}catch{}};
  const num=v=>v===''||v==null?undefined:Number(v);
  const start=()=>act('start',{model,...Object.fromEntries(FIELDS.map(([k])=>[k,num(cfg[k])])),extra_args:cfg.extra_args,supports_images:true,mmproj_offload:true});
  const act=async(path,body)=>{try{setErr('');await api(`/api/nodes/${n.id}/${path}`,'POST',body);refresh()}catch(e){setErr(e.message)}};
  const gpus=(hw.gpus||[]).map(g=>`${g.name} ${gb(g.vram_used_mb)}/${gb(g.vram_total_mb)} GB`).join(', ');
  return <SpotlightCard className="node">
    <div className="row"><span className={'dot '+(n.online?st:'')}/><h3>{n.name}</h3><span className="badge">{n.kind}</span><span className="grow"/>
      <button className="ghost danger" onClick={async()=>{if(confirm('Remove this node? The worker keeps running.')){await api('/api/nodes/'+n.id,'DELETE');refresh()}}}>Remove</button></div>
    {!n.online?<p className="err">Offline: {n.error||'unreachable'}</p>:<>
      <p className="mut small">{st}{n.info.server.vision?' · vision':''} · {hw.cpu_count} CPU · {gb(hw.ram_free_mb)}/{gb(hw.ram_total_mb)} GB RAM{gpus?' · '+gpus:''}</p>
      <div className="row"><select value={model} onChange={e=>pickModel(e.target.value)} disabled={!models.length}>{models.length?models.map(m=><option key={m.name}>{m.name}</option>):<option>No models installed</option>}</select>
        <button className="pri" disabled={!model||st==='ready'||st==='loading'} onClick={start}>Start</button>
        <button disabled={st==='stopped'} onClick={()=>act('stop')}>Stop</button>
        <button className="ghost" onClick={()=>setLogs(!logs)}>{logs?'Hide logs':'Logs'}</button></div>
      <details className="fold"><summary>Settings</summary><div className="col2">{FIELDS.map(([k,l])=><label key={k}>{l}<input type="number" value={cfg[k]??''} onChange={e=>edit(k,e.target.value)}/></label>)}</div>
        <label>Extra llama-server args<input value={cfg.extra_args||''} placeholder="--flash-attn on --cache-type-k q8_0" onChange={e=>edit('extra_args',e.target.value)}/></label></details>
      {(n.info.downloads||[]).slice(-3).map(d=>{const pct=d.state==='done'?100:d.total?Math.round(d.done/d.total*100):0;return <div key={d.id} className="small dl">{d.file} — {d.state==='running'||d.state==='retrying'?`${pct}%`:d.state+(d.error?': '+d.error:'')}{(d.state==='running'||d.state==='retrying')&&<> <a href="#" onClick={e=>{e.preventDefault();act('models/cancel',{id:d.id})}}>cancel</a></>}<div className="bar"><div style={{width:pct+'%'}}/></div></div>})}
      <details className="fold"><summary>Installed models ({models.length})</summary>{models.map(m=><div key={m.name} className="row small"><span className="grow">{m.name}</span><span className="mut">{m.size_mb} MB</span><button className="ghost danger" onClick={()=>confirm('Delete '+m.name+'?')&&act('models/delete',{name:m.name})}>Delete</button></div>)}</details>
      {logs&&<Logs id={n.id}/>}</>}
    {err&&<p className="err small">{err}</p>}
  </SpotlightCard>;
}
export default function Dashboard(){
  const {nodes,error,refresh}=useNodes();const ready=nodes.filter(n=>n.info?.server?.state==='ready').length;
  const gw=location.origin+'/v1';const [add,setAdd]=useState(false),[inst,setInst]=useState(false);
  return <div className="page">
    <header className="top"><h1><ShinyText on={ready>0}>LlamaCluster</ShinyText></h1>
      <button className="gw" title="Copy" onClick={()=>navigator.clipboard?.writeText(gw)}>{gw}</button><span className="grow"/>
      <span className="mut small">{ready?`${ready} node${ready>1?'s':''} serving`:'no node serving'}</span><ThemeSwitcher/><button onClick={()=>setInst(true)}>Install model</button><button onClick={()=>setAdd(true)}>Add node</button><Link className="btn pri" to="/chat">Open chat</Link></header>
    {error&&<p className="err pad">{error}</p>}
    <main className="grid">{nodes.map(n=><NodeCard key={n.id} n={n} refresh={refresh}/>)}
      {!nodes.length&&!error&&<p className="mut pad">No nodes yet. Add a worker to get started.</p>}</main>
    <AddNode open={add} onClose={()=>setAdd(false)} refresh={refresh}/><InstallModel open={inst} onClose={()=>setInst(false)} nodes={nodes} refresh={refresh}/>
  </div>;
}
