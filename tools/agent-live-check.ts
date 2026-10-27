/** Explicit bounded live gate using fictional isolated office data; never a human rehearsal. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../server/src/app.config.js';
import { loadConfig } from '../server/src/config.js';
import { LiveKitService } from '../server/src/services/LiveKitService.js';
import { loadWorkerConfig } from '../worker/src/config.js';
import { UsageTracker } from '../worker/src/usage.js';
import { GeminiAgentRuntime } from '../agent-worker/src/runtime.js';
import { HermesAgentRuntime, HERMES_COMMIT } from '../agent-worker/src/hermes.js';
import { executeAgentJob, HttpAgentJobPort } from '../agent-worker/src/worker.js';
const runtimeIndex=process.argv.indexOf('--runtime');
const runtimeKind=runtimeIndex<0?'gemini':process.argv[runtimeIndex+1];
if(runtimeKind!=='gemini'&&runtimeKind!=='hermes')throw Error('--runtime must be gemini or hermes.');
const verifyEdits=process.argv.includes('--edits'),maxRequests=verifyEdits?3:2;
if(!process.argv.includes('--live'))throw Error('Pass --live for a bounded live check (two requests, or three with --edits), using fictional office data.');
const workerConfig=loadWorkerConfig(process.env),usage=new UsageTracker(workerConfig.usageDatabase,workerConfig.apiKey,workerConfig.localDailyRequestLimit);
const before=usage.status();if(before.quotaPaused||before.localRequestsRemaining<maxRequests){usage.close();throw Error(`${maxRequests} requests must remain in the existing shared budget, with no quota pause.`);}
const secret=randomUUID()+randomUUID();
const config=loadConfig({PUBLIC_SERVER_URL:'http://localhost:2567',ALLOWED_ORIGINS:'http://localhost:2567',SESSION_SECRET:randomUUID()+randomUUID(),DATABASE_URL:':memory:',GUEST_INVITE_CODE:'fictional-live-check',OFFICE_ID:'fictional-agent-live-check',LIVEKIT_INTERNAL_URL:'http://127.0.0.1:1',LIVEKIT_PUBLIC_URL:'ws://127.0.0.1:1',LIVEKIT_API_KEY:'testkey',LIVEKIT_API_SECRET:randomUUID()+randomUUID(),OFFICE_LAYOUT:'prototype',AGENT_RUNTIME:runtimeKind,AGENT_WORKER_SECRET:secret});
const app=createApplication(config,{},new LiveKitService(config,{backend:{issueToken:async()=>'',removeParticipant:async()=>{},deleteRoom:async()=>{},verifyWebhook:async()=>{throw Error('unused');}}}),{assistantEnv:{}});
const report:any={startedAt:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtime:runtimeKind==='hermes'?'pinned-hermes-single-request-turn':'direct-gemini-single-request-turn',runtimeCommit:runtimeKind==='hermes'?HERMES_COMMIT:null,workingTreeDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,model:workerConfig.summaryModel,mode:'live',data:'fictional',participants:'two synthetic authenticated accounts; no human rehearsal',devices:0,maxModelRequests:maxRequests,passed:false};
try{
 const base=`http://127.0.0.1:${await app.start(0,'127.0.0.1')}`;
 const api=async(path:string,token?:string,body?:unknown)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} :{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw Error(`Office ${r.status}: ${data.error?.message}`);return data;};
 const a=await api('/api/sessions/guest',undefined,{displayName:'Fictional Cameron',inviteCode:config.inviteCode}),b=await api('/api/sessions/guest',undefined,{displayName:'Fictional Nathan',inviteCode:config.inviteCode});
 const task=await api('/api/collaboration/tasks',a.token,{requestId:'source',title:'Demo launch brief needs Nathan to confirm office URL, join instructions, near/far audio tests, private-room test and known issues.',ownerUserId:b.userId});
 const run=await api('/api/agents/runs',a.token,{requestId:'live-gate',goal:'Prepare a demo launch brief. Our one shared task lists required details but does not supply them. Ask the allowed Nathan contact for the missing confirmed facts before writing the brief. Do not invent facts. Links remain supplied/unverified. Return a finished draft for review.',taskIds:[task.id],contactUserIds:[b.userId],audience:'office',mode:'live',maxModelCalls:maxRequests});
 const port=new HttpAgentJobPort(base,secret),runtime=runtimeKind==='hermes'?new HermesAgentRuntime(workerConfig,{sourceRoot:process.env.AGENT_HERMES_SOURCE_ROOT??'',python:process.env.AGENT_HERMES_PYTHON??''}):new GeminiAgentRuntime(workerConfig);
 await executeAgentJob(port,runtime,{workerId:'bounded-live-check'});
 const inbox=await api('/api/agents',b.token),q=inbox.requests[0];if(!q){const failed=await api('/api/agents/runs/'+run.id,a.token);report.state=failed.run.state;report.failureReason=failed.run.reason;throw Error('Live model did not create the required cross-user question.');}report.questionAsked=true;
 const waiting=await api('/api/agents/runs/'+run.id,a.token);if(waiting.run.state!=='waiting_for_person')throw Error('Human question did not durably pause work.');
 if(await executeAgentJob(port,runtime))throw Error('A waiting run was incorrectly claimed.');report.waitingUsesNoCalls=true;
 const answer='Office URL: https://office-demo.example.test\nJoin instructions: Open the supplied URL and use the demo invite from the host.\nNear audio: Stand one tile apart and confirm both can hear.\nFar audio: Walk six tiles apart and verify voices fade.\nPrivate-room audio: Enter the room together; an outside third person must not hear.\nKnown issues: Audio playback may require a click; HTTPS is needed across laptops.';
 await api('/api/agents/requests/'+q.id+'/respond',b.token,{requestId:'live-answer',revision:q.revision,decision:'answer',answer,allowPublication:true});
 await executeAgentJob(port,runtime,{workerId:'bounded-live-check'});
 const detail=await api('/api/agents/runs/'+run.id,a.token);report.state=detail.run.state;report.modelRequestsReserved=detail.run.modelCalls;report.artifactPartial=detail.artifact?.partial;
 if(detail.run.state!=='ready_for_review'||!detail.artifact?.content.includes('https://office-demo.example.test')||!detail.artifact.evidence.some((e:any)=>e.type==='answer'&&e.id===q.id))throw Error('Live continuation did not produce an attributed draft with the supplied URL.');
 report.actualAnswerUsed=true;
 if(verifyEdits){
  const title='LAN rehearsal launch brief';
  await api('/api/agents/runs/'+run.id+'/review',a.token,{requestId:'live-edit',revision:detail.artifact.revision,decision:'changes',comment:`Change the document's main title to exactly "${title}". Keep all supplied facts, their actual evidence references and audience restrictions. Do not add facts.`});
  await executeAgentJob(port,runtime,{workerId:'bounded-live-edit-check'});
  const revised=await api('/api/agents/runs/'+run.id,a.token);
  if(revised.run.state!=='ready_for_review'||revised.artifact?.revision<=detail.artifact.revision||!revised.artifact?.content.split('\n').slice(0,3).some((line:string)=>line.replace(/^#+\s*/, '').trim()===title)||!revised.artifact?.content.includes('https://office-demo.example.test')||!revised.artifact.evidence.some((e:any)=>e.type==='answer'&&e.id===q.id&&e.revision===q.revision))throw Error('Live requested edit did not produce a new evidence-linked draft with the exact requested title.');
  const stale=await fetch(base+'/api/agents/runs/'+run.id+'/review',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${a.token}`},body:JSON.stringify({requestId:'stale-live-review',revision:detail.artifact.revision,decision:'approve'})});
  if(stale.status!==409)throw Error('The old artifact revision could still be approved.');
  report.requestedEditApplied=true;report.staleApprovalRejected=true;report.state=revised.run.state;report.modelRequestsReserved=revised.run.modelCalls;report.artifactPartial=revised.artifact.partial;
 }
 report.passed=true;
}catch(error){report.error=error instanceof Error?error.message:'Live check failed';process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();const after=usage.status();report.actualProviderAttempts=after.today.attempts-before.today.attempts;if(!report.passed)report.lastProviderError=after.lastError;usage.close();await app.stop();await mkdir('data/ai-eval',{recursive:true});const output=JSON.stringify(report,null,2)+'\n';await writeFile('data/ai-eval/agent-live-check-latest.json',output);await writeFile('data/ai-eval/agent-live-check-'+report.startedAt.replace(/[:.]/g,'-')+'.json',output);console.log(JSON.stringify(report,null,2));}
