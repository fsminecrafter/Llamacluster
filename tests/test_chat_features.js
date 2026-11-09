// node tests/test_chat_features.js - compact snapshots and spawn slot selection extracted from ui.html
const fs=require('fs'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'..','ui.html'),'utf8');
const ok=(condition,message)=>{if(!condition)throw Error(message);console.log('ok  ',message)};
const identityStart=src.indexOf('const OLD_OPEN='),identityEnd=src.indexOf('const TOOL_DEFAULTS=',identityStart);
const prompts=new Function(src.slice(identityStart,identityEnd)+';return {DEFAULT_SYS,NEW_OPEN}')();
const defaultPromptStart=src.indexOf('function agentDefaultPrompt('),defaultPromptEnd=src.indexOf('function migrateAgentIdentityPrompts(',defaultPromptStart);
const agentDefaultPrompt=new Function('DEFAULT_SYS',src.slice(defaultPromptStart,defaultPromptEnd)+';return agentDefaultPrompt')(prompts.DEFAULT_SYS);
const identities={Calcium:'he/him',Hydrogen:'she/her',Indium:'he/him',Sulfur:'she/her'};
ok(prompts.NEW_OPEN.includes('Gender identity: he')&&prompts.NEW_OPEN.includes('he/him'),'adds Calcium’s he/him identity to the primary system prompt');
ok(Object.entries(identities).every(([name,pronouns])=>agentDefaultPrompt(name).includes(`Gender identity: ${pronouns.startsWith('she')?'she':'he'}. Use ${pronouns} pronouns.`)),
  'assigns each named agent the requested gender identity and pronouns in its system prompt');
const legacyIdentityPrompt=name=>prompts.DEFAULT_SYS.replace('Gender identity: he. Use he/him pronouns. ','').replace(/Calcium/g,name)+
  "\n\nYou are a live participant in Calcium's chat. Work on your assignment, use tell to communicate with the other agents, and call agent_done when you consider your work complete.";
const oldAgent={name:'Hydrogen',systemPrompt:legacyIdentityPrompt('Hydrogen')},customAgent={name:'Indium',systemPrompt:'custom prompt'};
let identitySaves=0;
const migrateAgentIdentityPrompts=new Function('CH','agentDefaultPrompt','saveChat','DEFAULT_SYS',
  src.slice(src.indexOf('function migrateAgentIdentityPrompts('),src.indexOf('function agentSystemText(',src.indexOf('function migrateAgentIdentityPrompts(')))+';return migrateAgentIdentityPrompts');
migrateAgentIdentityPrompts({agents:[oldAgent,customAgent]},agentDefaultPrompt,()=>identitySaves++,prompts.DEFAULT_SYS);
ok(oldAgent.systemPrompt===agentDefaultPrompt('Hydrogen')&&customAgent.systemPrompt==='custom prompt'&&identitySaves===1,
  'updates saved default agent prompts without replacing custom system prompts');
const iconStart=src.indexOf('function agentIcon('),iconEnd=src.indexOf('function renderBtw(',iconStart);
const agentIcon=new Function(src.slice(iconStart,iconEnd)+';return agentIcon')();
const agentIcons=['Hydrogen','Indium','Sulfur'].map(agentIcon);
ok(agentIcons.every((icon,i)=>icon.includes(`agent-icon ${['hydrogen','indium','sulfur'][i]}`))&&new Set(agentIcons).size===3&&
  ['hydrogenOrbit','indiumTurn','sulfurFlicker'].every(animation=>src.includes(`@keyframes ${animation}`)),
  'renders unique animated icons for Hydrogen, Indium, and Sulfur');
ok(src.includes('${agentIcon(agent.name)}<svg class="agent-ring')&&src.includes('@media(prefers-reduced-motion:reduce)'),
  'shows each agent icon alongside its separate context ring and respects reduced-motion settings');
const compactStart=src.indexOf('function scriptCompactSummary('),compactEnd=src.indexOf('async function compactChat(',compactStart);
if(compactStart<0||compactEnd<0)throw Error('script compact helper not found');
const scriptCompactSummary=new Function('msgs',src.slice(compactStart,compactEnd)+';return scriptCompactSummary(msgs)');
const summary=scriptCompactSummary([
  {role:'user',content:'earlier request'},
  {role:'assistant',content:'earlier answer'},
  {role:'assistant',tool_calls:[{function:{name:'read_file',arguments:'{"path":"old"}'}}]},
  {role:'user',content:'u'.repeat(450)},
  {role:'assistant',tool_calls:[{function:{name:'runweb',arguments:'{"path":"index.html"}'.repeat(30)}}]},
  {role:'assistant',content:'a'.repeat(450)}
]);
const lines=summary.split('\n');
ok(lines[0].startsWith('Last user: ')&&lines[0].slice(11).length===300,'keeps at most 300 chars from the latest user message');
ok(lines[1].startsWith('Last tool call: ')&&lines[1].slice(16).startsWith('runweb(')&&lines[1].slice(16).length<=300,'keeps at most 300 chars from the latest tool call');
ok(lines[2].startsWith('Last AI output: ')&&lines[2].slice(16).length<=300,'keeps at most 300 chars from the latest AI output');
ok(summary.length<=900,'keeps the complete script snapshot within 900 characters');
const btwStart=src.indexOf('function btwMessages('),btwEnd=src.indexOf('function dispatchBtw',btwStart);
if(btwStart<0||btwEnd<0)throw Error('btw history helper not found');
const btwMessages=new Function('apiMessages','question',src.slice(btwStart,btwEnd)+';return btwMessages(question)');
let history=btwMessages(()=>[{role:'system',content:'sys'},{role:'user',content:'active'},{role:'assistant',tool_calls:[{id:'pending'}]}],'side');
ok(!history.some(x=>x.tool_calls)&&history[history.length-1].content==='side','drops an incomplete tool call from side-question history');
history=btwMessages(()=>[{role:'system',content:'sys'},{role:'assistant',tool_calls:[{id:'done'}]},{role:'tool',tool_call_id:'done',content:'result'}],'side');
ok(history.some(x=>x.tool_calls)&&history.some(x=>x.role==='tool'),'keeps complete tool-call groups in side-question history');
const btwUiStart=src.indexOf('function renderBtw()'),btwUiEnd=src.indexOf('function updateLast()',btwUiStart);
if(btwUiStart<0||btwUiEnd<0)throw Error('btw UI helpers not found');
const btwUi=new Function('$','CH','esc','md','saveChat',src.slice(btwUiStart,btwUiEnd)+';return {renderBtw,cancelBtw,btwControllers}')(
  s=>s==='#cBtw'?btwBox:null,{btw:[{id:'side-1',question:'question',answer:'Thinking…'}]},x=>String(x),x=>String(x),()=>{saved++});
let saved=0,aborted=0;const btwBox={hidden:true,innerHTML:''};
btwUi.btwControllers.set('side-1',{abort(){aborted++}});
btwUi.renderBtw();
ok(!btwBox.hidden&&btwBox.innerHTML.includes("cancelBtw('side-1')"),'renders a cancel control on a BTW card');
btwUi.cancelBtw('side-1');
ok(aborted===1&&btwUi.btwControllers.size===0&&saved===1&&btwBox.hidden,'cancels the side request and dismisses its card without affecting chat state');
const slotsStart=src.indexOf('function spawnSlots(){'),slotsEnd=src.indexOf('// which tool groups',slotsStart);
if(slotsStart<0||slotsEnd<0)throw Error('spawn slot helper not found');
const spawnSlots=new Function('NODES',src.slice(slotsStart,slotsEnd)+';return spawnSlots()');
const available=spawnSlots([
  {name:'busy',gateway_inflight:2,info:{server:{state:'ready',inflight:2,config:{model:'model-a',parallel:2}}}},
  {name:'free',gateway_inflight:1,info:{server:{state:'ready',inflight:0,config:{model:'model-b',parallel:3}}}},
  {name:'offline',info:{server:{state:'stopped',config:{model:'model-c',parallel:4}}}}
]);
ok(available.length===2&&available.every(x=>x.node==='free'&&x.model==='model-b'),'selects only free slots from ready model nodes');
const agentSlotsStart=src.indexOf('function agentSpawnSlots(){'),agentSlotsEnd=src.indexOf('// which tool groups',agentSlotsStart);
const agentSlots=new Function('NODES','CH','agentRuns',src.slice(agentSlotsStart,agentSlotsEnd)+';return agentSpawnSlots()');
const reserved=agentSlots([
  {name:'node-a',gateway_inflight:1,info:{server:{state:'ready',inflight:1,config:{model:'model-a',parallel:1}}}},
  {name:'node-b',info:{server:{state:'ready',config:{model:'model-b',parallel:2}}}}
],{agents:[{id:'a',node:'node-a',status:'working'},{id:'b',node:'node-b',status:'starting'}]},new Map());
ok(reserved.length===1&&reserved[0].node==='node-b','reserves running and starting agent slots when choosing a node');
const ctxStart=src.indexOf('const CTX_CAT='),ctxEnd=src.indexOf('function ctxState',ctxStart);
if(ctxStart<0||ctxEnd<0)throw Error('context gauge helpers not found');
const ctxCheck=new Function('msgs','defs','cap',src.slice(ctxStart,ctxEnd)+';const e=ctxEstimate(msgs,defs);return {e,segs:ctxSegments(e,1,cap),cats:CTX_CAT}');
const ctx=ctxCheck([{role:'system',content:'system'},{role:'assistant',tool_calls:[{id:'1',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',content:'o'.repeat(1000)}],[{function:{name:'read_file'}}],{tokens:10000});
ok(ctx.e.tools>0&&ctx.e.toolOthers>0&&ctx.e.toolOutputs>ctx.e.toolOthers,'counts tool definitions, calls and outputs separately');
ok(ctx.cats.some(x=>x[1]==='Tool'&&x[2]==='#ef4444')&&ctx.cats.some(x=>x[1]==='Tool others'&&x[2]==='#f97316')&&ctx.cats.some(x=>x[1]==='Tool outputs'&&x[2]==='#fb923c'),'uses the requested red-to-orange tool categories');
const activeStart=src.indexOf('function activeTools('),activeEnd=src.indexOf('function toolInfo(){',activeStart);
if(activeStart<0||activeEnd<0)throw Error('active tool helper not found');
const activeTools=new Function('TOOLINFO','groupOk','wsOpenPath','wsIsNew','spawnSlots','playwrightReady','CH','capsFor','chatImageRefs',src.slice(activeStart,activeEnd)+';return activeTools()');
const playwright={group:'playwright',function:{name:'playwright',description:'Use Playwright',parameters:{properties:{path:{type:'string'},timeout:{type:'integer'}},required:['path']}}};
const active=(tools,open='app/index.html',isNew=false,ready=()=>true,caps=()=>({vision:false}),images=()=>[])=>activeTools({tools},()=>true,open,isNew,()=>[],ready,{model:'',route:''},caps,images);
const selected=active([playwright]);
ok(selected.length===1&&!selected[0].function.parameters.properties.path&&!selected[0].function.parameters.required.includes('path')&&selected[0].function.description.includes('app/index.html'),'Playwright targets the open file without asking the model for a path');
ok(active([playwright],'app/index.html',true,()=>false).length===0&&active([playwright],'notes.md',false,()=>false).length===0,'hides Playwright for new or non-HTML files');
const viewImage={group:'view_image',function:{name:'view_image',description:'View image',parameters:{properties:{path:{type:'string'},attachment:{type:'integer',description:'attachment'}},required:[]}}};
const visionTools=active([viewImage],'',false,()=>false,()=>({vision:true}),()=>[{name:'diagram.png'}]);
ok(visionTools.length===1&&visionTools[0].function.parameters.properties.attachment.enum[0]===1&&visionTools[0].function.parameters.properties.attachment.description.includes('diagram.png'),'offers image attachments to a multimodal model');
ok(active([viewImage],'',false,()=>false,()=>({vision:false})).length===0,'hides view_image from text-only models');
const agentDefs=['spawn','tell','interrupt','status','despawn','agent_done'].map(name=>({
  group:name,optional:true,function:{name,description:name,parameters:{type:'object',properties:name==='spawn'?{model:{type:'string'},mode:{type:'string',enum:['agent','parallel','debate']}}:{target:{type:'string'},message:{type:'string'}},required:[]}}
}));
const agentToolsFn=new Function('TOOLINFO','groupOk','wsOpenPath','wsIsNew','spawnSlots','agentSpawnSlots','playwrightReady','CH','AGENT_NAMES','capsFor','chatImageRefs',
  src.slice(activeStart,activeEnd)+';return agent=>activeTools("model-a","",agent).map(t=>t.function)');
const toolsByAgent=agentToolsFn({tools:agentDefs},()=>true,'',false,()=>[{node:'node-b',model:'model-b'}],()=>[{node:'node-c',model:'model-c'}],()=>false,
  {mode:'dev',tools:{spawn:true,tell:true,interrupt:true,status:true,despawn:true,agent_done:true},agents:[{id:'h',name:'Hydrogen'},{id:'i',name:'Indium'}]},['Hydrogen','Indium','Sulfur'],()=>({vision:false}),()=>[]);
const calTools=toolsByAgent(null),hydrogenTools=toolsByAgent('h');
const spawnTool=calTools.find(t=>t.name==='spawn');
ok(spawnTool.parameters.properties.mode.enum.includes('agent')&&spawnTool.parameters.properties.mode.enum.includes('debate'),'offers persistent-agent and one-shot spawn modes when slots are available');
ok(calTools.find(t=>t.name==='interrupt').parameters.properties.target.enum[0]==='Hydrogen'&&hydrogenTools.find(t=>t.name==='tell').parameters.properties.target.enum.includes('Calcium')&&hydrogenTools.find(t=>t.name==='tell').parameters.properties.target.enum.includes('Indium')&&!hydrogenTools.find(t=>t.name==='tell').parameters.properties.target.enum.includes('Hydrogen'),'targets Calcium and peer agents without self-messaging');
ok(hydrogenTools.some(t=>t.name==='agent_done')&&!hydrogenTools.some(t=>t.name==='despawn'),'lets a live agent finish itself but not remove another agent');
const agentApiStart=src.indexOf('function agentApiMessages('),agentApiEnd=src.indexOf('function agentSeedMessages(',agentApiStart);
const toAgentApi=new Function('capsFor','IMGS',src.slice(agentApiStart,agentApiEnd)+';return agentApiMessages');
const multimodalHistory=toAgentApi(()=>({vision:true}),{img:'data:image/png;base64,abc'})({model:'vision-model',node:'node-a',messages:[{role:'tool',content:'image result',image:'img'}]});
ok(Array.isArray(multimodalHistory[0].content)&&multimodalHistory[0].content[1].type==='image_url','sends tool-viewed images into a spawned vision agent history');
const spawnLiveStart=src.indexOf('function spawnLiveAgent('),spawnLiveEnd=src.indexOf('async function messageLiveAgent(',spawnLiveStart);
const makeSpawnLive=new Function('CH','AGENT_NAMES','agentSpawnSlots','agentDefaultPrompt','agentSeedMessages','agentSystemText','saveChat','renderAgents','processLiveAgent',
  src.slice(spawnLiveStart,spawnLiveEnd)+';return spawnLiveAgent');
const roster={agents:[{id:'h',name:'Hydrogen'},{id:'i',name:'Indium'}]};
const spawnLive=makeSpawnLive(roster,['Hydrogen','Indium','Sulfur'],()=>[{node:'node-c',model:'model-c'}],name=>'prompt '+name,task=>[{role:'system',content:''},{role:'user',content:task}],()=> 'system',()=>{},()=>{},()=>{});
const thirdAgent=spawnLive('model-c','third assignment'),overLimit=spawnLive('model-c','fourth assignment');
ok(thirdAgent.ok&&thirdAgent.name==='Sulfur'&&roster.agents.length===3&&overLimit.error,'assigns Hydrogen, Indium, Sulfur and caps spawned agents at three plus Calcium');
const processStart=src.indexOf('async function processLiveAgent('),processEnd=src.indexOf('async function runAgentTool(',processStart);
const makeAgentProcess=new Function('CH','agentRuns','agentProcessing','renderAgents','TOOLINFO','loadTools','agentSystemText','compactAgentHistory','clamp','activeTools','llmCall','agentApiMessages','runTool','capTool','short','saveChat','finishLiveAgent',
  src.slice(processStart,processEnd)+';return processLiveAgent');
function runAgentLifecycle(responses,toolAction){
  const agent={id:'h',name:'Hydrogen',model:'model-a',node:'node-a',status:'starting',task:'test',last:'',systemPrompt:'prompt',messages:[{role:'system',content:''},{role:'user',content:'task'}],inbox:[],finishRequested:false};
  const CH={agents:[agent],steps:5},finished=[];let calls=0;
  const runs=new Map();
  const run=makeAgentProcess(CH,runs,new Set(),()=>{},{tools:[]},async()=>{},()=> 'system',()=>false,(x,min,max)=>Math.max(min,Math.min(max,x)),()=>[],
    async()=>responses[calls++],a=>a.messages,async(tc)=>toolAction?toolAction(agent,runs,tc):(agent.finishRequested=true,'done'),String,String,()=>{},
    (a,answer)=>{finished.push(answer);CH.agents=CH.agents.filter(x=>x!==a)});
  return run(agent.id).then(()=>({agent,CH,finished,calls}));
}
const agentLifecycleTests=Promise.all([
  runAgentLifecycle([{tool_calls:[{id:'done',function:{name:'agent_done',arguments:'{}'}}]},{content:'Finished assignment'}])
    .then(x=>ok(x.finished[0]==='Finished assignment'&&x.CH.agents.length===0&&x.calls===2,'agent_done keeps the agent through its final answer, then removes it')),
  runAgentLifecycle([{content:'I am ready for another message'}])
    .then(x=>ok(x.agent.status==='waiting'&&x.CH.agents.length===1,'a live agent remains available after replying')),
  runAgentLifecycle([{tool_calls:[
    {id:'one',function:{name:'tell',arguments:'{}'}},
    {id:'two',function:{name:'status',arguments:'{}'}}
  ]},{content:'Redirect received'}],(agent,runs)=>{agent.inbox.push({sender:'Calcium',text:'redirect'});runs.get(agent.id).abort();return 'first result'})
    .then(x=>ok(x.agent.messages.some(m=>m.role==='tool'&&m.tool_call_id==='two'&&m.content.includes('interrupted'))&&x.agent.status==='waiting',
      'interrupted multi-tool turns keep a result for every call before continuing'))
]);
const managedStart=src.indexOf('async function managedChatStream('),managedEnd=src.indexOf('async function streamOnce(',managedStart);
const makeManaged=new Function('fetch','TOKEN','askToken','sleep','DOMException',
  src.slice(managedStart,managedEnd)+';return managedChatStream');
const requests=[],received=[];let postAttempts=0,pollAttempts=0;
const mockFetch=async(url,options={})=>{
  requests.push({url,options});
  if(url==='/api/chat/runs'){
    if(postAttempts++===0)throw new TypeError('network disconnected after submit');
    return {ok:true,status:200,json:async()=>({id:'run-1',node:'node-a'})};
  }
  if(url.includes('?after=0')){
    if(pollAttempts++===0)throw new TypeError('temporary network failure');
    return {ok:true,status:200,json:async()=>({node:'node-a',lines:['data: one\\n','data: two\\n'],next:2,done:false})};
  }
  return {ok:true,status:200,json:async()=>({node:'node-a',lines:['data: [DONE]\\n'],next:3,done:true})};
};
const reconnectTest=makeManaged(mockFetch,'token',()=>{},async()=>{},class extends Error{});
const streamReconnectTest=reconnectTest({stream:true},'node-a',null,line=>received.push(line)).then(result=>{
  const posts=requests.filter(r=>r.url==='/api/chat/runs'),polls=requests.filter(r=>r.url.includes('/api/chat/runs/run-1?'));
  ok(posts.length===2&&JSON.parse(posts[0].options.body).request_id===JSON.parse(posts[1].options.body).request_id,
    'retries a possibly accepted stream-start request with the same idempotency key');
  ok(polls.length===3&&received.join('').includes('data: two')&&result.runId==='run-1',
    'reconnects to the buffered stream after a network error and resumes at its cursor');
});
const failedConsumerRequests=[];
const failedConsumerFetch=async(url,options={})=>{
  failedConsumerRequests.push({url,options});
  if(url==='/api/chat/runs')return {ok:true,status:200,json:async()=>({id:'run-2'})};
  if(options.method==='DELETE')return {ok:true,status:200,json:async()=>({ok:true})};
  return {ok:true,status:200,json:async()=>({lines:['data: bad\\n'],next:1,done:false})};
};
const failedConsumerTest=makeManaged(failedConsumerFetch,'token',()=>{},async()=>{},class extends Error{})
  ({stream:true},'node-a',null,()=>{throw new Error('consumer failed')})
  .then(()=>ok(false,'consumer errors reject the stream'),error=>{
    ok(error.message==='consumer failed'&&failedConsumerRequests.some(r=>r.options.method==='DELETE'),
      'cancels the controller run when stream processing fails');
  });
const scheduleStart=src.indexOf('function parseScheduleArg('),scheduleEnd=src.indexOf('async function runScheduleSlash(',scheduleStart);
const parseSchedule=new Function(src.slice(scheduleStart,scheduleEnd)+';return parseScheduleArg')();
const fixedNow=new Date(2026,10,9,8,0);
const scheduled=parseSchedule('09:00-11-28 check the report',fixedNow);
ok(new Date(scheduled.dueAt).getFullYear()===2026&&new Date(scheduled.dueAt).getMonth()===10&&new Date(scheduled.dueAt).getDate()===28&&scheduled.prompt==='check the report',
  'parses the combined time-month-day schedule syntax in local time');
const timeOnly=parseSchedule('09:00 remind me',new Date(2026,10,9,10,0));
ok(new Date(timeOnly.dueAt).getDate()===10&&timeOnly.prompt==='remind me',
  'schedules a time-only prompt for the next local occurrence');
const dateOnly=parseSchedule('11-10 review notes',fixedNow);
ok(new Date(dateOnly.dueAt).getHours()===9&&dateOnly.prompt==='review notes',
  'defaults date-only scheduled prompts to 09:00 local time');
const leapDay=parseSchedule('02-29 leap-day task',new Date(2026,0,1,8,0));
ok(new Date(leapDay.dueAt).getFullYear()===2028,'finds the next valid year for a yearless leap-day schedule');
const messageStart=src.indexOf('async function messageLiveAgent('),messageEnd=src.indexOf('function removeLiveAgent(',messageStart);
const liveMessage=new Function('CH','agentProcessing','agentRuns','processLiveAgent','saveChat','renderAgents',
  src.slice(messageStart,messageEnd)+';return messageLiveAgent');
let tellAborts=0,interruptAborts=0;
const live={id:'h',name:'Hydrogen',status:'working',inbox:[]},runs=new Map([['h',{abort(){tellAborts++}}]]);
const tell=liveMessage({agents:[live]},new Set(['h']),runs,()=>{},()=>{},()=>{});
tell(live,'keep going',false,'Calcium');
ok(tellAborts===0&&live.inbox.length===1,'tell queues a message without interrupting an active agent');
runs.set('h',{abort(){interruptAborts++}});
tell(live,'change direction',true,'Calcium');
ok(interruptAborts===1&&live.inbox.length===2,'interrupt aborts the active request and queues the redirect');
const calciumMessageStart=src.indexOf('function messageCalcium('),calciumMessageEnd=src.indexOf('function flushAgentMessages(',calciumMessageStart);
const toCalcium=new Function('CH','chatAbort','recordAgentMessage','setTimeout','chatSend','saveChat','renderChat',
  src.slice(calciumMessageStart,calciumMessageEnd)+';return messageCalcium');
let mainAborts=0,mainNotes=[];
const incoming=toCalcium({agentInterrupt:false,agentNotes:[]},{abort(){mainAborts++}},m=>mainNotes.push(m),()=>{},()=>{},()=>{},()=>{});
incoming('keep going','Hydrogen',false);
ok(mainAborts===0&&mainNotes[0].role==='user'&&mainNotes[0].content.includes('Hydrogen'),'agents can tell Calcium without interrupting its reply');
incoming('change direction','Indium',true);
ok(mainAborts===1,'an agent interrupt stops Calcium and sets the restart flag');
const queueStart=src.indexOf('function renderChatQueue(){'),queueEnd=src.indexOf('async function chatSend(',queueStart);
if(queueStart<0||queueEnd<0)throw Error('message queue helpers not found');
const exerciseQueue=new Function('$','CH','PEND','renderPend','grow','slashUi','saveChat','chatAbort','capsNow','chatSend','alert','esc','short',
  src.slice(queueStart,queueEnd)+`;queueChatMessage();const queuedWhileBusy=CH.queue.length===1&&CH.msgs.length===0;chatAbort=null;dispatchQueuedMessage();return {queuedWhileBusy,msg:CH.msgs[0],queue:CH.queue.length,pend:PEND};`);
const els={'#cIn':{value:'follow-up'},'#cQueue':{hidden:true,innerHTML:''}};
let sends=0;
const queued=exerciseQueue(s=>els[s]||{}, {queue:[],msgs:[]},[{id:'img-1'}],()=>{},()=>{},()=>{},()=>{}, {},()=>({vision:true}),()=>{sends++},()=>{},x=>String(x),x=>String(x).slice(0,100));
ok(queued.queuedWhileBusy&&queued.msg.content==='follow-up'&&queued.msg.images[0].id==='img-1'&&queued.queue===0&&sends===1&&queued.pend.length===0,
  'Ctrl+Enter queue helpers hold messages during a reply, then dispatch text and image attachments in order');
Promise.all([agentLifecycleTests,streamReconnectTest,failedConsumerTest]).then(()=>console.log('ALL PASSED')).catch(e=>{console.error(e);process.exitCode=1});
