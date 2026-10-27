import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const source=process.env.AGENT_HERMES_SOURCE_ROOT,python=process.env.AGENT_HERMES_PYTHON;
const output=join(root,'data/ai-eval/hermes-verification-latest.json');
const pin=/HERMES_COMMIT = '([a-f0-9]{40})'/.exec(readFileSync(join(root,'agent-worker/src/hermes.ts'),'utf8'))?.[1];
const report={verifiedAt:new Date().toISOString(),status:'failed',runtime:'Hermes AIAgent',sourceCommit:pin,
  provider:'synthetic Gemini responses intercepted before network dispatch',paidProviderRequests:0,
  liveProviderVerified:false,liveHumanAcceptance:false};
const scratch=mkdtempSync(join(tmpdir(),'verify-office-hermes-'));
try{
  if(!source||!python||!isAbsolute(source)||!isAbsolute(python))throw new Error('Set absolute AGENT_HERMES_SOURCE_ROOT and AGENT_HERMES_PYTHON paths. Verification requires the pinned source and installed dependencies; it never silently skips.');
  const revision=execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',source,'rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim();
  if(revision!==pin)throw new Error('Hermes source revision does not match the adapter pin.');
  if(execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',source,'status','--porcelain','--untracked-files=all'],{encoding:'utf8',timeout:5000}).trim())throw new Error('Hermes source must be clean.');
  report.python=execFileSync(python,['-I','--version'],{encoding:'utf8',timeout:5000}).trim();
  report.dependencies=JSON.parse(execFileSync(python,['-I','-c','import importlib.metadata as m,json;print(json.dumps({p:m.version(p) for p in ["hermes-agent","openai","pydantic","httpx"]}))'],{encoding:'utf8',timeout:5000}));
  const results=join(scratch,'tests.json'),accounting=join(scratch,'accounting.json');
  const child=spawn(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','agent-worker/test/hermes.test.ts','--reporter=default','--reporter=json',`--outputFile.json=${results}`],{cwd:root,stdio:'inherit',env:{...process.env,AGENT_HERMES_TEST_SOURCE_ROOT:source,AGENT_HERMES_TEST_PYTHON:python,AGENT_HERMES_TEST_ACCOUNTING_FILE:accounting}});
  const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  const tests=JSON.parse(readFileSync(results,'utf8'));
  Object.assign(report,JSON.parse(readFileSync(accounting,'utf8')),{testsPassed:tests.numPassedTests,testsFailed:tests.numFailedTests,testsSkipped:tests.numPendingTests});
  if(exitCode!==0||!tests.success||tests.numPendingTests!==0)throw new Error('Hermes acceptance checks failed or skipped.');
  report.status='passed';
  report.coverage=['exact clean source pin','real AIAgent synthetic question and independent draft','fresh-process authorized continuation','no provider credentials in child','tool and memory lockdown','non-proxy network and subprocess rejection','shared daily usage cap','provider failure without extra dispatch','stop kills runtime'];
  report.limitations=['Synthetic provider only; no real Gemini response or human rehearsal is accepted by this check.','Python audit policy and clean pinned source are not an OS sandbox for hostile runtime code.'];
}catch(error){report.error=error instanceof Error?error.message:'Hermes verification failed.';process.exitCode=1;}
finally{mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');rmSync(scratch,{recursive:true,force:true});}
console.info(`Hermes verification ${report.status}. Report: ${output}`);
if(report.error)console.error(report.error);
