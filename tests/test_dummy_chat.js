// node tests/test_dummy_chat.js - Dummy AI replies locally without a model node or network request.
const ok=(condition,message)=>{if(!condition)throw Error(message);console.log('ok  ',message)};

const storage={};
global.localStorage={getItem:()=>null,setItem:(key,value)=>{storage[key]=value}};
let requests=0,alerts=0;
global.fetch=async()=>{requests++;throw Error('Dummy chat must not make a network request')};
global.alert=()=>{alerts++};

(async()=>{
  const {CH,rt}=await import('../llamacluster-web/src/chat/store.js');
  const {sendMessage,queueMessage}=await import('../llamacluster-web/src/chat/engine.js');
  CH.dummy=true;CH.mode='dev';CH.msgs=[];CH.agents=[];rt.nodes=[];
  ok(await sendMessage('Hello from the test chat')===true,'accepts a chat message without ready model nodes');
  ok(queueMessage('',[{id:'test-image'}]),'accepts a queued image attachment without a vision model');
  const deadline=Date.now()+3000;
  while((rt.chatAbort||CH.queue.length)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  const replies=CH.msgs.filter(m=>m.role==='assistant'&&!m.local);
  ok(!rt.chatAbort,'finishes the local dummy reply');
  ok(replies[0]?.content.includes('Hello from the test chat')&&replies[0].content.includes('generated locally'),'echoes a visibly simulated response');
  ok(replies[1]?.content.includes('1 image received; not analyzed'),'simulates queued image messages without claiming to analyze them');
  ok(replies.every(reply=>reply.node==='Dummy AI'&&!reply.error),'labels responses as Dummy AI without errors');
  ok(JSON.parse(storage.lc_chat).dummy===true,'persists the Dummy AI setting');
  ok(alerts===0,'does not reject queued images without a vision model');
  ok(requests===0,'does not make a network request');
})().catch(error=>{console.error(error);process.exitCode=1});
