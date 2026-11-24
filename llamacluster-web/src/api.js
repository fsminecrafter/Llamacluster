// Same auth flow as the old ui.html: #token=... in the URL is stored, then hidden.
let token=(()=>{try{const m=/[#&]token=([^&]+)/.exec(location.hash);if(m){localStorage.setItem('lc_token',decodeURIComponent(m[1]));history.replaceState(null,'',location.pathname+location.search)}return localStorage.getItem('lc_token')||''}catch{return ''}})();
let noPromptUntil=0;
export const getToken=()=>token;
export const authHeaders=(extra={})=>({...extra,...(token?{Authorization:'Bearer '+token}:{})});
const headers=()=>authHeaders({'Content-Type':'application/json'});
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// true when a new token was entered (asks at most once a minute after a refusal)
export function askToken(){
  if(Date.now()<noPromptUntil)return false;
  const t=prompt('Access token (printed in the terminal where controller.py runs):');
  if(!t||!t.trim()){noPromptUntil=Date.now()+60000;return false}
  token=t.trim();try{localStorage.setItem('lc_token',token)}catch{}noPromptUntil=0;return true;
}
export async function api(path,method='GET',body,_retry){
  const r=await fetch(path,{method,headers:headers(),body:body?JSON.stringify(body):undefined});
  if(r.status===401){if(!_retry&&askToken())return api(path,method,body,true);throw new Error('Unauthorized — enter the access token')}
  const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error?.message||d.error||'HTTP '+r.status);return d;
}
// Download through fetch so the Authorization header is sent (a plain <a href> would not carry it).
export async function download(url,name){
  const r=await fetch(url,{headers:authHeaders()});
  if(r.status===401&&askToken())return download(url,name);
  if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error?.message||d.error||'HTTP '+r.status)}
  const u=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=u;a.download=name||'download';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),3000);
}
const strip=t=>(t||'').replace(/<think>[\s\S]*?<\/think>/g,'').trim();
// Plain streaming through the gateway (used by quick helpers). Chat itself uses managedChatStream below.
export async function* streamChat({messages,model,target,signal,temperature,max_tokens,tools,extra}){
  const h=headers();if(target)h['X-LlamaCluster-Target']=target;
  const r=await fetch('/v1/chat/completions',{method:'POST',headers:h,signal,body:JSON.stringify({model:model||undefined,messages,stream:true,temperature,max_tokens,...extra,...(tools?.length?{tools}:{})})});
  if(!r.ok||!r.body)throw new Error(r.status===401?'Unauthorized: open the controller link that includes #token=…':'HTTP '+r.status);
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
  for(;;){const {done,value}=await rd.read();if(done)return;buf+=dec.decode(value,{stream:true});const lines=buf.split('\n');buf=lines.pop();
    for(const l of lines){if(!l.startsWith('data:'))continue;const p=l.slice(5).trim();if(p==='[DONE]')return;
      try{const d=JSON.parse(p).choices?.[0]?.delta;if(d?.content)yield {content:d.content};if(d?.reasoning_content)yield {think:d.reasoning_content};if(d?.tool_calls)yield {tool:d.tool_calls}}catch{}}}
}
// Single-shot, non-streaming completion that goes straight through the gateway.
export async function complete({messages,model,target,signal,max_tokens,extra,temperature}){
  const h=headers();if(target)h['X-LlamaCluster-Target']=target;
  const r=await fetch('/v1/chat/completions',{method:'POST',headers:h,signal,body:JSON.stringify({model:model||undefined,messages,stream:false,max_tokens,temperature,...extra})});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error?.message||d.error||'HTTP '+r.status);
  return strip(d.choices?.[0]?.message?.content);
}
// Managed chat run (port of managedChatStream in ui.html): the controller owns the upstream request, the page polls
// /api/chat/runs/<id>?after=<cursor>. A dropped connection (phone sleeping, Wi-Fi hop) resumes instead of losing the reply.
// onLine receives raw SSE lines ("data: {...}"). Resolves to {node,runId}.
export async function managedChatStream(body,route,signal,onLine){
  const requestId=`web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`;
  const cancel=id=>fetch(`/api/chat/runs/${encodeURIComponent(id)}`,{method:'DELETE',headers:headers()}).catch(()=>{});
  const aborted=()=>new DOMException('Aborted','AbortError');
  let run;
  for(let attempt=0;!run;attempt++){
    if(signal?.aborted)throw aborted();
    try{
      const r=await fetch('/api/chat/runs',{method:'POST',headers:headers(),body:JSON.stringify({request_id:requestId,body,target:route||''}),signal});
      const d=await r.json().catch(()=>({}));
      if(r.status===401){askToken();throw new Error('Unauthorized — enter the access token, then retry')}
      if(!r.ok)throw new Error(d.error||`Could not start chat stream (HTTP ${r.status})`);
      run=d;
    }catch(e){
      if(e.name==='AbortError'||signal?.aborted)throw e;
      if(/^(Could not start chat stream|Unauthorized)/.test(e.message||''))throw e;
      await sleep(Math.min(5000,300*2**Math.min(attempt,4)));
    }
  }
  let cursor=0,node=run.node||'';
  for(let attempt=0;;){
    if(signal?.aborted){cancel(run.id);throw aborted()}
    let data;
    try{
      const r=await fetch(`/api/chat/runs/${encodeURIComponent(run.id)}?after=${cursor}&wait=15`,{headers:headers(),signal});
      if(r.status===401){askToken();throw new Error('Unauthorized — enter the access token, then retry')}
      if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||`Could not resume chat stream (HTTP ${r.status})`)}
      data=await r.json();attempt=0;
    }catch(e){
      if(e.name==='AbortError'||signal?.aborted){cancel(run.id);throw e}
      if(/^(Could not resume chat stream|Unauthorized)/.test(e.message||''))throw e;
      await sleep(Math.min(10000,500*2**Math.min(attempt++,4)));continue;
    }
    node=data.node||node;
    try{(data.lines||[]).forEach(onLine)}catch(e){cancel(run.id);throw e}
    cursor=data.next;
    if(data.error)throw new Error(data.error);
    if(data.done)return {node,runId:run.id};
  }
}
