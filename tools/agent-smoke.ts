import { chromium } from 'playwright';
import { createApplication } from '../server/src/app.config.js';
import { loadConfig } from '../server/src/config.js';
import { LiveKitService } from '../server/src/services/LiveKitService.js';
const config=loadConfig({PUBLIC_SERVER_URL:'http://localhost:2567',ALLOWED_ORIGINS:'http://localhost:2567',SESSION_SECRET:'test-agent-session-secret-at-least-32-characters',DATABASE_URL:':memory:',GUEST_INVITE_CODE:'agent-browser-invite',OFFICE_ID:'agent-browser-test',LIVEKIT_INTERNAL_URL:'http://127.0.0.1:1',LIVEKIT_PUBLIC_URL:'ws://127.0.0.1:1',LIVEKIT_API_KEY:'testkey',LIVEKIT_API_SECRET:'test-only-livekit-secret-at-least-32-characters',OFFICE_LAYOUT:'prototype'});
const app=createApplication(config,{},new LiveKitService(config,{backend:{issueToken:async()=> 'synthetic-media-token',removeParticipant:async()=>{},deleteRoom:async()=>{},verifyWebhook:async()=>{throw Error('unused');}}}),{assistantEnv:{}});
const port=await app.start(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;config.allowedOrigins.push(base);let browser;
try{
 browser=await chromium.launch({headless:!process.argv.includes('--headed'),args:process.env.OFFICE_TEST_OFFLINE?['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']:[],executablePath:process.env.AI_BROWSER_EXECUTABLE});
 const a=await(await browser.newContext()).newPage(),b=await(await browser.newContext()).newPage();const errors:string[]=[];
 for(const page of [a,b]){page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));page.on('response',async response=>{if(response.url().includes('/api/agents')&&response.status()>=400)console.log('Agent API check returned HTTP',response.status());});}
 async function join(page:typeof a,name:string){await page.goto(base);await page.getByLabel('Display name',{exact:true}).fill(name);await page.getByLabel('Office invite code',{exact:true}).fill(config.inviteCode);await page.getByRole('button',{name:'Join office',exact:true}).click();await page.getByText('Connected as '+name,{exact:true}).waitFor();}
 async function agentPanel(page:typeof a){await page.getByRole('button',{name:'Shared agent',exact:true}).first().click();await page.getByRole('button',{name:'Refresh agent activity',exact:true}).click();}
 const json=async(page:typeof a,path:string)=>{const token=await page.evaluate(()=>sessionStorage.getItem('lucid.office.session'));const response=await fetch(base+path,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw Error(`Read failed ${response.status}`);return response.json();};
 await join(a,'Cameron');await join(b,'Nathan');await a.getByRole('button',{name:'Refresh saved data',exact:true}).click();await agentPanel(a);
 await a.getByLabel('Goal',{exact:true}).fill('Prepare a brief using Nathan’s confirmed URL and audio-test procedure.');
 await a.getByLabel('Allow contact: Nathan',{exact:true}).check();const starting=a.waitForResponse(r=>r.url()===base+'/api/agents/runs'&&r.request().method()==='POST');await a.getByRole('button',{name:'Start assignment',exact:true}).click();const started=await starting;if(!started.ok())throw Error('Start failed: '+await started.text());
 await a.getByRole('button',{name:'Open authorized activity',exact:true}).waitFor();
 const runId=(await json(a,'/api/agents')).runs[0].id;
 async function until(check:()=>Promise<boolean>){for(let i=0;i<20;i++){if(await check())return;await a.waitForTimeout(200);}throw Error('Timed out waiting for durable agent turn');}
 await until(async()=>!!(await json(b,'/api/agents')).requests.length);
 // Recipient reconnects after persistence. An opted-out person sees no active notice.
 await b.reload();await b.getByRole('button',{name:'Resume my session',exact:true}).click();await b.getByText('Connected as Nathan',{exact:true}).waitFor();await agentPanel(b);
 await b.getByLabel('Your answer',{exact:true}).waitFor();
 const answer='Office URL: https://office.example.test (supplied/unverified)\nJoin instructions: Join with the shared invite.\nNear audio: Walk together and verify both voices.\nFar audio: Walk six tiles apart and verify attenuation.\nPrivate-room audio: Enter together and verify an outside person cannot hear.\nKnown issues: Browser playback may need a click.';
 await b.getByLabel('Your answer',{exact:true}).fill(answer);await b.getByLabel('May this answer be used for',{exact:true}).selectOption('office');await b.getByRole('button',{name:'Reply',exact:true}).click();await b.getByRole('button',{name:'Refresh agent activity',exact:true}).click();
 const answeredInbox=await json(b,'/api/agents');if(!answeredInbox.requests.some((r:any)=>r.status==='answered'))throw Error('Answered request missing from recipient correction inbox');await b.getByLabel('Correct your answer',{exact:true}).waitFor();const correctedAnswer=answer.replace('https://office.example.test','https://office.example.test/corrected');await b.getByLabel('Correct your answer',{exact:true}).fill(correctedAnswer);await b.getByRole('button',{name:'Save corrected answer',exact:true}).click();
 await until(async()=>{const detail=await json(a,'/api/agents/runs/'+runId);return detail.run.state==='ready_for_review'&&detail.artifact?.content.includes(correctedAnswer);});
 // Refresh explicitly instead of waiting for periodic UI refresh.
 await a.getByRole('button',{name:'Refresh agent activity',exact:true}).click();await a.getByRole('button',{name:'Open authorized activity',exact:true}).click();
 await a.getByLabel('Draft for review',{exact:true}).waitFor();
 const firstDraft=await a.getByLabel('Draft for review',{exact:true}).inputValue();if(!firstDraft.includes(correctedAnswer))throw Error('Corrected participant answer did not change the draft');
 const firstArtifact=(await json(a,'/api/agents/runs/'+runId)).artifact;
 await a.getByLabel('Request changes',{exact:true}).fill('Title: Rehearsal-ready launch brief');await a.getByRole('button',{name:'Request edits',exact:true}).click();
 await until(async()=>{const detail=await json(a,'/api/agents/runs/'+runId);return detail.run.state==='ready_for_review'&&detail.artifact?.revision>firstArtifact.revision;});
 await a.getByRole('button',{name:'Refresh agent activity',exact:true}).click();await a.getByRole('button',{name:'Open authorized activity',exact:true}).click();
 const revised=await a.getByLabel('Draft for review',{exact:true}).inputValue();const revisedDetail=await json(a,'/api/agents/runs/'+runId);const answerEvidence=revisedDetail.artifact.evidence.find((item:any)=>item.type==='answer');if(!revised.includes('# FICTIONAL FIXTURE DEMO — Rehearsal-ready launch brief')||!revised.includes(correctedAnswer)||!answerEvidence||!revised.includes(`[answer:${answerEvidence.id}@${answerEvidence.revision}]`))throw Error('Requested edit did not preserve source and answer attribution in the new draft');
 const staleApproval=await a.evaluate(async({runId,revision})=>{const token=sessionStorage.getItem('lucid.office.session');const response=await fetch(`/api/agents/runs/${encodeURIComponent(runId)}/review`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),revision,decision:'approve'})});return response.status;},{runId,revision:firstArtifact.revision});if(staleApproval!==409)throw Error('The earlier reviewed draft revision was not rejected after requested edits');
 await a.getByRole('button',{name:'Approve and publish',exact:true}).click();await a.getByText(correctedAnswer,{exact:false}).first().waitFor();
 await b.getByRole('button',{name:'Refresh agent activity',exact:true}).click();
 const published=await json(b,'/api/agents');if(published.publications.length!==1||!published.publications[0].content.includes(correctedAnswer))throw Error('Approved result was not shared exactly once');
 if(published.status.state!=='idle')throw Error('Agent did not return to idle');
 const privateRun=await json(a,'/api/agents/runs/'+(await json(a,'/api/agents')).runs[0].id);if(privateRun.run.modelCalls!==0)throw Error('Fixture consumed model calls');
 if(errors.length)throw Error(errors.join('; '));
 console.log(JSON.stringify({agentBrowser:'PASS',mode:'fixture',browserContexts:2,realDevices:false,liveModelCalls:0,authenticatedAnswerInDraft:true,requestedEditRevision:true,staleApprovalRejected:true,correctedAnswerInDraft:true,recipientReconnect:true,reviewedPublication:true}));
}finally{await browser?.close();await app.stop();}
