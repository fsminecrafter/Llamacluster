import React,{useState} from 'react';import Dialog from './Dialog.jsx';import {api} from '../api.js';import ThisDevice from './ThisDevice.jsx';
export default function AddNode({open,onClose,refresh}){
  const [f,setF]=useState({name:'',kind:'',url:'',token:''});const [err,setErr]=useState('');const [found,setFound]=useState(null);
  const set=k=>e=>setF({...f,[k]:e.target.value});
  const scan=async()=>{setFound('scanning');try{setFound(await api('/api/discover','POST'))}catch(e){setErr(e.message);setFound(null)}};
  const add=async()=>{try{await api('/api/nodes','POST',f);setF({name:'',kind:'',url:'',token:''});setErr('');onClose();refresh()}catch(e){setErr(e.message)}};
  return <Dialog open={open} onClose={onClose} title="Add node">
    <ThisDevice onStarted={refresh}/>
    <p className="mut small sep">Or add a worker running on another computer:</p>
    <div className="col2"><label>Name (optional)<input value={f.name} onChange={set('name')}/></label>
      <label>Type<select value={f.kind} onChange={set('kind')}><option value="">auto</option><option value="lan">LAN</option><option value="modal">Modal</option><option value="colab">Colab</option><option value="cloud">Other cloud</option></select></label></div>
    <label>Worker URL<input value={f.url} onChange={set('url')} placeholder="http://192.168.1.20:7860"/></label>
    <label>Token<input type="password" value={f.token} onChange={set('token')} placeholder="worker --token value"/></label>
    <div className="row"><button onClick={scan} disabled={found==='scanning'}>Scan LAN</button>
      {found==='scanning'&&<span className="mut small">Scanning port 7860…</span>}
      {Array.isArray(found)&&(found.length?found.map(x=><button key={x.url} onClick={()=>setF({...f,url:x.url,name:x.name})}>{x.name} ({x.url.replace('http://','')})</button>):<span className="mut small">No workers found</span>)}</div>
    {err&&<p className="err small">{err}</p>}
    <div className="row end"><button onClick={onClose}>Cancel</button><button className="pri" onClick={add}>Add node</button></div>
  </Dialog>;
}
