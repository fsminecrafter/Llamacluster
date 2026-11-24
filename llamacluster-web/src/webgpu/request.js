// Turns an OpenAI chat request from the gateway into one WebLLM accepts. Pure functions (tested in tests/test_webgpu_request.js).
// WebLLM is stricter than llama-server: system text must come first, only Hermes models take `tools` (and then not together
// with a system prompt), `max_tokens` must be positive, and non-vision models reject image parts.

const PASS=['temperature','top_p','max_tokens','stop','frequency_penalty','presence_penalty','seed','logit_bias','response_format'];

const textOf=c=>typeof c==='string'?c:Array.isArray(c)?c.map(p=>p?.type==='text'?p.text||'':'').filter(Boolean).join('\n'):c==null?'':String(c);
const hasImage=c=>Array.isArray(c)&&c.some(p=>p?.type==='image_url');

export function normalizeMessages(messages,{vision=false}={}){
  const system=[],rest=[];
  for(const m of messages||[]){
    if(!m)continue;
    if(m.role==='system'||m.role==='developer'){const t=textOf(m.content).trim();if(t)system.push(t);continue}
    if(m.role==='tool'){rest.push({role:'user',content:`[Result of tool ${m.name||m.tool_call_id||''}]\n${textOf(m.content)}`.trim()});continue}
    if(m.role==='assistant'){
      let t=textOf(m.content);
      if(m.tool_calls?.length)t=(t?t+'\n':'')+m.tool_calls.map(c=>`[Called tool ${c.function?.name||''} with ${c.function?.arguments||'{}'}]`).join('\n');
      rest.push({role:'assistant',content:t});continue;
    }
    // user
    if(vision&&hasImage(m.content)){
      rest.push({role:'user',content:m.content.map(p=>p.type==='image_url'?{type:'image_url',image_url:p.image_url}:{type:'text',text:p.text||''})});
    }else{
      let t=textOf(m.content);if(hasImage(m.content))t=(t?t+'\n':'')+'[image omitted: this model cannot read images]';
      rest.push({role:'user',content:t});
    }
  }
  const out=system.length?[{role:'system',content:system.join('\n\n')}]:[];
  return out.concat(rest);
}

export function buildRequest(body,{vision=false}={}){
  const req={messages:normalizeMessages(body?.messages,{vision}),stream:true,stream_options:{include_usage:true}};
  for(const k of PASS){const v=body?.[k];if(v!==undefined&&v!==null)req[k]=v}
  if(!(req.max_tokens>0))delete req.max_tokens;
  if(Array.isArray(req.stop)&&!req.stop.length)delete req.stop;
  if(req.response_format&&!['json_object','text','grammar','json_schema'].includes(req.response_format.type))delete req.response_format;
  return req;
}

// llama-server style stats the chat page already understands (timings.predicted_per_second) next to the OpenAI usage block.
export function withTimings(chunk){
  const e=chunk?.usage?.extra;
  if(e&&e.decode_tokens_per_s)return {...chunk,timings:{predicted_per_second:e.decode_tokens_per_s,prompt_per_second:e.prefill_tokens_per_s}};
  return chunk;
}

// Errors that mean the GPU/engine is unusable until the node is restarted (so it must stop taking requests).
export const isFatal=msg=>/device.{0,20}lost|lost.{0,20}device|gpu.{0,20}(crash|hang|reset)|out of memory|\boom\b|Instance.*dropped|createBuffer|mapAsync/i.test(String(msg||''));
