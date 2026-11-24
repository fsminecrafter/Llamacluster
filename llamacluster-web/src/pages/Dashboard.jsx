import React,{useEffect,useRef,useState} from 'react';
import {api} from '../api.js';import {useNodes} from '../useNodes.js';import {ThemeSwitcher} from '../theme.jsx';
import SpotlightCard from '../components/SpotlightCard.jsx';import ShinyText from '../components/ShinyText.jsx';import AddNode from '../components/AddNode.jsx';import InstallModel from '../components/InstallModel.jsx';
import {Progress} from '../components/ThisDevice.jsx';import {useWebGPUNode,clientId,stop as stopSharing} from '../webgpu/node.js';
import DotGrid from '../components/DotGrid.jsx';import CountUp from '../components/CountUp.jsx';import BlurText from '../components/BlurText.jsx';import Meter from '../components/Meter.jsx';import TLink from '../components/TLink.jsx';
const gb=mb=>Math.round((mb||0)/102.4)/10;
const sum=(a,f)=>a.reduce((t,x)=>t+(f(x)||0),0);
// Per-(node,model) settings; same localStorage key/shape as the old ui.html so saved configs carry over.
const FIELDS=[['ctx_size','Context size'],['gpu_layers','GPU layers'],['threads','Threads'],['parallel','Parallel slots'],['batch_size','Batch'],['ubatch_size','Ubatch']];
const mc=()=>{try{return JSON.parse(localStorage.getItem('lc_mcfg')||'{}')||{}}catch{return {}}};
const defaults=n=>{const hw=n.info?.hardware||{};return {ctx_size:4096,gpu_layers:(hw.gpus||[]).length?99:0,threads:Math.max(1,Math.floor((hw.cpu_count||4)/2)),parallel:1,batch_size:2048,ubatch_size:512,extra_args:''}};
const STATE={ready:'Ready',loading:'Loading',stopped:'Stopped',offline:'Offline'};
function Logs({id}){const [t,setT]=useState('');useEffect(()=>{let on=true;const f=async()=>{try{const d=await api(`/api/nodes/${id}/logs`);on&&setT(d.lines.join('\n'))}catch{}};f();const i=setInterval(f,2000);return()=>{on=false;clearInterval(i)}},[id]);return <pre className="log">{t||'No log output yet.'}</pre>}
function NodeCard({n,i,refresh}){
  const st=n.online?(n.info?.server?.state||'stopped'):'offline',models=n.info?.models||[],hw=n.info?.hardware||{},gpus=hw.gpus||[];
  const [model,setModel]=useState(n.info?.server?.config?.model||models[0]?.name||'');const [err,setErr]=useState('');
  const [cfg,setCfg]=useState(()=>({...defaults(n),...(mc()[n.id+'|'+model]||{})}));const [logs,setLogs]=useState(false);
  const pickModel=m=>{setModel(m);setCfg({...defaults(n),...(mc()[n.id+'|'+m]||{})})};
  const edit=(k,v)=>{const c={...cfg,[k]:v};setCfg(c);const all=mc();all[n.id+'|'+model]=c;try{localStorage.setItem('lc_mcfg',JSON.stringify(all))}catch{}};
  const num=v=>v===''||v==null?undefined:Number(v);
  const act=async(path,body)=>{try{setErr('');await api(`/api/nodes/${n.id}/${path}`,'POST',body);refresh()}catch(e){setErr(e.message)}};
  const start=()=>act('start',{model,...Object.fromEntries(FIELDS.map(([k])=>[k,num(cfg[k])])),extra_args:cfg.extra_args,supports_images:true,mmproj_offload:true});
  const ramTotal=gb(hw.ram_total_mb),ramUsed=Math.max(0,ramTotal-gb(hw.ram_free_mb));
  const vramTotal=gb(sum(gpus,g=>g.vram_total_mb)),vramUsed=gb(sum(gpus,g=>g.vram_used_mb));
  return <SpotlightCard className={'node enter '+st} style={{'--i':Math.min(i,6)}}>
    {st==='loading'&&<i className="loadbar" aria-hidden="true"/>}
    <div className="row"><span className={'dot '+(n.online?st:'')}/><h3>{n.name}</h3><span className="badge">{n.kind}</span><span className={'nstate '+st}>{STATE[st]||st}</span><span className="grow"/>
      <button className="ghost danger" onClick={async()=>{if(confirm('Remove this node? The worker keeps running.')){await api('/api/nodes/'+n.id,'DELETE');refresh()}}}>Remove</button></div>
    {!n.online?<p className="err">Can’t reach this node: {n.error||'no answer'}. Check that its worker is running.</p>:<>
      <div className="meters">{ramTotal>0&&<Meter label="Memory" used={ramUsed} total={ramTotal}/>}
        {vramTotal>0&&<Meter label="GPU memory" used={vramUsed} total={vramTotal} title={gpus.map(g=>g.name).join(', ')}/>}</div>
      <p className="mut small">{hw.cpu_count} CPU threads{gpus.length?' · '+gpus.map(g=>g.name).join(', '):' · no GPU'}{n.info.server.vision?' · reads images':''}</p>
      <div className="row"><select value={model} onChange={e=>pickModel(e.target.value)} disabled={!models.length}>{models.length?models.map(m=><option key={m.name}>{m.name}</option>):<option>No models installed</option>}</select>
        <button className="pri" disabled={!model||st==='ready'||st==='loading'} onClick={start}>Start</button>
        <button disabled={st==='stopped'} onClick={()=>act('stop')}>Stop</button>
        <button className="ghost" onClick={()=>setLogs(!logs)}>{logs?'Hide logs':'Logs'}</button></div>
      <details className="fold"><summary>Settings</summary><div className="col2">{FIELDS.map(([k,l])=><label key={k}>{l}<input type="number" value={cfg[k]??''} onChange={e=>edit(k,e.target.value)}/></label>)}</div>
        <label>Extra llama-server args<input value={cfg.extra_args||''} placeholder="--flash-attn on --cache-type-k q8_0" onChange={e=>edit('extra_args',e.target.value)}/></label></details>
      {(n.info.downloads||[]).slice(-3).map(d=>{const live=d.state==='running'||d.state==='retrying',pct=d.state==='done'?100:d.total?Math.round(d.done/d.total*100):0;return <div key={d.id} className="small dl">{d.file} — {live?`${pct}%`:d.state+(d.error?': '+d.error:'')}{live&&<> <a href="#" onClick={e=>{e.preventDefault();act('models/cancel',{id:d.id})}}>cancel</a></>}<div className={'bar'+(live?' live':'')}><div style={{width:pct+'%'}}/></div></div>})}
      <details className="fold"><summary>Installed models ({models.length})</summary>{models.map(m=><div key={m.name} className="row small"><span className="grow">{m.name}</span><span className="mut">{m.size_mb} MB</span><button className="ghost danger" onClick={()=>confirm('Delete '+m.name+'?')&&act('models/delete',{name:m.name})}>Delete</button></div>)}</details>
      {logs&&<Logs id={n.id}/>}</>}
    {err&&<p className="err small">{err}</p>}
  </SpotlightCard>;
}
function BrowserNodeCard({n,i,refresh,onChange}){
  const local=useWebGPUNode(),b=n.info?.browser||{},mine=b.client_id===clientId;
  const st=n.online?(n.info?.server?.state||'stopped'):'offline',gpu=(n.info?.hardware?.gpus||[])[0]?.name,model=n.info?.server?.config?.model||n.info?.models?.[0]?.name;
  const loading=mine?local.phase==='loading':st==='loading',pr=mine?local:{progress:b.progress,text:b.text};
  const err=mine?local.error:b.error;
  const remove=async()=>{if(mine){await stopSharing()}else if(confirm('Remove this browser node? That tab stops sharing.')){await api('/api/nodes/'+n.id,'DELETE')}refresh()};
  return <SpotlightCard className={'node enter '+st} style={{'--i':Math.min(i,6)}}>
    {st==='loading'&&<i className="loadbar" aria-hidden="true"/>}
    <div className="row"><span className={'dot '+(n.online?st:'')}/><h3>{n.name}</h3><span className="badge">browser</span>{mine&&<span className="badge">this tab</span>}<span className={'nstate '+st}>{STATE[st]||st}</span><span className="grow"/>
      {mine&&<button onClick={onChange}>Change model</button>}
      <button className="ghost danger" onClick={remove}>{mine?'Stop sharing':'Remove'}</button></div>
    {!n.online?<p className="err">This browser tab isn’t connected ({n.error||'closed, asleep or offline'}). It is dropped after a few minutes, or remove it now.</p>:<>
      <p className="mut small">WebGPU{gpu?' · '+gpu:''}{model?' · ':''}<b>{model}</b>{n.info?.server?.vision?' · reads images':''}{b.busy?' · generating':''}{b.memory_gb?` · ≥${b.memory_gb} GB RAM`:''}</p>
      {loading&&<Progress st={pr}/>}
      {err&&<p className="err small">{err}</p>}
      {mine&&local.phase==='ready'&&<p className="mut small">Served {local.served} request{local.served===1?'':'s'}{local.tps?` · last ${local.tps} tok/s`:''}{local.conn==='reconnecting'?' · reconnecting to the controller…':''}</p>}
      {!mine&&<p className="mut small">Runs in a browser on another device — keep that tab open. No tool calling on this node.</p>}</>}
  </SpotlightCard>;
}
export default function Dashboard(){
  const {nodes,error,refresh}=useNodes();const [add,setAdd]=useState(false),[inst,setInst]=useState(false),[copied,setCopied]=useState(false),[pulse,setPulse]=useState(0);
  const online=nodes.filter(n=>n.online),ready=nodes.filter(n=>n.info?.server?.state==='ready').length;
  const gw=location.origin+'/v1';
  // a ripple crosses the background each time more nodes start serving
  const prev=useRef(0);useEffect(()=>{if(ready>prev.current)setPulse(p=>p+1);prev.current=ready},[ready]);
  const headline=!nodes.length?(error?'Controller not reachable':'Add your first node'):ready?`${ready} of ${nodes.length} node${nodes.length>1?'s':''} serving`:'Nothing is serving yet';
  const hint=!nodes.length?(error?error:'A node is a computer running worker.py. On this computer, start LlamaCluster with ./start.sh --worker.'):ready?'Chat and API clients can use the gateway now.':'Pick a model on a node and press Start.';
  const copy=()=>{navigator.clipboard?.writeText(gw);setCopied(true);setTimeout(()=>setCopied(false),1600)};
  return <div className="page">
    <header className="top"><h1><ShinyText on={ready>0}>LlamaCluster</ShinyText></h1><span className="grow"/>
      <ThemeSwitcher/><button onClick={()=>setInst(true)}>Install model</button><button onClick={()=>setAdd(true)}>Add node</button><TLink className="btn pri" to="/chat">Open chat</TLink></header>
    <section className="hero"><DotGrid energy={ready} pulse={pulse}/>
      <div className="hero-in">
        <h2 className="hero-h"><BlurText key={headline} text={headline}/></h2>
        <p className="mut hero-p">{hint}</p>
        <div className="row"><button className={'gw'+(copied?' done':'')} title="Copy the gateway address" onClick={copy}>{copied?'Copied':gw}</button><span className="mut small">OpenAI-compatible gateway</span></div>
        <div className="stats">
          <div className="stat"><b><CountUp value={online.length}/><small> / {nodes.length}</small></b><span>nodes online</span></div>
          <div className="stat"><b><CountUp value={ready}/></b><span>serving</span></div>
          <div className="stat"><b><CountUp value={gb(sum(online,n=>sum(n.info?.hardware?.gpus||[],g=>g.vram_total_mb)))} decimals={1}/><small> GB</small></b><span>GPU memory</span></div>
          <div className="stat"><b><CountUp value={sum(online,n=>(n.info?.models||[]).length)}/></b><span>models installed</span></div>
        </div></div></section>
    {error&&nodes.length>0&&<p className="err pad">{error}</p>}
    <main className="grid">{nodes.map((n,i)=>n.kind==='browser'?<BrowserNodeCard key={n.id} n={n} i={i} refresh={refresh} onChange={()=>setAdd(true)}/>:<NodeCard key={n.id} n={n} i={i} refresh={refresh}/>)}
      {!nodes.length&&<div className="emptycard"><p className="mut">No nodes yet.</p><button className="pri" onClick={()=>setAdd(true)}>Add node</button></div>}</main>
    <AddNode open={add} onClose={()=>setAdd(false)} refresh={refresh}/><InstallModel open={inst} onClose={()=>setInst(false)} nodes={nodes} refresh={refresh}/>
  </div>;
}
