// One streaming model call over the managed chat run. Used by the main chat loop, the agents and the workers.
import {managedChatStream} from '../api.js';
import {CH,capsFor} from './store.js';
export const validArgs=x=>{try{const v=JSON.parse(x||'{}');return v!==null&&typeof v==='object'}catch{return false}};
// the model's own chat template decides what these mean (off = as little thinking as possible)
export function addEffort(body,model,route,off){
  const rs=capsFor(model||'',route||'').reasoning,v=off?(rs?.kind==='toggle'?'off':'low'):CH.effort;if(!rs||!v)return;
  if(rs.kind==='effort'&&rs.levels.includes(v)){body.reasoning_effort=v;body.chat_template_kwargs={...body.chat_template_kwargs,reasoning_effort:v}}
  else if(rs.kind==='toggle'&&(v==='on'||v==='off'))body.chat_template_kwargs={...body.chat_template_kwargs,enable_thinking:v==='on'};
}
// Parses SSE lines into deltas. onDelta({content,reasoning,toolCalls,usage,tps}) is called for every chunk.
export function sseHandler(onDelta){
  const tcs=[];
  const fn=line=>{
    const t=line.trim();if(!t.startsWith('data:'))return;const p=t.slice(5).trim();if(!p||p==='[DONE]')return;
    let j;try{j=JSON.parse(p)}catch{return}
    if(j.error)throw new Error(j.error.message||JSON.stringify(j.error));
    const d=j.choices?.[0]?.delta||{};
    (d.tool_calls||[]).forEach(t=>{const k=t.index??0,c=tcs[k]=tcs[k]||{id:'',type:'function',function:{name:'',arguments:''}};
      if(t.id)c.id=t.id;if(t.function?.name)c.function.name=t.function.name;if(t.function?.arguments)c.function.arguments+=t.function.arguments});
    onDelta({content:d.content||'',reasoning:d.reasoning_content||'',hasTools:!!d.tool_calls,toolCalls:tcs,promptTokens:j.usage?.prompt_tokens||0,tps:j.timings?.predicted_per_second||0});
  };
  fn.calls=()=>{const c=tcs.filter(x=>x&&x.function.name);c.forEach((x,i)=>{if(!x.id)x.id='call_'+Date.now().toString(36)+i;if(!x.function.arguments)x.function.arguments='{}'});return c};
  return fn;
}
export async function llmCall({messages,tools,route,model,signal,json,max,think}){
  const body={stream:true,stream_options:{include_usage:true},messages,temperature:+CH.temp};
  if(tools?.length)body.tools=tools;if(model)body.model=model;if(max||CH.max)body.max_tokens=+(max||CH.max);
  if(json)body.response_format={type:'json_object'};
  addEffort(body,model,route,think===false);
  const out={content:'',reasoning:'',tool_calls:[],node:'',tps:0};let chunks=0,t0=null;
  const h=sseHandler(d=>{out.content+=d.content;out.reasoning+=d.reasoning;if(d.content||d.hasTools){chunks++;if(t0==null)t0=performance.now()}if(d.tps)out.tps=d.tps});
  const s=await managedChatStream(body,route,signal,h);
  out.node=s.node||'';out.tool_calls=h.calls();
  if(!out.tps&&t0&&chunks>1)out.tps=(chunks-1)/((performance.now()-t0)/1000);
  return out;
}
