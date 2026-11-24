// Runs the WebLLM engine off the main thread so the page stays responsive while the GPU works.
import {WebWorkerMLCEngineHandler} from '@mlc-ai/web-llm';
const handler=new WebWorkerMLCEngineHandler();
self.onmessage=m=>handler.onmessage(m);
