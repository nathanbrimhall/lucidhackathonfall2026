import {createApplication} from '../server/src/app.config.js';import {loadConfig} from '../server/src/config.js';
const port=Number(process.env.DEMO_PORT??2568);const base=`http://localhost:${port}`;
const config=loadConfig({...process.env,PORT:String(port),PUBLIC_SERVER_URL:base,ALLOWED_ORIGINS:`${base},http://127.0.0.1:${port}`,DATABASE_URL:':memory:',OFFICE_ID:'fictional-manual-demo',OFFICE_LAYOUT:'prototype',AI_ENABLED:'false'});
const app=createApplication(config,{},undefined,{manualDemo:true});
await app.start(port,'127.0.0.1');console.log(`Fictional integrated demo: ${base}\nUse the demo account buttons. Notes and tasks reset when this process stops. No audio is captured; assistant requests use your configured Gemini key only when you click Ask.\nThe normal persistent office is separate.`);
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.stop();process.exitCode=0;};process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
