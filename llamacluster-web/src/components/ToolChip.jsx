import React from 'react';
import {CallChip} from './bits.jsx';
const VERB=n=>/write/.test(n)?['Writing','Wrote']:/edit/.test(n)?['Editing','Edited']:/read|view/.test(n)?['Reading','Read']:/exec|command|shell/.test(n)?['Running','Ran']:/search_files/.test(n)?['Searching files','Searched files']:/search/.test(n)?['Searching','Searched']:/fetch/.test(n)?['Fetching','Fetched']:/list/.test(n)?['Listing','Listed']:/delete|remove/.test(n)?['Deleting','Deleted']:/spawn/.test(n)?['Spawning','Spawned']:/tell|interrupt/.test(n)?['Messaging','Messaged']:/question/.test(n)?['Asking','Asked']:/task/.test(n)?['Updating tasks','Updated tasks']:[n,n];
const parse=a=>{try{return JSON.parse(a||'{}')}catch{return{}}};
// c = a tool call {id,function:{name,arguments}}, out = the matching role:'tool' message (undefined while it runs)
export default function ToolChip({c,out,running}){
  const name=c.function.name,a=parse(c.function.arguments),first=a.path||a.file||a.command||a.query||a.url||a.question||a.target||Object.values(a).find(v=>typeof v==='string')||'';
  const [run,done]=VERB(name),failed=!!out&&/^\s*\{\s*"error"/.test(out.content||''),state=!out?(running?'run':'err'):failed?'err':'ok';
  return <CallChip state={state} label={state==='run'?run+'…':done} detail={String(first).slice(0,90)}>
    <pre className="tcb">{a.content?a.content:c.function.arguments}{out?'\n\n'+out.content:''}</pre>{out?.image&&<span className="mut small">screenshot kept in this chat</span>}</CallChip>;
}
