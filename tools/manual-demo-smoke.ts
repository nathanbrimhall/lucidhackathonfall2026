import { chromium } from 'playwright';
import { createApplication } from '../server/src/app.config.js';
import { loadConfig } from '../server/src/config.js';
import { LiveKitService } from '../server/src/services/LiveKitService.js';
const config=loadConfig({PUBLIC_SERVER_URL:'http://localhost:2567',ALLOWED_ORIGINS:'http://localhost:2567',SESSION_SECRET:'fictional-session-secret-at-least-32-characters',DATABASE_URL:':memory:',GUEST_INVITE_CODE:'fictional-invite',OFFICE_ID:'manual-demo-smoke',OFFICE_LAYOUT:'prototype',LIVEKIT_INTERNAL_URL:'http://127.0.0.1:1',LIVEKIT_PUBLIC_URL:'ws://127.0.0.1:1',LIVEKIT_API_KEY:'testkey',LIVEKIT_API_SECRET:'fictional-livekit-secret-at-least-32-characters'});
let providerCalls=0;
const media=new LiveKitService(config,{backend:{issueToken:async()=> 'synthetic-media-token',removeParticipant:async()=>{},deleteRoom:async()=>{},verifyWebhook:async()=>{throw new Error('unused');}}});
const app=createApplication(config,{},media,{manualDemo:true,assistantEnv:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'fictional-key',AI_WORKER_SECRET:'s'.repeat(32),AI_USAGE_DATABASE:':memory:'},assistantRequest:async()=>{providerCalls++;throw new Error('No model request should occur in this check');}});
const base='http://127.0.0.1:'+await app.start(0,'127.0.0.1');config.allowedOrigins.push(base);let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.AI_BROWSER_EXECUTABLE??(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),args:process.env.OFFICE_TEST_OFFLINE?['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']:[]});
 const errors:string[]=[];
 for(const displayName of ['Demo Nathan','Demo Cameron','Demo Maya']){
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
  await page.getByRole('button',{name:'Use '+displayName,exact:true}).click();await page.getByText('Connected as '+displayName,{exact:true}).waitFor();
  await page.getByRole('button',{name:'Meeting notes',exact:true}).click();
  if(displayName==='Demo Maya')await page.getByText('No meeting notes available to you yet.',{exact:true}).waitFor();
  else {await page.getByText('Use audio only for this demo; defer video.',{exact:true}).waitFor();if(await page.getByRole('heading',{name:/^Meeting draft -/}).count()!==2)throw new Error('Expected two fictional notes');}
  await page.getByRole('button',{name:'Tasks',exact:true}).click();if(await page.locator('[data-task-id]').count()!==4)throw new Error('Expected four seeded tasks');
  await page.getByRole('button',{name:'AI assistant',exact:true}).click();if(await page.getByLabel('AI action',{exact:true}).locator('option').count()!==8)throw new Error('Missing assistant actions');
  await page.getByLabel('Your question',{exact:true}).fill('What decisions and assumptions are recorded?');await page.getByRole('button',{name:'Daily brief',exact:true}).click();await page.getByRole('button',{name:'Meeting prep',exact:true}).click();await page.getByText(/Gemini local usage:/).waitFor();if(providerCalls)throw new Error('Typing or quick buttons caused a model request');
  await page.getByRole('button',{name:'Office',exact:true}).click();await page.getByText('Audio capture is off in this fictional-data demo. Use Meeting notes to inspect the seeded examples.',{exact:true}).waitFor();if(await page.getByRole('button',{name:'Request AI meeting notes',exact:true}).count())throw new Error('Fictional demo exposed capture controls');await context.close();
 }
 if(errors.length)throw new Error(errors.join('; '));console.log(JSON.stringify({manualDemoBrowser:'PASS',fictionalAccounts:3,privateNoteAccess:true,assistantActions:8,automaticModelCalls:providerCalls,liveApiCalls:0}));
}finally{await browser?.close();await app.stop();}
