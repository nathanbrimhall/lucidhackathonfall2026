import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERMES_COMMIT, HermesAgentRuntime, validateHermesSubmission, verifyHermesSource } from '../src/hermes.js';
import type { AgentContext } from '../../shared/src/agents.js';
import { loadWorkerConfig } from '../../worker/src/config.js';
import { UsageTracker } from '../../worker/src/usage.js';

const context = (): AgentContext => ({run:{id:'hermes-test',officeId:'office',requesterUserId:'cameron',goal:'Prepare a launch brief',taskIds:['task'],contactUserIds:['nathan'],audience:'office',mode:'live',state:'working',revision:1,maxModelCalls:6,modelCalls:1,createdAt:'now',updatedAt:'now',reason:null},tasks:[{id:'task',title:'Audio rehearsal',status:'open',revision:3,ownerUserId:'nathan'}],contacts:[{userId:'nathan',displayName:'Nathan'}],requests:[],artifact:null});
const question = { recipientUserId:'nathan',question:'What is the confirmed URL?',reason:'Missing from shared tasks.' };
const draft = { content:'Audio rehearsal remains pending. [task:task@3]', evidence:[{type:'task' as const,id:'task',revision:3}],partial:true };
const config = (database=':memory:', limit=20) => loadWorkerConfig({AI_PROVIDER:'gemini',AI_WORKER_SECRET:'test-worker-secret-at-least-32-characters',GEMINI_API_KEY:'fake-hermes-key',AI_SUMMARY_MODEL:'gemini-2.5-flash',AI_USAGE_DATABASE:database,AI_LOCAL_DAILY_REQUEST_LIMIT:String(limit)});
let syntheticProviderRequests=0;
const synthetic = (callback: typeof fetch): typeof fetch => async(input,init)=>{syntheticProviderRequests++;return callback(input,init);};
afterAll(()=>{if(process.env.AGENT_HERMES_TEST_ACCOUNTING_FILE)writeFileSync(process.env.AGENT_HERMES_TEST_ACCOUNTING_FILE,JSON.stringify({syntheticProviderRequests,paidProviderRequests:0}));});

describe('Hermes office boundary',()=>{
  it('pins an immutable upstream commit and rejects a missing or wrong checkout before model dispatch',async()=>{
    expect(HERMES_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    await expect(verifyHermesSource('/nonexistent/hermes-source')).rejects.toThrow('HERMES_PIN_OR_CLEAN_SOURCE_CHECK_FAILED');
    let calls=0;
    const runtime=new HermesAgentRuntime(config(),{sourceRoot:process.cwd(),python:'/nonexistent/python'},async()=>{calls++;throw new Error('unexpected');});
    await expect(runtime.turn(context(),AbortSignal.timeout(5000))).rejects.toThrow('HERMES_PIN_OR_CLEAN_SOURCE_CHECK_FAILED');
    expect(calls).toBe(0);
  });
  it('validates scoped questions and evidence and retains independent partial drafts',()=>{
    expect(validateHermesSubmission(context(),{modelCalls:1,questions:[question],draft})).toMatchObject({modelCalls:1,draft:{partial:true}});
    expect(()=>validateHermesSubmission(context(),{modelCalls:2,draft})).toThrow();
    expect(()=>validateHermesSubmission(context(),{modelCalls:1,questions:[{...question,recipientUserId:'outsider'}]})).toThrow('QUESTION_OUTSIDE_SCOPE');
    expect(()=>validateHermesSubmission(context(),{modelCalls:1,draft:{...draft,evidence:[{type:'task',id:'task',revision:2}]}})).toThrow('EVIDENCE_OUTSIDE_SCOPE');
    const waiting=context();waiting.requests=[{id:'pending',runId:waiting.run.id,recipientUserId:'nathan',requesterUserId:'cameron',requesterName:'Cameron',question:'URL?',reason:'scope',answerAudience:'office',revision:1,status:'open',answer:null,allowPublication:false,expiresAt:'later',createdAt:'now'}];
    expect(()=>validateHermesSubmission(waiting,{modelCalls:1,questions:[question]})).toThrow('QUESTION_OUTSIDE_SCOPE');
    expect(()=>validateHermesSubmission(waiting,{modelCalls:1,draft:{...draft,partial:false}})).toThrow('PENDING_ANSWERS_REQUIRE_PARTIAL_DRAFT');
    expect(()=>validateHermesSubmission(waiting,{modelCalls:1,draft:{...draft,evidence:[{type:'answer',id:'pending',revision:1}]}})).toThrow('EVIDENCE_OUTSIDE_SCOPE');
  });
});

// Opt-in dependency acceptance test: real, pinned AIAgent; synthetic provider only.
// No API credential or network provider is used. See the source pin comment in hermes.ts.
const sourceRoot=process.env.AGENT_HERMES_TEST_SOURCE_ROOT;
const python=process.env.AGENT_HERMES_TEST_PYTHON;
describe.skipIf(!sourceRoot||!python)('real pinned Hermes with a synthetic counted provider',()=>{
  it('ends on questions, resumes from scoped state in a fresh process, and counts every dispatch',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'hermes-acceptance-')),cfg=config(join(dir,'usage.sqlite'));
    let calls=0; const prompts:string[]=[];
    const runtime=new HermesAgentRuntime(cfg,{sourceRoot:sourceRoot!,python:python!},synthetic(async(_url,init)=>{
      calls++;prompts.push(String(init?.body));
      const arguments_=calls===1?{questions:[question],draft}:{draft:{...draft,content:'Confirmed synthetic supplied URL. [answer:answer@2]',evidence:[{type:'answer',id:'answer',revision:2}]}};
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({name:'office_submit_turn',arguments:arguments_})}]}}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:9,totalTokenCount:16}});
    }));
    try {
      const first=await runtime.turn(context(),AbortSignal.timeout(30_000));
      expect(first.questions).toEqual([question]);expect(first.draft?.partial).toBe(true);
      const resumed=context();resumed.run.modelCalls=2;resumed.requests=[{id:'answer',runId:resumed.run.id,recipientUserId:'nathan',requesterUserId:'cameron',requesterName:'Cameron',question:'URL?',reason:'scope',answerAudience:'office',revision:2,status:'answered',answer:'https://synthetic.invalid/office',allowPublication:true,expiresAt:'later',createdAt:'now'}];
      const next=await runtime.turn(resumed,AbortSignal.timeout(30_000));
      expect(next.questions).toBeUndefined();expect(next.draft?.evidence).toEqual([{type:'answer',id:'answer',revision:2}]);
      expect(calls).toBe(2);expect(prompts[0]).not.toContain('synthetic.invalid');expect(prompts[1]).toContain('synthetic.invalid');
      const tracker=new UsageTracker(cfg.usageDatabase,cfg.apiKey);try{expect(tracker.status().today.attempts).toBe(2);expect(tracker.status().today.totalTokens).toBe(32);}finally{tracker.close();}
    }finally{rmSync(dir,{recursive:true,force:true});}
  },70_000);
  it('fails visibly without retry or an uncounted fallback when provider dispatch fails',async()=>{
    let calls=0;
    const runtime=new HermesAgentRuntime(config(),{sourceRoot:sourceRoot!,python:python!},synthetic(async()=>{calls++;return new Response('',{status:503});}));
    await expect(runtime.turn(context(),AbortSignal.timeout(8000))).rejects.toThrow();
    expect(calls).toBe(1);
  },15_000);
  it('kills a running process on stop before any late result can be applied',async()=>{
    const controller=new AbortController();let calls=0;
    const runtime=new HermesAgentRuntime(config(),{sourceRoot:sourceRoot!,python:python!},synthetic(async(_url,init)=>{
      calls++;controller.abort();init?.signal?.throwIfAborted();throw new Error('aborted');
    }));
    await expect(runtime.turn(context(),AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]))).rejects.toThrow();
    expect(calls).toBe(1);
  },20_000);
  it('rejects credential leakage, shared memory, and unapproved tools in the child',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'hermes-policy-'));
    const bridge=join(dir,'policy.py');
    // This test harness probes the actual production bridge policy before importing Hermes.
    writeFileSync(bridge,`import importlib.util,json,os,sys,socket,subprocess\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('bridge', ${JSON.stringify(join(process.cwd(),'agent-worker/src/hermes_bridge.py'))})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\np=json.load(sys.stdin)\nassert 'GEMINI_API_KEY' not in os.environ and 'AGENT_WORKER_SECRET' not in os.environ\nassert Path(os.environ['HOME']).resolve() == Path.cwd().resolve()\nwith __import__('contextlib').redirect_stdout(sys.stderr):\n result=m.run(p,Path(sys.argv[1]).resolve())\nfor action in [lambda:socket.create_connection(('192.0.2.1',443),timeout=0.1),lambda:subprocess.run(['/bin/echo','forbidden'])]:\n try:\n  action()\n  raise AssertionError('policy was bypassed')\n except PermissionError:\n  pass\nprint(json.dumps(result))\n`);
    const runtime=new HermesAgentRuntime(config(),{sourceRoot:sourceRoot!,python:python!,bridgePath:bridge},synthetic(async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({name:'office_submit_turn',arguments:{draft}})}]}}]})));
    try{expect((await runtime.turn(context(),AbortSignal.timeout(30_000))).draft).toEqual(draft);}finally{rmSync(dir,{recursive:true,force:true});}
  },40_000);
  it('enforces the shared daily cap across fresh Hermes turns',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'hermes-budget-')),cfg=config(join(dir,'usage.sqlite'),1);let calls=0;
    const runtime=new HermesAgentRuntime(cfg,{sourceRoot:sourceRoot!,python:python!},synthetic(async()=>{calls++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({name:'office_submit_turn',arguments:{draft}})}]}}]});}));
    try{
      await runtime.turn(context(),AbortSignal.timeout(20_000));
      await expect(runtime.turn(context(),AbortSignal.timeout(8000))).rejects.toThrow();
      expect(calls).toBe(1);
      const tracker=new UsageTracker(cfg.usageDatabase,cfg.apiKey,1);try{expect(tracker.status().today.attempts).toBe(1);}finally{tracker.close();}
    }finally{rmSync(dir,{recursive:true,force:true});}
  },35_000);
});
