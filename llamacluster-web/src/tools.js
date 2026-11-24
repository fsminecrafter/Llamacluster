import {api} from './api.js';
// Contract taken from the original ui.html: GET /api/tools -> {tools:[{type,function,group,optional,default_on,title,blurb}],permissions};
// POST /api/tools/run {name,arguments,permission,approved?} -> {result:string, needs_approval?, reason?}.
export const listTools=()=>api('/api/tools').catch(()=>({tools:[]}));
export const runTool=(name,args,permission,approved)=>api('/api/tools/run','POST',{name,arguments:args,permission,...(approved?{approved:true}:{})});
export const MODE_GROUPS={plan:['search','fetch','read'],ask:['read','view_image']};
export const MODE_DENY={orchestra:['question'],leader:['question']};
export const DEFAULT_ON={search:true,fetch:true,read:true,write:true,exec:true};
export const AGENT_TOOLS=['spawn','tell','interrupt','status','despawn','agent_done','playwright'];   // handled by chat/agents.js and the Workspace editor
export function taskTool(st,a){   // st={tasks:[{id,title,status}],seq}; same rules as the original
  const act=String(a?.action||'').toLowerCase(),cl=x=>String(x??'').trim().slice(0,200);
  const S={todo:'todo',pending:'todo',open:'todo',doing:'doing',in_progress:'doing',started:'doing',done:'done',complete:'done',completed:'done',finished:'done'};
  const stat=x=>S[String(x||'').toLowerCase().replace(/[\s-]/g,'_')]||null;
  const ok=e=>({ok:true,...e,tasks:st.tasks.map(({id,title,status})=>({id,title,status})),open:st.tasks.filter(t=>t.status!=='done').length});
  if(act==='list')return ok({});
  if(act==='add'){const ts=[...(Array.isArray(a.titles)?a.titles:[]),...(a.title?[a.title]:[])].map(cl).filter(Boolean);
    if(!ts.length)return{error:'add needs a title (or titles)'};if(st.tasks.length+ts.length>50)return{error:'at most 50 tasks - remove finished ones first'};
    const s=a.status!=null?stat(a.status):'todo';if(!s)return{error:'status must be todo, doing or done'};
    return ok({added:ts.map(title=>{const t={id:++st.seq,title,status:s};st.tasks.push(t);return t.id})})}
  if(act==='set'){const t=st.tasks.find(x=>x.id===+a.id);if(!t)return{error:'no task with id '+a.id+' - use action "list" to see the ids'};
    if(a.status==null&&!a.title)return{error:'set needs a status and/or a new title'};
    if(a.status!=null){const s=stat(a.status);if(!s)return{error:'status must be todo, doing or done'};t.status=s}
    if(a.title)t.title=cl(a.title)||t.title;return ok({updated:t.id})}
  if(act==='remove'){const ids=[...(Array.isArray(a.ids)?a.ids:[]),...(a.id!=null?[a.id]:[])].map(Number);
    const gone=ids.filter(i=>st.tasks.some(t=>t.id===i));if(!gone.length)return{error:'no task with that id - use action "list" to see the ids'};
    st.tasks=st.tasks.filter(t=>!gone.includes(t.id));return ok({removed:gone})}
  return{error:'action must be add, set, remove or list'};
}
