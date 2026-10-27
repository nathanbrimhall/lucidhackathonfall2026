import { describe,it,expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageTracker } from '../../worker/src/usage.js';
import type { AddressInfo } from 'node:net';
import type { AgentContext } from '../../shared/src/agents.js';
import { FixtureAgentRuntime, GeminiAgentRuntime, type AgentRuntime } from '../src/runtime.js';
import { executeAgentJob, HttpAgentJobPort, type AgentJobPort } from '../src/worker.js';
import { loadWorkerConfig } from '../../worker/src/config.js';
const context=():AgentContext=>({run:{id:'run',officeId:'office',requesterUserId:'cameron',goal:'Prepare a launch brief',taskIds:[],contactUserIds:['nathan'],audience:'office',mode:'fixture',state:'working',revision:1,maxModelCalls:6,modelCalls:0,createdAt:'now',updatedAt:'now',reason:null},tasks:[],contacts:[{userId:'nathan',displayName:'Nathan'}],requests:[],artifact:null});
describe('bounded agent runtime',()=>{
 it('ends fixture turn on question, then incorporates the actual answer in a new stateless turn',async()=>{
  const runtime=new FixtureAgentRuntime(),c=context();
  const first=await runtime.turn(c,new AbortController().signal);
  expect(first.modelCalls).toBe(0);expect(first.questions).toHaveLength(1);expect(first.draft?.partial).toBe(true);expect(first.draft?.content).toContain('Unknown —');
  c.requests=[{id:'request',runId:'run',recipientUserId:'nathan',requesterUserId:'cameron',requesterName:'Cameron',question:first.questions![0].question,reason:'scope',answerAudience:'office',revision:2,status:'answered',answer:'https://office.example/actual-human-answer',allowPublication:true,expiresAt:'later',createdAt:'now'}];
  const resumed=await new FixtureAgentRuntime().turn(c,new AbortController().signal);
  expect(resumed.questions).toBeUndefined();expect(resumed.draft?.content).toContain('actual-human-answer');expect(resumed.draft?.content).toContain('FICTIONAL FIXTURE');expect(resumed.draft?.partial).toBe(true);expect(resumed.draft?.content).toContain('Unknown —');expect(resumed.draft?.evidence).toEqual([{type:'answer',id:'request',revision:2}]);
 });
 it('only completes the labeled fictional scenario with all required facts and retains requester edits',async()=>{
  const c=context();c.requests=[{id:'request',runId:'run',recipientUserId:'nathan',requesterUserId:'cameron',requesterName:'Cameron',question:'details',reason:'scope',answerAudience:'office',revision:1,status:'answered',answer:'Office URL: https://office.example\nJoin instructions: Open link and enter display name\nNear audio: Stand near and confirm both hear\nFar audio: Walk away and confirm fade\nPrivate-room audio: Enter room and check isolation\nKnown issues: None reported',allowPublication:true,expiresAt:'later',createdAt:'now'}];
  const runtime=new FixtureAgentRuntime();const draft=await runtime.turn(c,new AbortController().signal);expect(draft.draft?.partial).toBe(false);expect(draft.draft?.content).toContain('supplied by Nathan');
  c.reviewComments=[{comment:'Make the join instructions shorter',artifactRevision:1}];const edited=await runtime.turn(c,new AbortController().signal);expect(edited.draft?.content).toContain('Make the join instructions shorter');expect(edited.draft?.partial).toBe(true);
 });
 it('does not call runtime for idle work',async()=>{
  let calls=0;const runtime:AgentRuntime={mode:'fixture',async turn(){calls++;throw new Error('unexpected');}};
  const port:AgentJobPort={claim:()=>null,context,apply(){},fail(){}};
  expect(await executeAgentJob(port,runtime)).toBe(false);expect(calls).toBe(0);
 });
 it('checks cancellation during inference and prevents late apply',async()=>{
  let canceled=false,applied=false,aborted=false;const c=context();
  const port:AgentJobPort={claim:()=>({runId:'run',leaseToken:'lease'}),context(){if(canceled)throw new Error('canceled');return c;},apply(){applied=true;},fail(){}};
  const runtime:AgentRuntime={mode:'fixture',async turn(_c,signal){canceled=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return {modelCalls:0,questions:[{recipientUserId:'nathan',question:'q',reason:'r'}]};}};
  await executeAgentJob(port,runtime,{cancelPollMs:5,timeoutMs:1000});expect(aborted).toBe(true);expect(applied).toBe(false);
 });
 it('uses authenticated isolated HTTP contracts without retry',async()=>{
  const paths:string[]=[],tokens:string[]=[];let completion:any;
  const server=createServer(async(req,res)=>{paths.push(req.url!);tokens.push(req.headers.authorization!);let body='';for await(const chunk of req)body+=chunk;const parsed=JSON.parse(body);res.setHeader('Content-Type','application/json');if(req.url?.endsWith('/claim'))res.end(JSON.stringify({job:{runId:'run',leaseToken:'lease'}}));else if(req.url?.endsWith('/context'))res.end(JSON.stringify(context()));else {completion=parsed;res.end('{}');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const port=new HttpAgentJobPort(`http://127.0.0.1:${(server.address() as AddressInfo).port}`,'test-secret');await executeAgentJob(port,new FixtureAgentRuntime());expect(paths).toEqual(['/internal/agents/jobs/claim','/internal/agents/jobs/run/context','/internal/agents/jobs/run/context','/internal/agents/jobs/run/complete']);expect(tokens.every(t=>t==='Bearer test-secret')).toBe(true);expect(completion.leaseToken).toBe('lease');expect(completion.result.modelCalls).toBe(0);}finally{server.close();}
 });
 it('performs exactly one direct Gemini request with reconstructed context and no tools',async()=>{
  let requests=0,body:any;const config=loadWorkerConfig({AI_PROVIDER:'gemini',AI_WORKER_SECRET:'unit-test-worker-secret-long-enough',GEMINI_API_KEY:'fake-unit-test-key',AI_USAGE_DATABASE:':memory:',AI_SUMMARY_MODEL:'gemini-2.5-flash'});
  const runtime=new GeminiAgentRuntime(config,async(_url,init)=>{requests++;body=JSON.parse(init!.body as string);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({modelCalls:1,questions:[{recipientUserId:'nathan',question:'What is the confirmed URL?',reason:'Missing from shared tasks.'}]})}]}}],usageMetadata:{promptTokenCount:5,candidatesTokenCount:8,totalTokenCount:13}});});
  const c=context();c.run.mode='live';const result=await runtime.turn(c,new AbortController().signal);
  expect(result.questions).toHaveLength(1);expect(requests).toBe(1);expect(body.tools).toBeUndefined();expect(body.contents).toHaveLength(1);expect(body.contents[0].parts[0].text).toContain('Prepare a launch brief');
 });
 it('does not retry a failed provider request or silently fall back',async()=>{
  let requests=0;const config=loadWorkerConfig({AI_PROVIDER:'gemini',AI_WORKER_SECRET:'unit-test-worker-secret-long-enough',GEMINI_API_KEY:'fake-unit-test-key',AI_USAGE_DATABASE:':memory:'});
  const runtime=new GeminiAgentRuntime(config,async()=>{requests++;return new Response('',{status:429});});await expect(runtime.turn(context(),new AbortController().signal)).rejects.toThrow();expect(requests).toBe(1);
 });
 it('accounts failed requests in the shared daily tracker before dispatch and enforces its cap',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-runtime-'));let calls=0;
  const config=loadWorkerConfig({AI_PROVIDER:'gemini',AI_WORKER_SECRET:'unit-test-worker-secret-long-enough',GEMINI_API_KEY:'shared-fake-unit-key',AI_USAGE_DATABASE:join(dir,'usage.sqlite'),AI_LOCAL_DAILY_REQUEST_LIMIT:'1'});
  try{const runtime=new GeminiAgentRuntime(config,async()=>{calls++;return new Response('',{status:503});});
   await expect(runtime.turn(context(),new AbortController().signal)).rejects.toThrow();
   await expect(runtime.turn(context(),new AbortController().signal)).rejects.toThrow('LOCAL_BUDGET_EXCEEDED');
   const tracker=new UsageTracker(config.usageDatabase,config.apiKey,1);try{expect(tracker.status().today.attempts).toBe(1);expect(tracker.status().today.requestErrors).toBe(1);}finally{tracker.close();}
   expect(calls).toBe(1);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });

});
