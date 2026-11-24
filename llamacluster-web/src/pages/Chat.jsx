import React,{useEffect,useRef,useState} from 'react';import TLink from '../components/TLink.jsx';import {Link} from 'react-router-dom';import BlurText from '../components/BlurText.jsx';
import {useNodes} from '../useNodes.js';import {useTheme,THEMES} from '../theme.jsx';import ShinyText from '../components/ShinyText.jsx';
import ToolChip from '../components/ToolChip.jsx';import ContextRing from '../components/ContextRing.jsx';import Workspace from '../components/Workspace.jsx';import Agents from '../components/Agents.jsx';import Markdown from '../components/Markdown.jsx';import GlideSelect from '../components/GlideSelect.jsx';
import {ThoughtLine,StatusMark,LatticeLoader,WaveLoader,Pop,Icon,ICONS} from '../components/bits.jsx';
import {CH,rt,emit,saveChat,setNodes,useChat,capsNow,readyNodes,short,IMGS,newId,idbPut,MODES} from '../chat/store.js';
import {shrink} from '../chat/ctx.js';
import {nodeModel} from '../chat/strength.js';
import {loadTools,loadMsgImages,ctxState,groupOk,activeTools,setMode,setPerm,sendMessage,queueMessage,unqueue,stop,regen,clearChat,planAccept,planDecline,planRevise,planMsg,
  swState,SLASH,workspaceFiles,syncScheduled,cancelSchedule,dismissBtw} from '../chat/engine.js';
import '../chat.css';
const PHASE={planning:'Planning…',running:'Working…',synthesizing:'Writing the answer…',done:'Done',failed:'Failed',stopped:'Stopped'};
const LABEL={queued:'Waiting…',running:'Working…',done:'Done',error:'Failed',skipped:'Skipped',stopped:'Stopped'};
const PLACEHOLDER={dev:'Message Calcium…',ask:'Ask about the files in your workspace…',plan:'Describe what you want planned…',orchestra:'Describe a job to split across your nodes…',leader:'Describe a job for the leader to plan…',software:'Describe the software to build…'};
const MODE_INFO={dev:['🛠','Dev','Chat with tools'],ask:['❓','Ask','Answer questions about your files, read-only'],plan:['🧭','Plan','Research and propose a plan first'],orchestra:['🎼','Orchestra','Split a job across nodes in parallel'],leader:['👑','Leader','Strongest model plans, others work by difficulty'],software:['💻','Software','Build alone on a time budget']};
const SUGGEST=['Summarise the files in my workspace','Write a script that renames photos by date taken','Explain how this cluster shares a model across nodes','Plan a simple week of dinners'];
const PERMS=[['manual','✋ Manual','Ask before every tool call'],['semi','🛡 Semi','Ask for writes and commands'],['uncontrolled','⚡ Uncontrolled','Never ask']];
export default function Chat(){
  const {nodes}=useNodes(4000);const {ver}=useChat();const {theme,setTheme}=useTheme();
  const [input,setInput]=useState(''),[imgs,setImgs]=useState([]),[drop,setDrop]=useState(false),[ws,setWs]=useState(false),[files,setFiles]=useState([]),[dock,setDock]=useState(''),[,tick]=useState(0);
  const [thinkingStyle,setThinkingStyle]=useState(()=>{try{const style=localStorage.getItem('lc_thinking_style');return style==='lattice'||style==='wave'?style:'classic'}catch{return 'classic'}});
  const end=useRef(),fileIn=useRef(),stick=useRef(true),ta=useRef();
  useEffect(()=>setNodes(nodes),[nodes]);
  useEffect(()=>{loadTools();loadMsgImages();syncScheduled();const t=setInterval(()=>{syncScheduled()},20000);return()=>clearInterval(t)},[]);
  useEffect(()=>{if(CH.mode!=='software')return;const t=setInterval(()=>tick(x=>x+1),1000);return()=>clearInterval(t)},[CH.mode]);
  useEffect(()=>{if(stick.current)end.current?.scrollIntoView({block:'end'})},[ver]);
  const busy=!!rt.chatAbort,ready=readyNodes(),models=[...new Set(ready.map(nodeModel))],caps=capsNow(),rs=caps.reasoning;
  const modelOptions=[{value:'',label:'Any ready node'},...(CH.model&&!models.includes(CH.model)?[{value:CH.model,label:CH.model,detail:'Not ready'}]:[]),...models.map(m=>({value:m,label:m.replace(/\.gguf$/i,'')}))];
  const eopts=rs?(rs.kind==='effort'?[['','Default'],...rs.levels.map(l=>[l,l[0].toUpperCase()+l.slice(1)])]:[['','Default'],['off','Off'],['on','On']]):[];
  const sw=swState(),useTools=!CH.dummy&&activeTools().length>0,ctx=ctxState();
  const msamp=()=>{CH.msamp=CH.msamp||{};if(CH.model)CH.msamp[CH.model]={temp:CH.temp,max:CH.max,effort:CH.effort||''}};
  const setModel=m=>{CH.model=m;CH.effort='';const s=m&&CH.msamp?.[m];if(s){CH.temp=s.temp;CH.max=s.max;CH.effort=s.effort||''}saveChat();emit()};
  const setField=(k,v)=>{CH[k]=v;msamp();saveChat();emit()};
  const setThinkingStylePref=value=>{setThinkingStyle(value);try{localStorage.setItem('lc_thinking_style',value)}catch{}};
  const addFiles=async fs=>{try{const ok=[...fs].filter(f=>f.type.startsWith('image/')).slice(0,6-imgs.length);
    const added=await Promise.all(ok.map(async f=>{const id=newId('img');const d=await shrink(f);await idbPut(id,d);return{id,name:f.name||'image'}}));setImgs(x=>[...x,...added])}catch(e){rt.err=e.message;emit()}};
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
  const onKey=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit(e.ctrlKey||e.metaKey)}};
  const onScroll=e=>{const el=e.currentTarget;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<120};
  const outs=new Map(CH.msgs.filter(m=>m.role==='tool').map(m=>[m.tool_call_id,m]));
  const pm=planMsg(),lastIdx=CH.msgs.length-1;
  const sched=(rt.scheduled||[]).filter(t=>['scheduled','running'].includes(t.status)).length;
  const agentsBusy=CH.agents.some(a=>['working','starting','queued','interrupted'].includes(a.status));
  const modelLabel=CH.dummy?'Dummy AI':CH.model?short(CH.model.replace(/\.gguf$/i,'').split('/').pop(),26):ready.length?'Auto':'No model';
  const mi=MODE_INFO[CH.mode]||MODE_INFO.dev;
  const toggle=k=>setDock(dock===k?'':k);
  return <div className={'chatpage'+(drop?' dropping':'')} onDragOver={e=>{if([...(e.dataTransfer?.types||[])].includes('Files')){e.preventDefault();setDrop(true)}}} onDragLeave={e=>{if(e.target===e.currentTarget)setDrop(false)}} onDrop={e=>{setDrop(false);if(e.dataTransfer?.files?.length){e.preventDefault();addFiles(e.dataTransfer.files)}}}>
    <header className="ctop">
      <TLink className="ib" to="/" aria-label="Back to cluster" title="Cluster"><Icon d={ICONS.back}/></TLink>
      <span className="brand"><ShinyText on={busy}>Calcium</ShinyText></span><span className="grow"/>
      <Pop className="pill" label="Model" align="right" trigger={<><span className={'dot '+((ready.length||CH.dummy)?'ready':'')}/>{modelLabel}<Icon d={ICONS.chev} size={14}/></>}>{close=><div className="plist">
        <div className="plabel">Model</div>
        {CH.dummy?<div className="mut small pnote">Dummy AI is active. Turn it off in Settings to choose a real model.</div>:<>
          <GlideSelect label="Model" options={modelOptions} value={CH.model} onChange={m=>{setModel(m);close()}}/>
          {!models.length&&<div className="mut small pnote">No node is serving yet. Start a model from the cluster page.</div>}
          <div className="plabel">Send to</div>
          <select value={ready.some(n=>n.name===CH.route)?CH.route:''} onChange={e=>{CH.route=e.target.value;saveChat();emit()}}><option value="">Auto (load-balanced)</option>{ready.map(n=><option key={n.id} value={n.name}>{n.name}</option>)}</select>
        </>}</div>}</Pop>
      <Pop className="ibwrap" label="Settings" align="right" trigger={<Icon d={ICONS.sliders}/>}>{close=><div className="pset">
        <div className="plabel">Test mode</div>
        <label className="dummy-option"><input type="checkbox" checked={!!CH.dummy} onChange={e=>setField('dummy',e.target.checked)}/><span><b>Use dummy AI model</b><span className="mut small">Simulates chat replies locally; no model server is needed.</span></span></label>
        <div className="plabel">Appearance</div>
        <div className="seg2">{THEMES.map(t=><button key={t.id} className={theme===t.id?'on':''} onClick={()=>setTheme(t.id)}>{t.label}</button>)}</div>
        <label>Thinking animation<select value={thinkingStyle} onChange={e=>setThinkingStylePref(e.target.value)}><option value="classic">Default</option><option value="lattice">Lattice loader</option><option value="wave">Wave animation</option></select></label>
        <div className="think-preview" aria-live="polite">{thinkingStyle==='lattice'?<><LatticeLoader on/><span>Thinking…</span></>:thinkingStyle==='wave'?<><WaveLoader on/><ShinyText>Thinking…</ShinyText></>:<><StatusMark state="run" size={14}/><ShinyText>Thinking…</ShinyText></>}</div>
        <div className="plabel">Generation</div>
        <div className="col2"><label>Temperature<input type="number" step="0.1" min="0" max="2" value={CH.temp} onChange={e=>setField('temp',e.target.value===''?0.7:+e.target.value)}/></label>
          <label>Max tokens<input type="number" min="1" placeholder="no limit" value={CH.max} onChange={e=>setField('max',e.target.value===''?'':+e.target.value)}/></label></div>
        {rs&&<label>{rs.kind==='effort'?'Reasoning effort':'Thinking'}<select value={eopts.some(o=>o[0]===CH.effort)?CH.effort:''} onChange={e=>setField('effort',e.target.value)}>{eopts.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>}
        <div className="plabel">Tools</div>
        <div className="seg2">{PERMS.map(([v,l,t])=><button key={v} title={t} disabled={!useTools} className={CH.perm===v?'on':''} onClick={()=>setPerm(v)}>{l}</button>)}</div>
        <div className="mut small">{CH.dummy?'Tools are disabled while using Dummy AI.':useTools?`${activeTools().length} tools available in this mode`:!rt.toolinfo?'Tools unavailable — update controller.py':'No tools enabled'}</div>
        <div className="prow"><button onClick={()=>{close();setWs(true)}}><Icon d={ICONS.folder} size={15}/> Workspace</button><button className="danger" onClick={()=>{close();clearChat()}}><Icon d={ICONS.trash} size={15}/> Clear chat</button></div></div>}</Pop>
    </header>
    <Workspace open={ws} onClose={()=>setWs(false)}/>
    <div className="log" onScroll={onScroll}><div className="col">
      {!CH.msgs.length&&<div className="empty"><h2><BlurText text="How can I help?"/></h2>
        {CH.dummy?<><p className="mut">Dummy AI is enabled. Replies are simulated locally, so you can test the chat without a model node.</p>
          <div className="suggest">{SUGGEST.map((t,i)=><button key={t} style={{'--i':i}} onClick={()=>{setInput(t);ta.current?.focus()}}>{t}</button>)}</div></>:ready.length?<><p className="mut">{`${ready.length} node${ready.length>1?'s':''} ready`}</p>
          <div className="suggest">{SUGGEST.map((t,i)=><button key={t} style={{'--i':i}} onClick={()=>{setInput(t);ta.current?.focus()}}>{t}</button>)}</div></>
          :<p className="mut">No node is serving yet. <Link to="/">Start a model on the cluster page</Link> to begin.</p>}</div>}
      {CH.msgs.map((m,i)=>{
        if(m.role==='tool')return null;
        if(m.role==='compact')return <details key={i} className="note"><summary>📦 Earlier messages summarised{m.auto?' (automatic)':''}</summary><pre className="tcb">{m.content}</pre></details>;
        if(m.role==='orchestra')return <Orch key={i} m={m}/>;
        if(m.local)return <div key={i} className="note">{m.content}</div>;
        if(m.role==='user'&&m.auto)return <div key={i} className="note">↻ {m.label||short(m.content,80)}</div>;
        const last=i===lastIdx,live=!!m.streaming;
        return <div key={i} className={'msg '+m.role+(m.agentName?' agentmsg agent-'+m.agentName.toLowerCase():'')+(last?' fresh':'')+(live&&m.content?' streaming':'')}>
          {m.agentName&&<div className="who"><b>{m.agentName}</b>{m.node?<span className="mut"> · {m.node}</span>:null}</div>}
          {m.images?.length>0&&<div className="imgs">{m.images.map(x=>IMGS[x.id]?<img key={x.id} src={IMGS[x.id]} alt={x.name}/>:<span key={x.id} className="mut small">🖼 {x.name} — image no longer stored</span>)}</div>}
          {m.reasoning?<ThoughtLine text={m.reasoning} live={live&&!m.content&&!m.tool_calls} style={thinkingStyle}/>:live&&!m.content&&!m.tool_calls?<ThoughtLine text="" live style={thinkingStyle}/>:null}
          {(m.tool_calls||[]).length>0&&<div className="tcs">{m.tool_calls.map(c=><ToolChip key={c.id} c={c} out={outs.get(c.id)} running={busy&&(last||i>=CH.msgs.length-2)&&!outs.get(c.id)}/>)}</div>}
          {m.content?(m.role==='assistant'?<div className="body"><Markdown text={m.content}/></div>:<div className="body">{m.content}</div>):null}
          {m.error&&<p className="err small">{m.error}</p>}{m.stopped&&<p className="mut small">Stopped</p>}
          {m.plan==='pending'&&!busy&&last&&<PlanBar/>}
          {m.role==='assistant'&&!live&&!m.agentName&&m.content&&<div className="acts">
            <button className="ib sm" title="Copy" aria-label="Copy" onClick={()=>navigator.clipboard?.writeText(m.content||'')}><Icon d={ICONS.copy} size={15}/></button>
            {last&&!busy&&!m.tool_calls&&<button className="ib sm" title="Regenerate" aria-label="Regenerate" onClick={regen}><Icon d={ICONS.redo} size={15}/></button>}
            {(m.node||m.tps)&&<span className="mut small">{m.node}{m.tps?` · ${m.tps.toFixed(1)} tok/s`:''}</span>}</div>}
        </div>})}
      {rt.err&&<p className="err">{rt.err}</p>}<div ref={end}/></div></div>
    <footer className="cfoot"><div className="cin">
      {CH.btw.length>0&&<div className="btwbox">{CH.btw.map(b=><div key={b.id} className="btw"><div className="small mut">/btw {b.q}</div><div className={'small'+(b.state==='err'?' err':'')}>{b.state==='run'?<ShinyText>Thinking…</ShinyText>:b.a}</div><button className="ghost small" onClick={()=>dismissBtw(b.id)}>Dismiss</button></div>)}</div>}
      {rt.ask&&<AskBox ask={rt.ask}/>}
      {(CH.agents.length>0||CH.tasks.length>0||CH.queue.length>0||sched>0)&&<div className="dockbar">
        {CH.agents.length>0&&<button className={'dpill'+(dock==='agents'?' on':'')} onClick={()=>toggle('agents')}><StatusMark state={agentsBusy?'run':'idle'} size={13}/>Agents {CH.agents.length}</button>}
        {CH.tasks.length>0&&<button className={'dpill'+(dock==='tasks'?' on':'')} onClick={()=>toggle('tasks')}>☑ {CH.tasks.filter(t=>t.status==='done').length}/{CH.tasks.length}</button>}
        {CH.queue.length>0&&<button className={'dpill'+(dock==='queue'?' on':'')} onClick={()=>toggle('queue')}>Queue {CH.queue.length}</button>}
        {sched>0&&<button className={'dpill'+(dock==='sched'?' on':'')} onClick={()=>toggle('sched')}>⏰ {sched}</button>}</div>}
      {dock==='agents'&&CH.agents.length>0&&<div className="dockpanel"><Agents/></div>}
      {dock==='tasks'&&CH.tasks.length>0&&<div className="dockpanel">
        {CH.tasks.map(t=><div key={t.id} className={'tk '+t.status}><button className="ghost" title="Change status" onClick={()=>{t.status={todo:'doing',doing:'done',done:'todo'}[t.status];saveChat();emit()}}>{{todo:'○',doing:'◐',done:'✓'}[t.status]}</button><span className="grow">{t.title}</span><button className="ghost" aria-label="Remove task" onClick={()=>{CH.tasks=CH.tasks.filter(x=>x!==t);saveChat();emit()}}>×</button></div>)}
        <div className="row"><button className="ghost small" onClick={()=>{CH.tasks=CH.tasks.filter(t=>t.status!=='done');saveChat();emit()}}>Clear done</button><button className="ghost small" onClick={()=>{CH.tasks=[];saveChat();emit()}}>Clear all</button></div></div>}
      {dock==='queue'&&CH.queue.length>0&&<div className="dockpanel"><div className="mut small">Ctrl+Enter adds a message to the queue</div>{CH.queue.map((q,i)=><div key={i} className="row"><span className="grow small">{short(q.text||'Image attachment',100)}{q.images?.length?` · ${q.images.length} image${q.images.length===1?'':'s'}`:''}</span><button className="ghost small" onClick={()=>unqueue(i)}>×</button></div>)}</div>}
      {dock==='sched'&&sched>0&&<div className="dockpanel">{(rt.scheduled||[]).slice(-30).reverse().map(t=><div key={t.id} className="tk"><span className="grow small"><b>{t.status}</b> · {new Date(t.due_at*1000).toLocaleString()} · {t.prompt}{t.result&&<div className="mut">{short(t.result,400)}</div>}{t.error&&<div className="err">{t.error}</div>}</span>
        {['scheduled','running'].includes(t.status)&&<button className="ghost" onClick={()=>cancelSchedule(t.id)}>Cancel</button>}</div>)}</div>}
      {(cmds.length>0||files.length>0)&&<div className="slash">{cmds.map(c=><button key={c[0]} onClick={()=>{setInput(c[0]+' ');ta.current?.focus()}}><b>{c[0]}</b> <span className="mut">{c[1]}</span></button>)}{files.map(([c,p])=><button key={p} onClick={()=>{setInput(`/${c.toLowerCase()} ${p} `);ta.current?.focus()}}><b>{p}</b> <span className="mut">file</span></button>)}</div>}
      <div className="cbox">
        {imgs.length>0&&<div className="imgs thumbs">{imgs.map(x=><span key={x.id}>{IMGS[x.id]&&<img src={IMGS[x.id]} alt=""/>}<button onClick={()=>setImgs(imgs.filter(y=>y.id!==x.id))} aria-label="Remove image">×</button></span>)}{CH.dummy?<span className="mut small">Dummy AI records image attachments but does not analyze them.</span>:!caps.vision&&<span className="mut small">The selected model can’t read images.</span>}</div>}
        <textarea ref={ta} rows={1} value={input} placeholder={PLACEHOLDER[CH.mode]} onChange={e=>setInput(e.target.value)} onKeyDown={onKey} onPaste={e=>{const f=[...(e.clipboardData?.files||[])].filter(x=>/^image\//.test(x.type));if(f.length){e.preventDefault();addFiles(f)}}}/>
        <div className="crow">
          <button className="ib" title={CH.dummy?'Attach an image for testing; Dummy AI will not analyze it':caps.vision?'Attach an image':'Attach (needs a vision model to send)'} aria-label="Attach image" onClick={()=>fileIn.current.click()}><Icon d={ICONS.clip}/></button><input ref={fileIn} type="file" accept="image/*" multiple hidden onChange={e=>{addFiles(e.target.files);e.target.value=''}}/>
          <Pop className="pill sm" up label="Mode" trigger={<>{mi[0]} {mi[1]}<Icon d={ICONS.chev} size={13}/></>}>{close=><div className="plist">{Object.entries(MODE_INFO).map(([k,[ic,n,d]])=><button key={k} className={'pitem tall'+(CH.mode===k?' sel':'')} onClick={()=>{setMode(k);close()}}><span className="mic">{ic}</span><span className="grow"><b>{n}</b><span className="mut small"> {d}</span></span>{CH.mode===k&&<Icon d={ICONS.check} size={14}/>}</button>)}</div>}</Pop>
          {CH.mode==='leader'&&<select className="mini" value={ready.some(n=>n.name===CH.leader)?CH.leader:''} onChange={e=>{CH.leader=e.target.value;saveChat();emit()}} aria-label="Leader node"><option value="">👑 Auto</option>{ready.map(n=><option key={n.id} value={n.name}>👑 {n.name}</option>)}</select>}
          {CH.mode==='software'&&<label className="mini mut">⏱<input type="number" min="0.1" max="720" disabled={sw.running||sw.going} value={CH.swMin} onChange={e=>{CH.swMin=+e.target.value||30;saveChat();emit()}}/>min</label>}
          <span className="grow"/>{sw.label&&<span className="mut small swl">{sw.label}</span>}
          <ContextRing s={ctx}/>
          {busy&&!input.trim()&&!imgs.length?<button key="stop" className="sendbtn" onClick={stop} aria-label="Stop" title="Stop"><Icon d={ICONS.stop} size={16} fill/></button>:<button key="send" className="sendbtn" disabled={!input.trim()&&!imgs.length} onClick={()=>submit(false)} aria-label={busy?'Queue':'Send'} title={busy?'Queue message':'Send'}><Icon d={ICONS.send} size={18}/></button>}
        </div></div>
    </div></footer>
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
