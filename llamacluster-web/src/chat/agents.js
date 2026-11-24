// Calcium's spawned agents (Hydrogen, Indium, Sulfur): persistent helper models that share this chat, plus the
// one-shot "parallel" and "debate" helpers. Port of the agent block in ui.html; state lives in CH.agents / rt.
import {CH,rt,emit,saveChat,clamp,short,AGENT_NAMES,DEFAULT_SYS,IMGS,readyNodes,capsFor} from './store.js';
import {ctxEstimate,ctxSegments,compactTranscript} from './ctx.js';
import {llmCall} from './llm.js';
import {activeTools,toolNotes,runTool,capTool,loadTools,loadMsgImages,chatImageRefs,runWorker,userContent} from './engine.js';

export const agentRuns=rt.agentRuns,agentProcessing=rt.agentProcessing;
const COMPACT_KEEP=new Set(['list_files','read_file','search_files','write_file','edit_file','delete_file','view_image','calculate','tell','interrupt','status','agent_done']);
const she=n=>n==='Hydrogen'||n==='Sulfur';

// ---- free slots: how many more requests each ready node can take right now
export function spawnSlots(){
  return readyNodes().flatMap(n=>{
    const s=n.info.server,cfg=s.config||{},slots=Math.max(1,+cfg.parallel||1),used=Math.max(+n.gateway_inflight||0,+s.inflight||0);
    return Array(Math.max(0,slots-used)).fill(0).map(()=>({node:n.name,model:cfg.model}));
  });
}
export function agentSpawnSlots(){   // also counts the nodes live agents are already using or have queued work on
  const pending=Object.create(null),running=Object.create(null);
  CH.agents.forEach(a=>{if(a.node){if(agentRuns.has(a.id))running[a.node]=(running[a.node]||0)+1;else if(['starting','working','interrupted','queued'].includes(a.status))pending[a.node]=(pending[a.node]||0)+1}});
  return readyNodes().flatMap(n=>{
    const s=n.info.server,cfg=s.config||{},slots=Math.max(1,+cfg.parallel||1),observed=Math.max(+n.gateway_inflight||0,+s.inflight||0);
    const used=Math.max(observed,running[n.name]||0)+(pending[n.name]||0);
    return Array(Math.max(0,slots-used)).fill(0).map(()=>({node:n.name,model:cfg.model}));
  });
}

// ---- prompts and per-agent context
export function agentDefaultPrompt(name){
  const identity=she(name)?'Gender identity: she. Use she/her pronouns.':'Gender identity: he. Use he/him pronouns.';
  const base=DEFAULT_SYS.replace(/Calcium/g,name).replace('Gender identity: he. Use he/him pronouns.',identity);
  return `${base}\n\nYou are a live participant in Calcium's chat. Work on your assignment, use enabled tell tools to communicate with the other agents, and call agent_done when you consider your work complete.`;
}
const compactAgentDefaultPrompt=name=>`You are ${name}, an XLABS AI helper in Calcium's shared chat. Use ${she(name)?'she/her':'he/him'} pronouns. You are a separately spawned model; your tools and abilities may differ from Calcium and other helpers. Vision means you can inspect images, not generate or edit them; do not claim image generation. Focus on your assignment, keep replies concise, use enabled tell/status/interrupt tools to coordinate, and call agent_done when finished.`;
export function agentCtxCapacity(agent){
  const node=rt.nodes.find(n=>n.name===agent.node),cfg=node?.info?.server?.config||{},par=Math.max(1,+cfg.parallel||1);
  return +cfg.ctx_size?{tokens:Math.floor(+cfg.ctx_size/par),name:agent.node,par,size:+cfg.ctx_size}:null;
}
export const agentUsesCompactMode=agent=>{const c=agentCtxCapacity(agent);return !!c&&c.tokens<8192};
export function agentToolDefs(agent){const d=activeTools(agent.model,agent.node,agent.id);return agentUsesCompactMode(agent)?d.filter(t=>COMPACT_KEEP.has(t.function.name)):d}
export function agentSystemText(agent){
  const compact=agentUsesCompactMode(agent),isDefault=!agent.systemPrompt||agent.systemPrompt===agentDefaultPrompt(agent.name);
  const prompt=compact&&isDefault?compactAgentDefaultPrompt(agent.name):agent.systemPrompt||agentDefaultPrompt(agent.name);
  const capNote=/vision does not mean it can generate or edit images|not generate or edit them/i.test(prompt)?'':"\n\nYou are a separate spawned helper model in Calcium's shared chat. Your tools and abilities may differ from Calcium and other helpers. Vision enables image inspection only, not image generation or editing.";
  return `${prompt}${capNote}${compact&&!isDefault?'\n\nCompact-context mode: keep replies concise.':''}${toolNotes(agent.model,agent.node,agent.id,compact)}`.replace(/\{\{date\}\}/g,new Date().toString()).replace(/\{\{workspace\}\}/g,rt.toolinfo?.workspace||'the workspace');
}
export function agentApiMessages(agent){
  const vision=capsFor(agent.model,agent.node).vision;
  return agent.messages.map(m=>{
    if(m.role==='user'&&m.agentName&&!m.images?.length)return {...m,content:`[${m.agentName}]: ${m.content||''}`};
    if(m.role==='user'&&m.images?.length)return {...m,content:userContent(m,vision)};
    if(m.role!=='tool'||!m.image)return m;
    if(vision&&IMGS[m.image])return {...m,content:[{type:'text',text:m.content},{type:'image_url',image_url:{url:IMGS[m.image]}}]};
    return {...m,content:(m.content||'')+'\n[image omitted: this model cannot inspect images or the image is not available]'};
  });
}
export const agentCtxState=agent=>({...ctxSegments(ctxEstimate(agentApiMessages(agent),agentToolDefs(agent)),1,agentCtxCapacity(agent))});
function compactAgentHistory(agent){
  const cap=agentCtxCapacity(agent),source=agent.messages;
  if(!cap||ctxEstimate(agentApiMessages(agent),agentToolDefs(agent)).total<cap.tokens*.88)return false;
  let cut=Math.max(2,source.length-12);while(cut<source.length&&source[cut]?.role!=='user')cut++;
  if(cut>=source.length){cut=Math.max(2,source.length-12);while(cut>1&&source[cut]?.role!=='user')cut--}
  if(cut<=1||cut>=source.length)return false;
  const budget=Math.min(6000,Math.max(1000,Math.floor(cap.tokens*1.5)));
  agent.messages=[source[0],{role:'user',content:`Earlier conversation summary:\n${compactTranscript(source.slice(1,cut),budget)}\n\nContinue with the recent messages below.`},...source.slice(cut)];
  saveChat();emit();return true;
}
function agentSeedMessages(task,compact=false){
  const history=CH.msgs.filter(m=>!m.local&&!m.streaming&&m.role!=='compact'&&m.role!=='orchestra');
  const context=compactTranscript(history.slice(compact?-8:-20),compact?2600:6500);
  const images=chatImageRefs().slice(0,compact?4:undefined).map((x,i)=>`${i+1}: ${x.name}`).join('\n');
  return [{role:'system',content:''},{role:'user',content:`You are joining this conversation as a live agent. Read the context and then work on your assignment.\n\n`+
    (CH.summary?`Earlier chat summary:\n${CH.summary}\n\n`:'')+`Recent chat:\n${context||'(no earlier messages)'}\n\n`+
    (images?`Available chat image attachments (use view_image with the number if useful):\n${images}\n\n`:'')+`Your assignment:\n${compact?short(task,2200):task}`}];
}

// ---- roster
export function spawnLiveAgent(model,task){
  task=String(task||'').trim().slice(0,8000);
  if(!task)return {error:'agent mode needs an initial assignment'};
  if(CH.agents.length>=AGENT_NAMES.length)return {error:'the chat already has the maximum of four agents including Calcium'};
  const name=AGENT_NAMES.find(n=>!CH.agents.some(a=>a.name===n));
  if(!name)return {error:'all named agent slots are occupied'};
  const slot=agentSpawnSlots().find(x=>x.model===model);
  if(!slot)return {error:'no ready free node is serving the selected model'};
  const agent={id:`agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,name,model,node:slot.node,status:'starting',task,last:'',
    systemPrompt:agentDefaultPrompt(name),messages:agentSeedMessages(task,agentUsesCompactMode({node:slot.node})),inbox:[],sharedUpdates:[],finishRequested:false};
  agent.messages[0].content=agentSystemText(agent);
  CH.agents.push(agent);saveChat();emit();processLiveAgent(agent.id);
  return {ok:true,name,model,node:slot.node,status:'starting'};
}
export async function messageLiveAgent(agent,text,interrupt=false,sender='Calcium'){
  text=String(text||'').trim().slice(0,8000);
  if(!text)return {error:'message cannot be empty'};
  if(!CH.agents.includes(agent))return {error:'that agent is no longer active'};
  if(agent.inbox.length>=20)return {error:`${agent.name}'s message queue is full`};
  const wasProcessing=agentProcessing.has(agent.id),didInterrupt=!!(interrupt&&agentRuns.has(agent.id)),source=String(sender||'Calcium').slice(0,40);
  agent.inbox.push({sender:source,text});
  recordAgentMessage({role:'user',agentName:source,content:`To ${agent.name}: ${text}`});
  queueSharedChatMessage({role:'user',agentName:source,content:text},agent.name);
  if(didInterrupt)agentRuns.get(agent.id)?.abort();
  if(!wasProcessing)processLiveAgent(agent.id);
  agent.status=agentProcessing.has(agent.id)?(didInterrupt?'interrupted':'working'):'queued';
  saveChat();emit();
  return {ok:true,target:agent.name,queued:wasProcessing&&!didInterrupt,interrupted:didInterrupt};
}
export function removeLiveAgent(agent,reason='removed by Calcium'){
  if(!CH.agents.includes(agent))return false;
  agentRuns.get(agent.id)?.abort();CH.agents=CH.agents.filter(a=>a!==agent);
  recordAgentMessage({role:'assistant',agentName:agent.name,content:`${agent.name} was ${reason}.`});saveChat();emit();return true;
}
function finishLiveAgent(agent,answer){
  if(!CH.agents.includes(agent))return;
  agentRuns.get(agent.id)?.abort();CH.agents=CH.agents.filter(a=>a!==agent);
  if(!answer&&!agent.last)recordAgentMessage({role:'assistant',agentName:agent.name,node:agent.node,content:'Assignment complete.'});
  saveChat();emit();
}
// while Calcium is mid-reply, agent messages wait in agentNotes so they don't land between a tool call and its result
export function recordAgentMessage(message){if(rt.chatAbort)CH.agentNotes.push(message);else CH.msgs.push(message);emit()}
export function messageCalcium(text,sender,interrupt=false){
  text=String(text||'').trim().slice(0,8000);
  if(!text)return {error:'message cannot be empty'};
  const wasBusy=!!rt.chatAbort;
  recordAgentMessage({role:'user',agentName:sender,content:`Message from ${sender}:\n${text}`});
  queueSharedChatMessage({role:'user',agentName:sender,content:text},sender);
  if(interrupt){if(wasBusy){CH.agentInterrupt=true;rt.chatAbort.abort()}else setTimeout(()=>{if(!rt.chatAbort)rt.hooks?.chatSend(true)},0)}
  saveChat();emit();
  return {ok:true,target:'Calcium',queued:wasBusy&&!interrupt,interrupted:wasBusy&&interrupt};
}
export function flushAgentMessages(){if(!CH.agentNotes.length)return;CH.msgs.push(...CH.agentNotes);CH.agentNotes=[];emit()}
export function queueSharedChatMessage(message,excludeName=''){
  const content=String(message.content||'').trim();if(!content)return;
  CH.agents.slice().forEach(agent=>{
    if(agent.name===excludeName||agent.name===message.agentName)return;
    if(agent.inbox.length>=20){agent.last='Inbox full; a shared chat update was skipped.';saveChat();emit();return}
    agent.inbox.push({sender:message.agentName||(message.role==='user'?'User':'Calcium'),text:content,...(message.images?.length?{images:message.images}:{})});
    if(!agentProcessing.has(agent.id))processLiveAgent(agent.id);
  });
}
const shareAgentReply=(message,excludeName)=>{CH.agents.filter(a=>a.name!==excludeName).forEach(a=>a.sharedUpdates.push({agentName:message.agentName,content:message.content}));saveChat();emit()};
export function abortAllAgents(){for(const c of agentRuns.values())c.abort()}
export function clearAgents(){abortAllAgents();CH.agents=[];CH.agentNotes=[];CH.agentInterrupt=false}

// ---- one agent's loop: each model call -> tool calls -> next call, until it replies without tools
export async function processLiveAgent(id){
  const agent=CH.agents.find(a=>a.id===id);
  if(!agent||agentProcessing.has(id))return;
  agentProcessing.add(id);agent.status='working';emit();
  let step=0;const limit=clamp(+CH.steps||10,1,40);
  try{
    if(!rt.toolinfo)await loadTools();
    if(!rt.toolinfo){agent.status='error';agent.last='Could not load tools from the controller; retry after reconnecting.';return}
    if(agent.messages.some(m=>m.image||m.images?.length))await loadMsgImages();
    while(CH.agents.includes(agent)&&step<limit){
      while(agent.sharedUpdates.length){const u=agent.sharedUpdates.shift();agent.messages.push({role:'user',agentName:u.agentName,content:u.content})}
      if(agent.inbox.length){const n=agent.inbox.shift();agent.messages.push({role:'user',content:`Message from ${n.sender}:\n${n.text}`,...(n.images?.length?{images:n.images}:{})});if(n.images?.length)await loadMsgImages()}
      agent.messages[0]={role:'system',content:agentSystemText(agent)};
      compactAgentHistory(agent);
      const ctl=new AbortController();agentRuns.set(id,ctl);let out;
      try{out=await llmCall({messages:agentApiMessages(agent),tools:agentToolDefs(agent),route:agent.node,model:agent.model,signal:ctl.signal})}
      catch(e){
        if(e.name==='AbortError'&&agent.inbox.length)continue;
        if(e.name==='AbortError'){agent.status='waiting';agent.last='Interrupted';break}
        agent.status='error';agent.last=e.message||String(e);break;
      }
      if(!CH.agents.includes(agent))return;
      agent.node=out.node||agent.node;
      if(out.tool_calls?.length){
        agent.messages.push({role:'assistant',content:out.content||'',tool_calls:out.tool_calls});
        for(let i=0;i<out.tool_calls.length;i++){
          const tc=out.tool_calls[i];if(!CH.agents.includes(agent))return;
          const result=await runTool(tc,{agentId:agent.id,model:agent.model,node:agent.node,route:agent.node});
          if(!CH.agents.includes(agent))return;
          agent.messages.push({role:'tool',tool_call_id:tc.id,name:tc.function.name,content:capTool(result),...(tc.web_image?{image:tc.web_image,image_name:tc.web_image_name||'tool image'}:{})});
          if(agentRuns.get(id)?.signal.aborted&&agent.inbox.length){
            for(const sk of out.tool_calls.slice(i+1))agent.messages.push({role:'tool',tool_call_id:sk.id,name:sk.function.name,content:JSON.stringify({error:'interrupted before this tool call ran'})});
            break;
          }
        }
        saveChat();emit();step++;continue;
      }
      const answer=(out.content||out.reasoning||'').trim();
      if(answer)agent.messages.push({role:'assistant',content:answer});
      agent.last=short(answer||'No text response',160);
      if(answer){const shared={role:'assistant',agentName:agent.name,node:agent.node,content:answer};recordAgentMessage(shared);shareAgentReply(shared,agent.name)}
      saveChat();emit();step++;
      if(agent.finishRequested){finishLiveAgent(agent,answer);return}
      if(agent.inbox.length)continue;
      agent.status='waiting';break;
    }
    if(CH.agents.includes(agent)&&step>=limit){agent.status='waiting';agent.last=`Paused after ${step} steps; send another message to continue.`}
  }catch(e){if(CH.agents.includes(agent)){agent.status='error';agent.last=e.message||String(e)}}
  finally{
    agentRuns.delete(id);agentProcessing.delete(id);
    if(CH.agents.includes(agent)){
      if(agent.status==='working'||agent.status==='starting')agent.status='waiting';
      saveChat();emit();if(agent.inbox.length)processLiveAgent(id);
    }
  }
}

// ---- the tools Calcium and the agents call: spawn / tell / interrupt / status / despawn / agent_done
export async function runAgentTool(name,args,context={}){
  if(name==='spawn')return spawnRun(args,context);
  const calcium=()=>({name:'Calcium',status:rt.chatAbort?'working':'waiting',model:CH.model,node:CH.route||null});
  const row=a=>({name:a.name,model:a.model,node:a.node,status:a.status,task:a.task,last:a.last,queued_messages:a.inbox.length});
  const active=CH.agents.find(a=>a.name===args.target);
  if(name==='status'){
    if(args.target==='Calcium')return JSON.stringify({agents:[calcium()]});
    if(!args.target&&context.agentId)return JSON.stringify({agents:[calcium(),...CH.agents.map(row)]});
    if(args.target&&!active)return JSON.stringify({error:'no active agent named '+args.target});
    return JSON.stringify({agents:(args.target?[active]:CH.agents).map(row)});
  }
  if(name==='agent_done'){
    const agent=CH.agents.find(a=>a.id===context.agentId);
    if(!agent)return JSON.stringify({error:'only a live agent can call agent_done'});
    agent.finishRequested=true;
    return JSON.stringify({ok:true,message:'You are marked as done. Give a concise final response, then your agent will leave the active roster.'});
  }
  const self=CH.agents.find(a=>a.id===context.agentId);
  if(context.agentId&&(name==='tell'||name==='interrupt')&&args.target==='Calcium')return JSON.stringify(messageCalcium(args.message,self?.name||'Agent',name==='interrupt'));
  if(!active)return JSON.stringify({error:'no active agent named '+String(args.target||'')});
  if(name==='tell'||name==='interrupt'){
    if(context.agentId&&active.id===context.agentId)return JSON.stringify({error:'send messages to another agent, not yourself'});
    return JSON.stringify(await messageLiveAgent(active,args.message,name==='interrupt',context.agentId?self?.name:'Calcium'));
  }
  if(name==='despawn'){
    if(context.agentId)return JSON.stringify({error:'agents cannot despawn other agents; use agent_done when you are finished'});
    removeLiveAgent(active,'despawned by Calcium');return JSON.stringify({ok:true,despawned:active.name});
  }
  return JSON.stringify({error:'unknown agent tool'});
}
async function spawnRun(args,context={}){
  if(args.mode==='agent')return JSON.stringify(spawnLiveAgent(String(args.model||''),args.task));
  const model=String(args.model||''),mode=args.mode==='debate'?'debate':'parallel',slots=spawnSlots().filter(x=>x.model===model);
  if(!model||!slots.length)return JSON.stringify({error:'no ready free node is serving the selected model; choose a model from the current spawn tool list'});
  const signal=(context.agentId?agentRuns.get(context.agentId)?.signal:null)||rt.chatAbort?.signal||new AbortController().signal,touch=()=>emit();
  if(mode==='parallel'){
    const prompts=(Array.isArray(args.tasks)?args.tasks:[]).map(x=>String(x||'').trim()).filter(Boolean).slice(0,4);
    if(!prompts.length)return JSON.stringify({error:'parallel mode needs one or more task prompts'});
    if(prompts.length>slots.length)return JSON.stringify({error:`${prompts.length} tasks requested but only ${slots.length} free slot(s) are available for ${model}`});
    const workers=await Promise.all(prompts.map(async(prompt,i)=>{const t={prompt,status:'queued',steps:[]};await runWorker(t,slots[i].node,signal,touch,model,{noSpawn:true});return {node:t.node,result:short(t.result||t.error||'',4000),steps:t.steps}}));
    return JSON.stringify({mode,model,workers});
  }
  const prompt=String(args.task||'').trim(),rounds=clamp(+args.rounds||2,1,3),count=clamp(+args.workers||Math.min(3,slots.length),2,4);
  if(!prompt)return JSON.stringify({error:'debate mode needs a shared task prompt'});
  if(slots.length<2)return JSON.stringify({error:'debate needs at least two free slots running the selected model'});
  if(count>slots.length)return JSON.stringify({error:`${count} debaters requested but only ${slots.length} free slot(s) are available for ${model}`});
  const workers=slots.slice(0,count).map((s,i)=>({node:s.node,id:i,steps:[],result:''}));let previous=[];
  for(let round=0;round<rounds;round++){
    await Promise.all(workers.map(async w=>{
      const earlier=previous.map(x=>`Debater ${x.id+1}:\n${x.result}`).join('\n\n');
      const t={prompt:prompt+(round?`\n\nRound ${round+1}: critique the previous round, including your own answer, and improve your conclusion using the full exchange:\n${earlier}`:'\n\nGive your initial independent answer.'),status:'queued',steps:[]};
      await runWorker(t,w.node,signal,touch,model,{noSpawn:true});w.result=short(t.result||t.error||'',3000);w.steps.push(...t.steps);
    }));
    previous=workers.map(w=>({id:w.id,result:w.result}));if(signal.aborted)break;
  }
  return JSON.stringify({mode,model,rounds:Math.min(rounds,previous.length?rounds:1),workers:workers.map(w=>({node:w.node,result:w.result,steps:w.steps}))});
}
