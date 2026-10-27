import { chromium } from 'playwright';
import { createApplication } from '../server/src/app.config.js';
import { loadConfig } from '../server/src/config.js';
import { LiveKitService } from '../server/src/services/LiveKitService.js';
const config=loadConfig({PUBLIC_SERVER_URL:'http://localhost:2567',ALLOWED_ORIGINS:'http://localhost:2567',SESSION_SECRET:'test-only-session-secret-at-least-32-characters',DATABASE_URL:':memory:',GUEST_INVITE_CODE:'integrated-test-invite',OFFICE_ID:'integrated-test',LIVEKIT_INTERNAL_URL:'http://127.0.0.1:1',LIVEKIT_PUBLIC_URL:'ws://127.0.0.1:1',LIVEKIT_API_KEY:'testkey',LIVEKIT_API_SECRET:'test-only-livekit-secret-at-least-32-characters',AI_ENABLED:'true',AI_WORKER_SECRET:'test-worker-secret-distinct-and-at-least-32-characters',OFFICE_LAYOUT:'prototype'});
const media=new LiveKitService(config,{backend:{issueToken:async()=> 'synthetic-media-token',removeParticipant:async()=>{},deleteRoom:async()=>{},verifyWebhook:async()=>{throw new Error('unused');}}});
let providerCalls=0;
const request:typeof fetch=async(_url,init)=>{providerCalls++;const input=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);let items:any[]=[];
 const taskSources=input.sources.filter((s:any)=>s.type==='current_task').map((s:any)=>({...JSON.parse(s.text),id:s.taskId,sourceId:s.id}));
 if(input.feature==='decisions'){const source=input.sources.find((s:any)=>s.section==='decisions');if(source)items=[{kind:'draft_decision',text:'The saved draft records an audio-only demo. It is not a human-confirmed decision record.',sourceIds:[source.id]}];}
 if(input.feature==='dependencies'){const blocked=taskSources.find((t:any)=>t.title==='Build notes preview'&&t.ownerUserId===input.requesterUserId&&t.status==='open'),blocker=taskSources.find((t:any)=>t.title==='Export speaker IDs'&&t.ownerUserId!==input.requesterUserId&&t.status==='open');if(blocked&&blocker)items=[{kind:'dependency',text:'The preview needs the existing export.',sourceIds:[blocked.sourceId,blocker.sourceId],blockedTaskId:blocked.id,blockerTaskId:blocker.id}];}
 if(input.feature==='overlap'){const proposed=taskSources.find((t:any)=>t.title==='Export speaker IDs'&&t.ownerUserId===input.requesterUserId&&t.status==='proposed'),existing=taskSources.find((t:any)=>t.title==='Export speaker IDs'&&t.ownerUserId!==input.requesterUserId&&t.status==='open');if(proposed&&existing)items=[{kind:'overlap',text:'Both proposals describe the same deliverable; confirm before linking.',sourceIds:[proposed.sourceId,existing.sourceId],proposedTaskId:proposed.id,existingTaskId:existing.id}];}
 return new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({status:items.length?'supported':'not_found',items})}]}}],usageMetadata:{promptTokenCount:120,candidatesTokenCount:60,totalTokenCount:180}}));};
const app=createApplication(config,{},media,{assistantEnv:{AI_PROVIDER:'gemini',GEMINI_API_KEY:'fictional-key',AI_WORKER_SECRET:'s'.repeat(32),AI_USAGE_DATABASE:':memory:'},assistantRequest:request,assistantCooldown:0});
const port=await app.start(0,"127.0.0.1"),base=`http://127.0.0.1:${port}`;config.allowedOrigins.push(base);let browser;
// The browser flow deliberately performs many reviewed writes and refreshes in
// rapid succession. Respect the real 60-request/user/minute limit rather than
// disabling production protection or treating a rate-limit toast as an AI failure.
const requestWindows=new Map<string,{count:number;expires:number}>();
function recordApiRequest(url:string,authorization?:string){
 if(!url.startsWith(base+'/api/'))return;
 const key=authorization??'anonymous',now=Date.now(),previous=requestWindows.get(key);
 const window=previous&&previous.expires>now?previous:{count:0,expires:now+60000};
 window.count++;requestWindows.set(key,window);
}
async function waitForRequestBudget(page:import('playwright').Page){
 const key='Bearer '+await page.evaluate(()=>sessionStorage.getItem('lucid.office.session')!),window=requestWindows.get(key);
 // Reserve enough room for the request and the frontend's ensuing refreshes.
 if(window&&window.count>45&&window.expires>Date.now()){
  const milliseconds=window.expires-Date.now()+1000;
  console.log('Integration: respecting per-user HTTP budget; waiting '+Math.ceil(milliseconds/1000)+' seconds');
  await page.waitForTimeout(milliseconds);
 }
}
async function askAssistant(page:import('playwright').Page,feature:string,prompt:string){
 await waitForRequestBudget(page);
 await page.getByLabel('AI action',{exact:true}).selectOption(feature);
 await page.getByLabel('Your question',{exact:true}).fill(prompt);
 const pending=page.waitForResponse(r=>r.url()===base+'/api/assistant'&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Ask assistant',exact:true}).click();
 const response=await pending,result=await response.json();
 if(!response.ok())throw new Error('Assistant '+feature+' returned HTTP '+response.status()+': '+(result.error?.code??'unknown')+' ('+(result.error?.message??'no message')+')');
 if(!result.items?.length)throw new Error('Assistant '+feature+' returned '+result.status+' without evidence-backed items');
 console.log(JSON.stringify({assistantFeature:feature,httpStatus:response.status(),items:result.items.length,sources:result.sources.length}));
 return result;
}

const worker=async(path:string,body:unknown)=>{const response=await fetch(base+'/internal/ai/jobs/'+path,{method:'POST',headers:{Authorization:`Bearer ${config.aiWorkerSecret}`,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('Worker contract failed '+response.status);return response.json();};
try{
 browser=await chromium.launch({headless:!process.argv.includes('--headed'),args:process.env.OFFICE_TEST_OFFLINE?['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']:[],executablePath:process.env.AI_BROWSER_EXECUTABLE??(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
 const ca=await browser.newContext(),cb=await browser.newContext(),cc=await browser.newContext();const a=await ca.newPage(),b=await cb.newPage(),c=await cc.newPage();const pageErrors:string[]=[];for(const page of [a,b,c]){page.setDefaultTimeout(10000);page.on('pageerror',error=>pageErrors.push(error.message));page.on('request',request=>recordApiRequest(request.url(),request.headers()['authorization']));page.on('response',response=>{if(response.url().startsWith(base+'/api/')&&response.status()>=400)console.log(JSON.stringify({browserHttpError:new URL(response.url()).pathname,status:response.status()}));});}
 async function join(page:typeof a,name:string){await page.goto(base);await page.getByLabel('Display name',{exact:true}).fill(name);await page.getByLabel('Office invite code',{exact:true}).fill(config.inviteCode);await page.getByRole('button',{name:'Join office',exact:true}).click();await page.getByText('Connected as '+name,{exact:true}).waitFor({timeout:15000});}
 const token=async(page:typeof a)=>page.evaluate(()=>sessionStorage.getItem('lucid.office.session')!);
 const data=async(page:typeof a,path='/api/collaboration')=>{const authorization='Bearer '+await token(page);recordApiRequest(base+path,authorization);const response=await fetch(base+path,{headers:{Authorization:authorization}});if(!response.ok)throw new Error('Authenticated read failed '+response.status);return response.json();};
 async function nav(page:typeof a,name:string){await page.getByRole('button',{name,exact:true}).first().click();}
 async function refresh(page:typeof a){const response=page.waitForResponse(r=>r.url()===base+'/api/collaboration');await page.getByRole('button',{name:'Refresh saved data',exact:true}).click();await response;await page.waitForTimeout(150);}
 console.log('Integration: joining two browser sessions');await join(a,'Nathan');await join(b,'Cameron');await refresh(a);if(providerCalls)throw new Error('AI ran before a request');
 const aId=(await data(a)).identity.userId,bId=(await data(b)).identity.userId;
 console.log('Integration: server-authoritative navigation');for(const page of [a,b]){await nav(page,'Office');await page.getByRole('button',{name:'Walk to meeting room',exact:true}).click();}
 for(const page of [a,b])await page.locator('#location').filter({hasText:'In a private meeting'}).waitFor({timeout:25000});
 console.log('Integration: unanimous consent');await a.getByRole('button',{name:'Request AI meeting notes',exact:true}).click();await a.getByRole('button',{name:'I consent for this roster',exact:true}).waitFor();
 if((await worker('claim',{workerId:'integrated-smoke'})).job)throw new Error('Capture started before consent');
 await a.getByRole('button',{name:'I consent for this roster',exact:true}).click();if((await worker('claim',{workerId:'integrated-smoke'})).job)throw new Error('One person authorized capture for everyone');
 await b.getByRole('button',{name:'I consent for this roster',exact:true}).click();await b.getByText('Notes status: capturing',{exact:true}).waitFor();
 const capture=(await worker('claim',{workerId:'integrated-smoke'})).job;if(capture?.kind!=='capture')throw new Error('No capture job');
 await worker(capture.id+'/segments',{leaseToken:capture.leaseToken,segments:[{id:'s1',speakerUserId:aId,startMs:0,endMs:4000,text:'We will keep the demo audio only to reduce camera and layout work.'},{id:'s2',speakerUserId:bId,startMs:5000,endMs:9000,text:'I will export stable speaker IDs for the team.'}]});
 await worker(capture.id+'/complete',{leaseToken:capture.leaseToken});const summary=(await worker('claim',{workerId:'integrated-smoke'})).job;if(summary?.kind!=='summarize')throw new Error('No summary job');
 await worker(summary.id+'/complete',{leaseToken:summary.leaseToken,notes:{summary:[{text:'The team chose audio-only scope to reduce camera and layout work.',segmentIds:['s1']}],decisions:[{text:'Use audio only for this demo.',segmentIds:['s1']}],actionItems:[{text:'Export speaker IDs',segmentIds:['s2'],ownerUserId:bId,dueAt:null}]}});
 console.log('Integration: private notes and reviewed work');await nav(a,'Meeting notes');await refresh(a);await a.getByText('Use audio only for this demo.',{exact:true}).waitFor();await a.getByRole('button',{name:'Review task proposal',exact:true}).click();await a.getByRole('button',{name:'Publish task proposal',exact:true}).click();await a.getByRole('heading',{name:'Shared tasks',exact:true}).waitFor();
 await nav(b,'Tasks');await refresh(b);await b.getByRole('button',{name:'Accept task',exact:true}).click();await b.getByRole('button',{name:'Mark complete',exact:true}).waitFor();
 await nav(a,'Meeting notes');await refresh(a);await a.getByRole('button',{name:'Prepare message',exact:true}).click();await a.getByRole('button',{name:'Save draft',exact:true}).click();await a.getByRole('button',{name:'Approve saved wording',exact:true}).click();await a.getByRole('button',{name:'Send approved desk note',exact:true}).click();await nav(b,'Desk notes');await refresh(b);await b.getByText(/Following up on our meeting notes/).waitFor();
 await nav(a,'Tasks');await a.getByRole('button',{name:'Propose a task',exact:true}).click();await a.getByLabel('Task',{exact:true}).fill('Build notes preview');await a.getByLabel('Proposed owner',{exact:true}).selectOption(aId);await a.getByRole('button',{name:'Publish task proposal',exact:true}).click();await a.getByRole('button',{name:'Accept task',exact:true}).click();
 await nav(a,'AI assistant');await askAssistant(a,'dependencies','Which task does my preview depend on?');await a.getByRole('button',{name:'Confirm my task dependency',exact:true}).click();await nav(b,'Tasks');await refresh(b);if(!(await b.locator('#side').textContent())?.includes('1 other person waiting'))throw new Error('Dependency urgency did not update');
 await join(c,'Unrelated guest');const third=await data(c,'/api/notes');if(third.notes.length)throw new Error('Unrelated guest received meeting notes');
 await nav(a,'AI assistant');await askAssistant(a,'decisions','What decision was recorded about demo scope?');await a.getByText('The saved draft records an audio-only demo. It is not a human-confirmed decision record.',{exact:true}).waitFor();
 if(pageErrors.length)throw new Error(pageErrors.join(';'));console.log(JSON.stringify({integratedBrowser:'PASS',realMultiplayer:true,realAuthenticatedPersistence:true,unanimousConsent:true,syntheticWorkerTranscript:true,privateNotes:true,reviewedTask:true,approvedDeskMessage:true,dependencyUrgency:true,noteGroundedAssistant:true,mockedGeminiCalls:providerCalls,liveApiCalls:0,realAudioTested:false}));
}finally{await browser?.close();await app.stop();}
