import { renderReview, hasUnsavedReviewChanges } from '/review.js';
const $ = id => document.getElementById(id);
let fixtures = [], currentJob;
const status = text => { $('status').textContent = text; };
async function refreshUsage() {
  try {
    const response=await fetch('/api/usage');const usage=await response.json();
    $('usageStatus').textContent=!usage.configured?usage.message:usage.quotaPaused
      ?'Google returned a quota error. Live calls are paused. '+(usage.blockedUntil?'Retry-after time: '+new Date(usage.blockedUntil).toLocaleString():'Google did not supply a reset time. Check AI Studio before clearing the local pause.')
      :usage.localRequestsRemaining===0?'Local daily safety cap reached. This does not establish that Google quota is exhausted.':'No Google quota error is currently blocking this project.';
    $('usageCounts').textContent=usage.configured?JSON.stringify({localDayUtc:usage.localDayUtc,trackedAttempts:usage.today.attempts,knownReportedTokens:usage.today.totalTokens,attemptsWithUnknownTokens:usage.today.requestsWithUnknownTokens,quotaErrors:usage.today.quotaErrors,localDailyRequestLimit:usage.localDailyRequestLimit,localRequestsRemaining:usage.localRequestsRemaining,googleRequestsRemaining:'Unknown',lastRequestError:usage.lastError},null,2):'';
    $('retryQuota').hidden=!usage.quotaPaused;
  }catch{$('usageStatus').textContent='Usage tracking is unavailable. Restart the demo server to load the latest version.';}
}
$('refreshUsage').onclick=refreshUsage;
$('retryQuota').onclick=async()=>{
  try{const response=await fetch('/api/usage/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error();await refreshUsage();}
  catch{$('usageStatus').textContent='Cannot reach the local usage tracker.';}
};
void refreshUsage();setInterval(()=>{if(!document.hidden)void refreshUsage();},10000);
function populateReviewers(job) {
  if(!Array.isArray(job.context?.participants))return;
  const previous=$('reviewer').value;$('reviewer').replaceChildren();
  for(const person of job.context.participants){const option=document.createElement('option');option.value=person.userId;option.textContent=person.displayName;$('reviewer').append(option);}
  if([...$('reviewer').options].some(option=>option.value===previous))$('reviewer').value=previous;
}
function show() {
  const fixture=fixtures.find(f=>f.id===$('fixture').value);if(!fixture)return;
  $('description').textContent=fixture.description;$('job').value=JSON.stringify(fixture.job,null,2);populateReviewers(fixture.job);
}
try {
  const response=await fetch('/api/fixtures');if(!response.ok)throw new Error();
  fixtures=(await response.json()).fixtures;
  for(const fixture of fixtures){const option=document.createElement('option');option.value=fixture.id;option.textContent=fixture.id;$('fixture').append(option);}
  show();
}catch{status('Cannot load the local demo. Start npm run ai:demo and refresh this page.');$('run').disabled=true;}
$('fixture').onchange=show;$('reset').onclick=show;
$('job').addEventListener('change',()=>{try{populateReviewers(JSON.parse($('job').value));}catch{/* Run reports invalid JSON without erasing the editor. */}});
$('mode').onchange=()=>{$('run').textContent=$('mode').value==='live'?'Extract with Gemini':'Run offline replay';};
$('run').onclick=async()=>{
  if(hasUnsavedReviewChanges()){status('Save or reset unsaved review edits before generating another set of notes.');return;}
  $('run').disabled=true;status('Running...');
  try {
    currentJob=JSON.parse($('job').value);
    const reviewerUserId=$('reviewer').value;
    if(!Array.isArray(currentJob?.context?.participants)||!currentJob.context.participants.some(person=>person.userId===reviewerUserId))throw new Error('Choose a reviewer from the current conversation participants.');
    const response=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixtureId:$('fixture').value,mode:$('mode').value,reviewerUserId,job:currentJob})});
    const result=await response.json();if(!response.ok)throw new Error(result.error);
    $('raw').textContent=JSON.stringify(result,null,2);
    $('resultMode').textContent=result.mode==='replay'?'OFFLINE REFERENCE - not model evaluation':`LIVE GEMINI - ${result.model}`;
    if(result.status!=='success'){
      const hints={QUOTA_PAUSED:'Live calls are paused after a quota error. Check the usage panel.',LOCAL_BUDGET_EXCEEDED:'The local daily safety cap has been reached.',QUOTA_EXCEEDED:'Quota/rate-limit error. No automatic retry was made.',SERVICE_UNAVAILABLE:'Google is temporarily unavailable. Try again later.',MODEL_UNAVAILABLE:'Update AI_SUMMARY_MODEL in .env to an available Gemini model and restart.',AUTH_FAILED:'Check GEMINI_API_KEY and its Google project permissions.',INVALID_REQUEST:'Google rejected the request settings.',INVALID_OUTPUT:'The model response failed validation. No proposals were created.',TimeoutError:'The provider timed out.'};
      status('Run failed: '+result.error.code+'. '+(hints[result.error.code]??'Check local provider configuration or try again later.'));
      $('metrics').textContent='Provider/extraction failure recorded; accuracy was not scored.';return;
    }
    renderReview(result.followups);$('actions').replaceChildren();$('notes').replaceChildren();
    const add=(parent,tag,text)=>{const element=document.createElement(tag);element.textContent=text;parent.append(element);return element;};
    for(const item of result.notes.actionItems){
      const card=document.createElement('div');card.className='action';add(card,'strong',item.text);
      const owner=currentJob.context.participants.find(person=>person.userId===item.ownerUserId);
      add(card,'p',`Owner: ${owner?.displayName??'Unassigned'} - Due: ${item.dueAt??'Not specified'}`);
      for(const id of item.segmentIds){const segment=currentJob.segments.find(segment=>segment.id===id);add(card,'p',`[${id}] ${segment?.text??''}`);}
      $('actions').append(card);
    }
    if(!result.notes.actionItems.length)add($('actions'),'p','No committed actions extracted.');
    for(const [kind,claims] of [['Summary',result.notes.summary],['Decision',result.notes.decisions]])for(const claim of claims)add($('notes'),'p',`${kind}: ${claim.text}`);
    $('metrics').textContent=JSON.stringify({latencyMs:result.latencyMs,usage:result.usage,cost:result.cost,accuracy:result.metrics,noteCoverage:result.noteCoverage,liveCallsRemaining:result.liveCallsRemaining},null,2);
    status(result.mode==='replay'?'Reference replay complete. Select live mode to test Gemini.':'Draft ready for review. Nothing was sent or created.');
  }catch(error){status(error instanceof TypeError?'Cannot reach the local demo server. Run scripts/start-ai-demo.cmd (or npm run ai:demo in a terminal you keep open), then refresh this page. Your transcript is still in the editor.':error.message);}
  finally{$('run').disabled=false;await refreshUsage();}
};
