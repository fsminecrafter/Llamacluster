import {useEffect,useState,useCallback} from 'react';import {api} from './api.js';
export function useNodes(ms=2000){
  const [nodes,setNodes]=useState([]);const [error,setError]=useState('');
  const refresh=useCallback(async()=>{try{const d=await api('/api/nodes');setNodes(Array.isArray(d)?d:d.nodes||[]);setError('')}catch(e){setError(e.message)}},[]);
  useEffect(()=>{refresh();const t=setInterval(refresh,ms);return()=>clearInterval(t)},[refresh,ms]);
  return {nodes,error,refresh};
}
