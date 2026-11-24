import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';
const t=process.env.CONTROLLER||'http://127.0.0.1:7870';
export default defineConfig({plugins:[react()],worker:{format:'es'},server:{proxy:{'/api':t,'/v1':t}}});
