import { chromium } from 'playwright';
import { createApplication } from '../server/src/app.config.js';
import { loadConfig } from '../server/src/config.js';
import { LiveKitService } from '../server/src/services/LiveKitService.js';
const config=loadConfig({PUBLIC_SERVER_URL:'http://localhost:2567',ALLOWED_ORIGINS:'http://localhost:2567',SESSION_SECRET:'fictional-session-secret-at-least-32-characters',DATABASE_URL:':memory:',GUEST_INVITE_CODE:'fictional-invite',OFFICE_ID:'manual-demo-smoke',OFFICE_LAYOUT:'prototype',LIVEKIT_INTERNAL_URL:'http://127.0.0.1:1',LIVEKIT_PUBLIC_URL:'ws://127.0.0.1:1',LIVEKIT_API_KEY:'testkey',LIVEKIT_API_SECRET:'fictional-livekit-secret-at-least-32-characters'});
let providerCalls=0;
const checkedActions:string[]=[];
const request:typeof fetch=async(_url,init)=>{
 providerCalls++;
 const input=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
 const sources=input.sources as {id:string;type:string;text:string;section?:string;taskId?:string;userId?:string}[];
 const note=sources.find(s=>s.type==='saved_note'&&s.section==='decisions');
 const tasks=sources.filter(s=>s.type==='current_task').map(s=>({...JSON.parse(s.text),id:s.taskId,sourceId:s.id}));
 const blocker=tasks.find(t=>t.status==='open'&&t.ownerUserId!==input.requesterUserId&&t.title==='Export stable speaker IDs and timestamps');
 const blocked=tasks.find(t=>t.status==='open'&&t.ownerUserId===input.requesterUserId);
 const duplicate=tasks.find(t=>t.status==='proposed'&&t.ownerUserId===input.requesterUserId);
 const profile=sources.find(s=>s.type==='self_declared_skills'&&s.text.includes('LiveKit transcript exports'));
 const text='Verified browser result for '+input.feature;
 let item:Record<string,unknown>;
 switch(input.feature){
  case 'conversations':item={kind:'conversation',text,sourceIds:[note!.id]};break;
  case 'helpers':item={kind:'helper',text,sourceIds:[profile!.id],personUserId:profile!.userId};break;
  case 'dependencies':item={kind:'dependency',text,sourceIds:[blocked.sourceId,blocker.sourceId],blockedTaskId:blocked.id,blockerTaskId:blocker.id};break;
  case 'overlap':item={kind:'overlap',text,sourceIds:[duplicate.sourceId,blocker.sourceId],proposedTaskId:duplicate.id,existingTaskId:blocker.id};break;
  case 'decisions':case 'daily_brief':case 'catchup_brief':item={kind:'draft_decision',text,sourceIds:[note!.id]};break;
  case 'meeting_prep':item={kind:'agenda',text,sourceIds:[note!.id]};break;
  default:throw new Error('Unexpected assistant feature in browser test');
 }
 return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({status:'supported',items:[item]})}]}}],usageMetadata:{promptTokenCount:120,candidatesTokenCount:60,totalTokenCount:180}}));
};
const media=new LiveKitService(config,{backend:{issueToken:async()=> 'synthetic-media-token',removeParticipant:async()=>{},deleteRoom:async()=>{},verifyWebhook:async()=>{throw new Error('unused');}}});
const app=createApplication(config,{},media,{manualDemo:true,assistantEnv:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'fictional-key',AI_WORKER_SECRET:'s'.repeat(32),AI_USAGE_DATABASE:':memory:'},assistantRequest:request,assistantCooldown:0});
const base='http://127.0.0.1:'+await app.start(0,'127.0.0.1');config.allowedOrigins.push(base);let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.AI_BROWSER_EXECUTABLE??(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),args:process.env.OFFICE_TEST_OFFLINE?['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']:[]});
 const errors:string[]=[];
 for(const displayName of ['Demo Nathan','Demo Cameron','Demo Maya']){
  const context=await browser.newContext({serviceWorkers:'block'});
  if(process.env.OFFICE_TEST_OFFLINE)await context.route('**/*',route=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
  await page.getByRole('button',{name:'Use '+displayName,exact:true}).click();await page.getByText('Connected as '+displayName,{exact:true}).waitFor();
  await page.getByRole('button',{name:'Meeting notes',exact:true}).click();
  if(displayName==='Demo Maya')await page.getByText('No meeting notes available to you yet.',{exact:true}).waitFor();
  else {await page.getByText('Use audio only for this demo; defer video.',{exact:true}).waitFor();if(await page.getByRole('heading',{name:/^Meeting draft -/}).count()!==2)throw new Error('Expected two fictional notes');}
  await page.getByRole('button',{name:'Tasks',exact:true}).click();if(await page.locator('[data-task-id]').count()!==4)throw new Error('Expected four seeded tasks');
  await page.getByRole('button',{name:'AI assistant',exact:true}).click();if(await page.getByLabel('AI action',{exact:true}).locator('option').count()!==8)throw new Error('Missing assistant actions');
  const callsBeforeTyping=providerCalls;
  await page.getByLabel('Your question',{exact:true}).fill('What decisions and assumptions are recorded?');await page.getByRole('button',{name:'Daily brief',exact:true}).click();await page.getByRole('button',{name:'Meeting prep',exact:true}).click();await page.getByText(/Gemini local usage:/).waitFor();if(providerCalls!==callsBeforeTyping)throw new Error('Typing or quick buttons caused a model request');
  if(displayName==='Demo Nathan'){
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   await page.getByLabel('Time zone',{exact:true}).fill('America/Denver');
   await page.getByLabel('From local date',{exact:true}).fill(today);
   await page.getByLabel('Through local date',{exact:true}).fill(today);
   for(const feature of ['conversations','helpers','dependencies','overlap','decisions','daily_brief','catchup_brief','meeting_prep']){
    const before=providerCalls;
    await page.getByLabel('AI action',{exact:true}).selectOption(feature);
    await page.getByLabel('Your question',{exact:true}).fill('Check this feature using my readable notes and shared tasks.');
    const response=page.waitForResponse(r=>r.url()===base+'/api/assistant'&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
    if((await response).status()!==200)throw new Error('Assistant HTTP failure for '+feature);
    await page.getByText('Verified browser result for '+feature,{exact:true}).waitFor();
    if(await page.locator('#side blockquote').count()===0)throw new Error('No rendered evidence for '+feature);
    if(providerCalls!==before+1)throw new Error('Expected exactly one provider request for '+feature);
    if(feature==='helpers')await page.getByRole('button',{name:'Prepare a question',exact:true}).waitFor();
    if(feature==='dependencies')await page.getByRole('button',{name:'Confirm my task dependency',exact:true}).waitFor();
    if(feature==='overlap')await page.getByRole('button',{name:'Confirm duplicate and link',exact:true}).waitFor();
    checkedActions.push(feature);
   }
   // Reading suggestions must not silently alter shared work or send a notice.
   const token=await page.evaluate(()=>sessionStorage.getItem('lucid.office.session')!);
   const state=await(await fetch(base+'/api/collaboration',{headers:{Authorization:'Bearer '+token}})).json();
   if(state.tasks.some((t:any)=>t.dependsOn.length||t.status==='linked')||state.notifications.length)throw new Error('Read-only assistant changed workspace state');
  }
  await page.getByRole('button',{name:'Office',exact:true}).click();await page.getByText('Audio capture is off in this fictional-data demo. Use Meeting notes to inspect the seeded examples.',{exact:true}).waitFor();if(await page.getByRole('button',{name:'Request AI meeting notes',exact:true}).count())throw new Error('Fictional demo exposed capture controls');await context.close();
 }
 if(errors.length)throw new Error(errors.join('; '));if(providerCalls!==8)throw new Error('Unexpected automatic model calls');console.log(JSON.stringify({manualDemoBrowser:'PASS',fictionalAccounts:3,privateNoteAccess:true,assistantActions:checkedActions,mockedGeminiCalls:providerCalls,automaticModelCalls:0,readOnlySuggestions:true,liveApiCalls:0}));
}finally{await browser?.close();await app.stop();}
