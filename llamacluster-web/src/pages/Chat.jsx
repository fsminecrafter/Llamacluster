import React,{useEffect,useRef,useState} from 'react';import {Link} from 'react-router-dom';
import {useNodes} from '../useNodes.js';import {ThemeSwitcher} from '../theme.jsx';import ShinyText from '../components/ShinyText.jsx';
import ToolChip from '../components/ToolChip.jsx';import ContextRing from '../components/ContextRing.jsx';import Workspace from '../components/Workspace.jsx';import Agents from '../components/Agents.jsx';
import {ThoughtLine,Segment,StatusMark} from '../components/bits.jsx';
import {CH,rt,emit,saveChat,setNodes,useChat,capsNow,readyNodes,short,IMGS,newId,idbPut,MODES} from '../chat/store.js';
import {shrink} from '../chat/ctx.js';
import {nodeModel} from '../chat/strength.js';
import {loadTools,loadMsgImages,ctxState,groupOk,activeTools,setMode,setPerm,sendMessage,queueMessage,unqueue,stop,regen,clearChat,planAccept,planDecline,planRevise,planMsg,
  swState,SLASH,workspaceFiles,syncScheduled,cancelSchedule,dismissBtw,notice} from '../chat/engine.js';
const PHASE={planning:'Planning…',running:'Working…',synthesizing:'Writing the answer…',done:'Done',failed:'Failed',stopped:'Stopped'};
const LABEL={queued:'Waiting…',running:'Working…',done:'Done',error:'Failed',skipped:'Skipped',stopped:'Stopped'};
const PLACEHOLDER={dev:'Message Calcium, or type / for commands',ask:'Ask about the files in your workspace…',plan:'Describe what you want planned…',orchestra:'Describe a job to split across your nodes…',leader:'Describe a job — the leader plans it and shares the tasks by difficulty…',software:'Describe the software to build — it works alone until time is up…'};
const modeOpts=Object.entries(MODES).map(([k,v])=>[k,v.replace(/^\S+\s/,''),v]);
export default function Chat(){
  const {nodes}=useNodes(4000);const {ver}=useChat();
  const [input,setInput]=useState(''),[imgs,setImgs]=useState([]),[drop,setDrop]=useState(false),[ws,setWs]=useState(false),[files,setFiles]=useState([]),[,tick]=useState(0);
  const end=useRef(),fileIn=useRef(),stick=useRef(true);
  useEffect(()=>setNodes(nodes),[nodes]);
  useEffect(()=>{loadTools();loadMsgImages();syncScheduled();const t=setInterval(()=>{syncScheduled()},20000);return()=>clearInterval(t)},[]);
  useEffect(()=>{if(CH.mode!=='software')return;const t=setInterval(()=>tick(x=>x+1),1000);return()=>clearInterval(t)},[CH.mode]);
  useEffect(()=>{if(stick.current)end.current?.scrollIntoView({block:'end'})},[ver]);
  const busy=!!rt.chatAbort,ready=readyNodes(),models=[...new Set(ready.map(nodeModel))],caps=capsNow(),rs=caps.reasoning;
  const eopts=rs?(rs.kind==='effort'?[['','Default'],...rs.levels.map(l=>[l,l[0].toUpperCase()+l.slice(1)])]:[['','Default'],['off','Off'],['on','On']]):[];
  const sw=swState(),useTools=activeTools().length>0,ctx=ctxState();
  // ---- selects with per-model sampling memory (same as the old UI)
  const msamp=()=>{CH.msamp=CH.msamp||{};if(CH.model)CH.msamp[CH.model]={temp:CH.temp,max:CH.max,effort:CH.effort||''}};
  const setModel=m=>{CH.model=m;CH.effort='';const s=m&&CH.msamp?.[m];if(s){CH.temp=s.temp;CH.max=s.max;CH.effort=s.effort||''}saveChat();emit()};
  const setField=(k,v)=>{CH[k]=v;msamp();saveChat();emit()};
  // ---- images
  const addFiles=async fs=>{try{const ok=[...fs].filter(f=>f.type.startsWith('image/')).slice(0,6-imgs.length);
    const added=await Promise.all(ok.map(async f=>{const id=newId('img');const d=await shrink(f);await idbPut(id,d);return{id,name:f.name||'image'}}));setImgs(x=>[...x,...added])}catch(e){rt.err=e.message;emit()}};
  // ---- slash completion
  useEffect(()=>{let live=true;const m=/^\/(read|view)\s+([^\n]*)$/i.exec(input);if(!m){setFiles([]);return}
    workspaceFiles().then(all=>{if(!live)return;const q=m[2].trim().toLowerCase(),isImg=/^view$/i.test(m[1]);
      setFiles(all.filter(p=>(!isImg||/\.(jpe?g|png|webp|gif|bmp)$/i.test(p))&&(!q||p.toLowerCase().startsWith(q)||p.toLowerCase().split('/').pop().startsWith(q))).slice(0,8).map(p=>[m[1],p]))}).catch(()=>setFiles([]));return()=>{live=false}},[input]);
  const cmds=/^\/\w*$/.test(input)?SLASH.filter(c=>c[0].startsWith(input.toLowerCase())):[];
  const submit=async queue=>{
    const text=input.trim();if(!text&&!imgs.length)return;
    if(busy&&!text.startsWith('/')){if(queueMessage(text,imgs)){setInput('');setImgs([])}return}
    if(queue){if(queueMessage(text,imgs)){setInput('');setImgs([])}return}
    const im=imgs;setInput('');setImgs([]);const ok=await sendMessage(text,im);if(ok===false&&!text.startsWith('/')){setInput(text);setImgs(im)}
  };
  const onKey=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit(e.ctrlKey||e.metaKey)}};
  const onScroll=e=>{const el=e.currentTarget;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<120};
  // ---- messages: tool results are shown inside the assistant message that made the call
  const outs=new Map(CH.msgs.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,m]));
  const last=CH.msgs[CH.msgs.length-1],pm=planMsg();
  const tools=[...new Map((rt.toolinfo?.tools||[]).map(t=>[t.group,t])).values()].filter(t=>CH.tools[t.group]&&groupOk(t.group));
  const hint=useTools?`${tools.length} tool group${tools.length===1?'':'s'} · ${({manual:'✋ manual',semi:'🛡 semi',uncontrolled:'⚡ uncontrolled'})[rt.permOverride||CH.perm]}`:!rt.toolinfo?'tools unavailable (update controller.py)':'no tools';
  return <div className={'chatpage'+(drop?' dropping':'')} onDragOver={e=>{if([...(e.dataTransfer?.types||[])].includes('Files')){e.preventDefault();setDrop(true)}}} onDragLeave={e=>{if(e.target===e.currentTarget)setDrop(false)}} onDrop={e=>{setDrop(false);if(e.dataTransfer?.files?.length){e.preventDefault();addFiles(e.dataTransfer.files)}}}>
    <header className="top"><Link className="btn ghost" to="/">← Cluster</Link><h1><ShinyText on={busy}>Calcium</ShinyText></h1><span className="grow"/>
      <select value={models.includes(CH.model)?CH.model:''} onChange={e=>setModel(e.target.value)} aria-label="Model"><option value="">Any ready node</option>{models.map(m=><option key={m} value={m}>{m}</option>)}</select>
      <select value={ready.some(n=>n.name===CH.route)?CH.route:''} onChange={e=>{CH.route=e.target.value;saveChat();emit()}} aria-label="Send to"><option value="">Auto (load-balanced)</option>{ready.map(n=><option key={n.id} value={n.name}>{n.name}</option>)}</select>
      <ThemeSwitcher/><button onClick={()=>setWs(true)} title="Tools, files and terminal">🗂 Workspace</button><button className="ghost" onClick={clearChat}>Clear</button></header>
    <Workspace open={ws} onClose={()=>setWs(false)}/>
    <details className="cfgbar"><summary>⚙ {CH.model?short(CH.model.replace(/\.gguf$/i,'').split('/').pop(),32):'any model'} · {CH.route||'auto'} · {CH.temp}°{rs&&CH.effort?' · 🧠 '+CH.effort:''}</summary><div className="col2">
      <label>Temperature<input type="number" step="0.1" min="0" max="2" value={CH.temp} onChange={e=>setField('temp',e.target.value===''?0.7:+e.target.value)}/></label>
      <label>Max tokens<input type="number" min="1" placeholder="no limit" value={CH.max} onChange={e=>setField('max',e.target.value===''?'':+e.target.value)}/></label>
      {rs&&<label>{rs.kind==='effort'?'Reasoning effort':'Thinking'}<select title={rs.kind==='effort'?'Low = quick answers, High = think longer.':'Turns the model’s thinking on or off.'} value={eopts.some(o=>o[0]===CH.effort)?CH.effort:''} onChange={e=>setField('effort',e.target.value)}>{eopts.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>}
    </div></details>
    <div className="log" onScroll={onScroll}><div className="col">
      {!CH.msgs.length&&<div className="empty"><h2><ShinyText>How can I help?</ShinyText></h2><p className="mut">{ready.length?`${ready.length} node${ready.length>1?'s':''} ready.`:'No node is serving yet. Start a model from the cluster page.'}</p></div>}
      {CH.msgs.map((m,i)=>{
        if(m.role==='tool')return null;
        if(m.role==='compact')return <details key={i} className="note"><summary>📦 Earlier messages summarised{m.auto?' (automatic)':''}</summary><pre className="tcb">{m.content}</pre></details>;
        if(m.role==='orchestra')return <Orch key={i} m={m}/>;
        if(m.local)return <div key={i} className="note">{m.content}</div>;
        if(m.role==='user'&&m.auto)return <div key={i} className="note">↻ {m.label||short(m.content,80)}</div>;
        const last=i===CH.msgs.length-1,live=!!m.streaming;
        return <div key={i} className={'msg '+m.role+(m.agentName?' agentmsg agent-'+m.agentName.toLowerCase():'')}>
          {m.agentName&&<div className="small mut"><b>{m.agentName}</b>{m.node?' · '+m.node:''}</div>}
          {m.images?.length>0&&<div className="imgs">{m.images.map(x=>IMGS[x.id]?<img key={x.id} src={IMGS[x.id]} alt={x.name}/>:<span key={x.id} className="mut small">🖼 {x.name} — image no longer stored (images are not kept after a reload)</span>)}</div>}
          {m.reasoning&&<ThoughtLine text={m.reasoning} live={live&&!m.content&&!m.tool_calls}/>}
          {(m.tool_calls||[]).length>0&&<div className="tcs">{m.tool_calls.map(c=><ToolChip key={c.id} c={c} out={outs.get(c.id)} running={busy&&last||busy&&!outs.get(c.id)&&i>=CH.msgs.length-2}/>)}</div>}
          {(m.content||(live&&!m.tool_calls&&!m.reasoning))&&<div className="body">{m.content||<ShinyText>Thinking…</ShinyText>}</div>}
          {m.error&&<p className="err small">{m.error}</p>}{m.stopped&&<p className="mut small">stopped</p>}
          {m.role==='assistant'&&!live&&(m.node||m.tps)&&<div className="mut small meta">{m.node}{m.tps?` · ${m.tps.toFixed(1)} tok/s`:''}</div>}
          {m.plan==='pending'&&!busy&&i===CH.msgs.length-1&&<PlanBar/>}
          {m.role==='assistant'&&!m.agentName&&last&&!busy&&!m.tool_calls&&<div className="row"><button className="ghost small" onClick={regen} title="Regenerate">↻ Regenerate</button><button className="ghost small" onClick={()=>navigator.clipboard?.writeText(m.content||'')}>Copy</button></div>}
        </div>})}
      {rt.err&&<p className="err">{rt.err}</p>}<div ref={end}/></div></div>
    {CH.btw.length>0&&<div className="btwbox">{CH.btw.map(b=><div key={b.id}><b>/btw {b.q}</b><div className={'small'+(b.state==='err'?' err':'')}>{b.state==='run'?<ShinyText>Thinking…</ShinyText>:b.a}</div><button className="ghost small" onClick={()=>dismissBtw(b.id)}>Dismiss</button></div>)}</div>}
    <footer className="composer-wrap">
      {rt.ask&&<AskBox ask={rt.ask}/>}
      <Agents/>
      {CH.tasks.length>0&&<details className="taskbox" open><summary>Tasks · {CH.tasks.filter(t=>t.status==='done').length}/{CH.tasks.length} done</summary>
        {CH.tasks.map(t=><div key={t.id} className={'tk '+t.status}><button className="ghost" title="Change status" onClick={()=>{t.status={todo:'doing',doing:'done',done:'todo'}[t.status];saveChat();emit()}}>{{todo:'○',doing:'◐',done:'✓'}[t.status]}</button><span className="grow">{t.title}</span><button className="ghost" aria-label="Remove task" onClick={()=>{CH.tasks=CH.tasks.filter(x=>x!==t);saveChat();emit()}}>×</button></div>)}
        <div className="row"><button className="ghost small" onClick={()=>{CH.tasks=CH.tasks.filter(t=>t.status!=='done');saveChat();emit()}}>Clear done</button><button className="ghost small" onClick={()=>{CH.tasks=[];saveChat();emit()}}>Clear all</button></div></details>}
      {rt.scheduled?.length>0&&<details className="taskbox"><summary>⏰ Scheduled tasks · {rt.scheduled.filter(t=>['scheduled','running'].includes(t.status)).length} active</summary>
        {rt.scheduled.slice(-30).reverse().map(t=><div key={t.id} className="tk"><span className="grow small"><b>{t.status}</b> · {new Date(t.due_at*1000).toLocaleString()} · {t.prompt}{t.result&&<div className="mut">{short(t.result,400)}</div>}{t.error&&<div className="err">{t.error}</div>}</span>
          {['scheduled','running'].includes(t.status)&&<button className="ghost" onClick={()=>cancelSchedule(t.id)}>Cancel</button>}</div>)}</details>}
      {CH.queue.length>0&&<div className="taskbox">Queue ({CH.queue.length}) · Ctrl+Enter adds a message{CH.queue.map((q,i)=><div key={i} className="row"><span className="grow small">{short(q.text||'Image attachment',100)}{q.images?.length?` · ${q.images.length} image${q.images.length===1?'':'s'}`:''}</span><button className="ghost small" onClick={()=>unqueue(i)}>×</button></div>)}</div>}
      <div className="chips"><Segment label="Mode" value={CH.mode} options={modeOpts} onChange={setMode}/>
        {CH.mode==='leader'&&<select value={ready.some(n=>n.name===CH.leader)?CH.leader:''} onChange={e=>{CH.leader=e.target.value;saveChat();emit()}} aria-label="Leader node"><option value="">👑 Leader: auto (strongest)</option>{ready.map(n=><option key={n.id} value={n.name}>👑 {n.name} · {String(nodeModel(n)).replace(/\.gguf$/i,'')}</option>)}</select>}
        {CH.mode==='software'&&<label className="row small mut">Minutes<input type="number" min="0.1" max="720" disabled={sw.running||sw.going} value={CH.swMin} onChange={e=>{CH.swMin=+e.target.value||30;saveChat();emit()}} style={{width:68}}/></label>}
        <select value={CH.perm} onChange={e=>setPerm(e.target.value)} aria-label="Tool permissions" disabled={!useTools}><option value="manual">✋ Manual</option><option value="semi">🛡 Semi</option><option value="uncontrolled">⚡ Uncontrolled</option></select>
        {rs&&<select value={eopts.some(o=>o[0]===CH.effort)?CH.effort:''} onChange={e=>setField('effort',e.target.value)} aria-label={rs.kind==='effort'?'Reasoning effort':'Thinking'} title={rs.kind==='effort'?'Reasoning effort: low = quick, high = think longer':'Thinking on/off'}>{eopts.map(([v,l])=><option key={v} value={v}>🧠 {l}</option>)}</select>}
        <span className="mut small">{sw.label||hint}</span></div>
      {(cmds.length>0||files.length>0)&&<div className="slash">{cmds.map(c=><button key={c[0]} onClick={()=>setInput(c[0]+' ')}><b>{c[0]}</b> <span className="mut">{c[1]}</span></button>)}{files.map(([c,p])=><button key={p} onClick={()=>setInput(`/${c.toLowerCase()} ${p} `)}><b>{p}</b> <span className="mut">file</span></button>)}</div>}
      {imgs.length>0&&<div className="imgs thumbs">{imgs.map(x=><span key={x.id}>{IMGS[x.id]&&<img src={IMGS[x.id]} alt=""/>}<button onClick={()=>setImgs(imgs.filter(y=>y.id!==x.id))} aria-label="Remove image">×</button></span>)}{!caps.vision&&<span className="mut small">The selected model can’t read images — pick a vision model before sending.</span>}</div>}
      <div className="composer"><button className="ghost" title={caps.vision?'Attach an image (or paste / drop one)':'Attach now; select a multimodal model with a loaded vision projector before sending.'} onClick={()=>fileIn.current.click()}>📎</button><input ref={fileIn} type="file" accept="image/*" multiple hidden onChange={e=>{addFiles(e.target.files);e.target.value=''}}/>
        <textarea rows={1} value={input} placeholder={PLACEHOLDER[CH.mode]} onChange={e=>setInput(e.target.value)} onKeyDown={onKey} onPaste={e=>{const f=[...(e.clipboardData?.files||[])].filter(x=>/^image\//.test(x.type));if(f.length){e.preventDefault();addFiles(f)}}}/>
        <ContextRing s={ctx}/>
        {busy&&!input.trim()&&!imgs.length?<button onClick={stop}>Stop</button>:<button className="pri" disabled={!input.trim()&&!imgs.length} onClick={()=>submit(false)}>{busy?'Queue':'Send'}</button>}</div>
    </footer>
  </div>;
}
function PlanBar(){
  const [fb,setFb]=useState('');
  return <div className="plan row"><button className="pri" onClick={planAccept}>Accept &amp; build</button><button onClick={planDecline}>Decline</button>
    <input className="grow" placeholder="…or type what to change" value={fb} onChange={e=>setFb(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')planRevise(fb)}}/><button disabled={!fb.trim()} onClick={()=>planRevise(fb)}>Revise</button></div>;
}
function Orch({m}){
  const lead=m.kind==='leader';
  return <div className="msg assistant orchcard"><div className="row small"><StatusMark state={m.phase==='done'?'ok':m.phase==='failed'?'err':['stopped'].includes(m.phase)?'idle':'run'}/><b>{lead?'👑 Leader':'🎼 Orchestra'}</b><span className="mut">{PHASE[m.phase]||m.phase}</span></div>
    {m.nodes?.length>0&&<div className="mut small">{m.nodes.map(n=>`${n.leader?'👑 ':''}${n.name} (${String(n.model).replace(/\.gguf$/i,'')})`).join(' · ')}</div>}
    {m.note&&<div className="mut small">{m.note}</div>}
    <div className="orch">{m.tasks.map((k,j)=><details key={j} className={'tc '+(k.status==='running'?'run':k.status==='error'?'err':k.status==='done'?'ok':'')}>
      <summary><span className="tcv">{LABEL[k.status]||k.status}</span><span className="tct">{k.title}{k.difficulty?' · '+'●'.repeat(k.difficulty)+'○'.repeat(3-k.difficulty):''}{k.deps?.length?' · after '+k.deps.join(', '):''}</span><span className="mut small">{k.node}{k.tps?` · ${k.tps.toFixed(1)} tok/s`:''}</span></summary>
      <pre className="tcb">{[k.steps?.length?k.steps.join('\n')+'\n':'',k.result||k.error||(k.status==='queued'?k.prompt:'')].join('')}</pre></details>)}</div></div>;
}
function AskBox({ask}){
  const [v,setV]=useState('');
  return <div className="askbox"><b>{ask.q}</b>{ask.o.length>0&&<div className="row">{ask.o.map((o,i)=><button key={i} onClick={()=>ask.done({answer:o,choice:i+1})}>{o}</button>)}</div>}
    <div className="row"><input style={{flex:1}} value={v} placeholder={ask.o.length?'…or type your own answer':'Your answer'} onChange={e=>setV(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&v.trim())ask.done({answer:v.trim(),custom:true})}}/>
      <button className="pri" disabled={!v.trim()} onClick={()=>ask.done({answer:v.trim(),custom:true})}>Answer</button>
      <button onClick={()=>ask.done({answer:null,skipped:true,note:'the user skipped the question - decide yourself or carry on without the answer'})}>Skip</button></div></div>;
}
