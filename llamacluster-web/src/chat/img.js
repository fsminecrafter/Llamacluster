// Images live in IndexedDB ('lc_imgs', same store as the old UI); messages only hold {id,name}.
export const IMGS={};let db;
const open=()=>db||(db=new Promise(r=>{try{const q=indexedDB.open('lc_imgs',1);q.onupgradeneeded=()=>q.result.createObjectStore('i');q.onsuccess=()=>r(q.result);q.onerror=()=>r(null)}catch{r(null)}}));
export async function put(id,v){IMGS[id]=v;const d=await open();if(d)try{d.transaction('i','readwrite').objectStore('i').put(v,id)}catch{}}
export async function get(id){if(IMGS[id])return IMGS[id];const d=await open();if(!d)return null;
  return new Promise(r=>{try{const q=d.transaction('i').objectStore('i').get(id);q.onsuccess=()=>{if(q.result)IMGS[id]=q.result;r(q.result||null)};q.onerror=()=>r(null)}catch{r(null)}})}
export const newId=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
export const idbPut=put,idbGet=get;
export async function idbClear(){for(const k of Object.keys(IMGS))delete IMGS[k];const d=await open();if(d)try{d.transaction('i','readwrite').objectStore('i').clear()}catch{}}
