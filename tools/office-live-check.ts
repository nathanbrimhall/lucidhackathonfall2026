import { mkdir,writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { openStorage } from '../server/src/repositories/Storage.js';
import { AIRepository } from '../server/src/repositories/AIRepository.js';
import { CollaborationService } from '../server/src/services/CollaborationService.js';
import { OfficeAssistant } from '../server/src/services/OfficeAssistant.js';
import { AuthService } from '../server/src/auth/AuthService.js';
import { loadConfig } from '../server/src/config.js';
import { seedManualDemo } from '../server/src/domain/manual-demo.js';
import { loadWorkerConfig } from '../worker/src/config.js';
import { UsageTracker,UsageLimitError } from '../worker/src/usage.js';
import { ProviderError } from '../worker/src/providers.js';
import { runFixture } from './ai-eval/runner.js';
import { fixtures } from './ai-eval/fixtures.js';
if(process.env.AI_PROVIDER!=='gemini')throw new Error('Live checks require AI_PROVIDER=gemini; no fallback is permitted.');
const config=loadWorkerConfig(),tracker=new UsageTracker(config.usageDatabase,config.apiKey,config.localDailyRequestLimit);
const before=tracker.status();
const raw=process.argv.indexOf('--max-calls'),requested=raw<0?9:Number(process.argv[raw+1]);
if(!Number.isInteger(requested)||requested<1||requested>9){tracker.close();throw new Error('--max-calls must be 1 through 9');}
const limit=before.quotaPaused?0:Math.max(0,Math.min(requested,before.localRequestsRemaining-2));
const storage=openStorage(':memory:'),notes=new AIRepository(storage),service=new CollaborationService(storage,notes);
const officeConfig=loadConfig({...process.env,DATABASE_URL:':memory:',OFFICE_ID:'fictional-live-check',AI_ENABLED:'false'});
const users=seedManualDemo(new AuthService(storage,officeConfig),notes,service,officeConfig),nathan=users[0],cameron=users[1];
const assistant=new OfficeAssistant(notes,service,process.env,fetch,0),runs:any[]=[];
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const yesterday=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Denver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-86400000));
const cases=[
 ['decisions','Was video approved, why was audio-only chosen, and what happened to Teams delivery?'],
 ['conversations','What notes relate to the speaker-ID export blocking task previews?'],
 ['helpers','Who has relevant experience with LiveKit speaker-ID exports?'],
 ['dependencies','Which existing task blocks my task preview?'],
 ['overlap','Does my proposed speaker-ID export duplicate accepted work?'],
 ['daily_brief','Summarize my saved notes and current blockers for today.'],
 ['catchup_brief','What changed in the saved meeting drafts while I was away?'],
 ['meeting_prep','What questions should we clarify about retention, video scope and speaker IDs?'],
];
console.log(JSON.stringify({liveCheck:'starting',model:config.summaryModel,maximumCalls:limit,manualCallsReserved:2,quotaPaused:before.quotaPaused}));
async function checkpoint(){await mkdir('data/ai-eval',{recursive:true});await writeFile('data/ai-eval/office-live-progress.json',JSON.stringify({timestamp:new Date().toISOString(),maximumCalls:limit,runs,usage:tracker.status()},null,2));}
try{
 await checkpoint();
 for(const [feature,prompt]of cases.slice(0,limit)){
  if(runs.length)await wait(15000);if(tracker.status().quotaPaused||tracker.status().localRequestsRemaining<=2)break;
  try{
   const output=await assistant.run(nathan,{feature,prompt,timeZone:'America/Denver',fromDate:feature==='catchup_brief'?yesterday:today,toDate:today},new AbortController().signal);
   const expectedKind=feature==='helpers'?'helper':feature==='dependencies'?'dependency':feature==='overlap'?'overlap':null;
   if(!output.items.length||expectedKind&&!output.items.some(i=>i.kind===expectedKind))throw new ProviderError('LIVE_EXPECTATION_MISSING');
   if(feature==='helpers'&&!output.items.some(i=>i.kind==='helper'&&i.personUserId===cameron.userId))throw new ProviderError('LIVE_OWNER_MISMATCH');
   runs.push({feature,status:'pass',output,semanticReviewStillRequired:true});await checkpoint();console.log(JSON.stringify({feature,status:'pass',items:output.items.length,latencyMs:output.latencyMs,usage:output.usage}));
  }catch(error){const code=error instanceof ProviderError||error instanceof UsageLimitError?error.code:error instanceof Error&&error.name==='ZodError'?'INVALID_OUTPUT':'LIVE_CHECK_FAILED';runs.push({feature,status:'failed',code});await checkpoint();console.log(JSON.stringify({feature,status:'failed',code}));process.exitCode=1;break;}
 }
 if(runs.length===8&&limit>=9&&runs.every(r=>r.status==='pass')&&!tracker.status().quotaPaused&&tracker.status().localRequestsRemaining>2){
  await wait(15000);const result=await runFixture(fixtures.find(f=>f.id==='commitments')!,'live');
  const failed=result.status!=='success'||!!(result.metrics&&(result.metrics.missedActions.length||result.metrics.inventedActions.length||result.metrics.ownershipErrors||result.metrics.deadlineErrors));runs.push({feature:'transcript-extraction',status:failed?'failed':'pass',result});console.log(JSON.stringify({feature:'transcript-extraction',status:failed?'failed':'pass',error:result.error,metrics:result.metrics}));if(failed)process.exitCode=1;
 }
 const after=tracker.status(),summary={timestamp:new Date().toISOString(),maximumCalls:limit,attemptedChecks:runs.length,passed:runs.filter(r=>r.status==='pass').length,failed:runs.filter(r=>r.status==='failed').length,skipped:9-runs.length,localRemaining:after.localRequestsRemaining,quotaPaused:after.quotaPaused,noAutomaticRetries:true,manualCallsReserved:2,realAudioTested:false};
 await mkdir('data/ai-eval',{recursive:true});await writeFile('data/ai-eval/latest-office-live.json',JSON.stringify({summary,before,after,runs},null,2));console.log(JSON.stringify(summary));if(!runs.length)process.exitCode=1;
}finally{tracker.close();storage.close();}
