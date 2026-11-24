// Model-strength heuristic shared with the old recommender (ui.html): size x quantisation quality; MoE = geometric mean of total and active size.
export const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const Q_QUAL={Q8_0:1,Q6_K:.995,Q6_K_L:.995,Q5_K_M:.985,Q5_K_L:.985,Q5_K_S:.98,Q5_1:.98,Q5_0:.975,Q4_K_M:.96,Q4_K_L:.962,Q4_K_S:.95,Q4_1:.95,Q4_0:.94,
 IQ4_XS:.945,IQ4_NL:.945,MXFP4:.95,Q3_K_XL:.92,Q3_K_L:.92,Q3_K_M:.9,Q3_K_S:.86,IQ3_M:.89,IQ3_S:.87,IQ3_XS:.85,IQ3_XXS:.82,
 Q2_K_L:.77,Q2_K:.75,IQ2_M:.72,IQ2_S:.68,IQ2_XS:.64,IQ2_XXS:.6,F16:1,BF16:1,F32:1};
const QUANT_RE=/(?:^|[-_.])((?:UD-)?(?:IQ\d_[A-Z]+|Q\d_K_[A-Z]+|Q\d_K|Q\d_[01]|MXFP4|BF16|F16|F32))(?=[-_.]|$)/i;
export function quantOf(path){const m=String(path).replace(/\.gguf$/i,'').match(QUANT_RE);return m?m[1].toUpperCase():'?'}
export function quantQual(q){q=q.replace(/^UD-/,'');if(Q_QUAL[q]!=null)return Q_QUAL[q];const b=+(q.match(/(\d)/)||[])[1];return {8:1,6:.995,5:.983,4:.955,3:.88,2:.72,1:.4}[b]||.9}
export function quantBits(q){if(/F32/.test(q))return 32;if(/F16/.test(q))return 16;const b=+(q.match(/(\d)/)||[])[1];return {8:8.5,6:6.6,5:5.6,4:4.8,3:3.9,2:3.0,1:2}[b]||5}
// parameter counts from a model name, in billions: {total, active}
export function parseParams(id){
  const s=String(id).toLowerCase();let total=null,active=null,m;
  if(/gpt-oss-120b/.test(s)){total=117;active=5.1}
  else if(/gpt-oss-20b/.test(s)){total=21;active=3.6}
  else if(m=s.match(/(\d+(?:\.\d+)?)b[-_ .]?a(\d+(?:\.\d+)?)b/)){total=+m[1];active=+m[2]}
  else if(m=s.match(/(\d+)x(\d+(?:\.\d+)?)b/)){total=+m[1]*+m[2]*0.82;active=+m[2]*1.85}
  else if(m=s.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/))total=+m[1];
  else if(m=s.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)m(?![a-z])/))total=+m[1]/1000;
  return {total,active};
}
export function capScore(P,q,created){
  let s=P.total*Math.sqrt(P.ratio)*Math.pow(q,3);
  if(created){const age=clamp((Date.now()-Date.parse(created))/3.15576e10,0,3);if(isFinite(age))s*=Math.pow(0.82,age)}
  return s;
}
export const nodeModel=n=>n.info?.server?.config?.model||'';
export function nodeStrength(n){
  const name=nodeModel(n),P=parseParams(name),q=quantOf(name);
  let total=P.total,ratio=P.active&&P.total?clamp(P.active/P.total,0.02,1):1;
  if(!total){const m=(n.info?.models||[]).find(x=>x.name===name);if(m)total=m.size_mb*8/(quantBits(q)*1000)}
  return capScore({total:total||1,ratio},quantQual(q));
}
