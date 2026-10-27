const $=id=>document.getElementById(id);
const add=(parent,tag,text)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
let workspace=null,analysis=null,conversations=[],busy=false;
const errors={QUOTA_EXCEEDED:'Gemini quota error; requests are paused. Check the usage panel.',QUOTA_PAUSED:'Gemini requests are paused after a quota error.',LOCAL_BUDGET_EXCEEDED:'The local daily safety cap has been reached.',TIMEOUT:'The provider timed out; no automatic retry was made.',INVALID_OUTPUT:'The model output could not be validated. No workspace changes were made.',SERVICE_UNAVAILABLE:'Gemini is temporarily unavailable. No automatic retry was made.'};
const name=id=>workspace?.people.find(p=>p.id===id)?.name??id;
const task=id=>workspace?.tasks.find(t=>t.id===id);
async function api(path,body){const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;}
function tellError(error){$('panel-status').textContent=error instanceof TypeError?'Cannot reach the local server. Restart npm run ai:demo and refresh.':errors[error.message]??error.message;}
function lock(value){busy=value;for(const button of $('ai-panel').querySelectorAll('button'))button.disabled=value;$('panel-undo').disabled=value||!workspace?.canUndo;}
function renderWorkspace(){
 $('panel-tasks').replaceChildren();
 const ranks={critical:3,high:2,medium:1,low:0};
 const ordered=[...workspace.tasks].sort((a,b)=>(a.status==="open"?0:1)-(b.status==="open"?0:1)||ranks[b.coordination.priority]-ranks[a.coordination.priority]||b.coordination.count-a.coordination.count);
 for(const item of ordered){
  const card=add($('panel-tasks'),'article','');card.className='action';card.dataset.taskId=item.id;
  add(card,'strong',item.title);add(card,'p',`${name(item.ownerId)} | ${item.status} | project: ${item.project}`);
  add(card,'p',`Base priority: ${item.basePriority} | Coordination urgency: ${item.coordination.priority} | ${item.coordination.count} other people waiting`);
  if(item.coordination.count)add(card,'p',`Waiting: ${item.coordination.affectedPeople.map(name).join(', ')}`);
  if(item.dueAt)add(card,'p',`Due: ${new Date(item.dueAt).toLocaleString()}`);
  if(item.dependsOn.length)add(card,'p',`Depends on: ${item.dependsOn.map(id=>task(id)?.title??id).join('; ')}`);
  if(item.linkedTo)add(card,'p',`Linked to ${name(task(item.linkedTo)?.ownerId)}: ${task(item.linkedTo)?.title}`);
 }
 $('panel-notifications').replaceChildren();
 if(!workspace.notifications.length)add($('panel-notifications'),'p','No simulated owner notifications.');
 for(const notice of workspace.notifications){const card=add($('panel-notifications'),'article','');card.className='action';add(card,'strong',`Quiet demo inbox for ${name(notice.recipientId)}`);add(card,'p',notice.text);}
 $('panel-undo').disabled=busy||!workspace.canUndo;
}
function sources(parent,refs){for(const ref of refs){const conversation=conversations.find(c=>c.id===ref.conversationId);const excerpt=conversation?.excerpts.find(e=>e.id===ref.excerptId);add(parent,'blockquote',`${conversation?.title??ref.conversationId} [${ref.excerptId}]: ${excerpt?.text??'Evidence unavailable'}`);}}
async function review(kind,index){
 if(busy||!analysis)return;lock(true);
 try{const result=await api('/api/workspace/review',{analysisId:analysis.id,expectedRevision:analysis.revision,kind,index});workspace=result.workspace;analysis=null;renderWorkspace();$('panel-results').replaceChildren();$('panel-status').textContent=result.description+'. Changes affect only this fictional workspace. Undo is available. Run again for fresh suggestions.';}
 catch(error){tellError(error);}finally{lock(false);}
}
function renderAnalysis(result){
 analysis=result.analysis;workspace=result.workspace;renderWorkspace();$('panel-results').replaceChildren();
 if(analysis.dependencies.length){const button=add($('panel-results'),'button','Confirm all reviewed dependencies');button.type='button';button.onclick=()=>void review('dependency_all',0);}
 analysis.dependencies.forEach((finding,index)=>{
  const card=add($('panel-results'),'article','');card.className='action';card.dataset.finding='dependency';add(card,'h3',`${task(finding.blockedTaskId)?.title} needs ${task(finding.blockerTaskId)?.title}`);add(card,'p',finding.reason);
  const impact=analysis.dependencyImpact[index];add(card,'p',`If all suggestions are confirmed: ${name(task(impact.taskId)?.ownerId)}'s task has ${impact.suggested.count} distinct people waiting; coordination urgency ${impact.current.priority} → ${impact.suggested.priority}. Base priority and deadline stay visible.`);
  sources(card,finding.sources);const button=add(card,'button','Confirm this dependency');button.type='button';button.onclick=()=>void review('dependency',index);
 });
 analysis.overlaps.forEach((finding,index)=>{
  const card=add($('panel-results'),'article','');card.className='action';card.dataset.finding='overlap';add(card,'h3','Possible duplicate work');add(card,'p',`Proposed: ${task(finding.proposedTaskId)?.title} (${name(task(finding.proposedTaskId)?.ownerId)})`);add(card,'p',`Existing: ${task(finding.existingTaskId)?.title} (${name(task(finding.existingTaskId)?.ownerId)})`);add(card,'p',finding.reason);sources(card,finding.sources);
  add(card,'p',`If this is the same work, coordinate with ${name(task(finding.existingTaskId)?.ownerId)}. Linking keeps the existing owner, avoids adding a second active task, recalculates urgency and creates a simulated quiet-inbox notice.`);
  const link=add(card,'button','Confirm duplicate and link');link.type='button';link.onclick=()=>void review('overlap',index);
  const separate=add(card,'button','Keep as separate task');separate.type='button';separate.onclick=()=>void review('keep_separate',index);
 });
 if(!analysis.dependencies.length&&!analysis.overlaps.length)add($('panel-results'),'p','No new supported suggestions.');
 $('panel-status').textContent=result.mode==='replay'?'OFFLINE REFERENCE: fixed speaker-export scenario, not interpretation of your text or AI accuracy. Review before applying.':`Gemini suggestions ready (${result.model}, ${(result.latencyMs/1000).toFixed(1)} s). Nothing has changed. Check evidence, then confirm.`;
}
function renderSearch(response){
 analysis=null;$('panel-results').replaceChildren();const result=response.result;
 for(const match of result.matches??[]){const card=add($('panel-results'),'article','');card.className='action';add(card,'h3',match.conversation.title);add(card,'p',match.reason);for(const e of match.evidence)add(card,'blockquote',e.text);}
 for(const helper of result.helpers??[]){const card=add($('panel-results'),'article','');card.className='action';add(card,'h3',helper.person.name);add(card,'p',helper.person.skills);add(card,'p',helper.reason);for(const e of helper.evidence)add(card,'blockquote',e.text);}
 $('panel-status').textContent=(result.matches??result.helpers??[]).length?`Suggestions from ${result.model}. Check the excerpts; nobody was contacted.`:'No supported matches found.';
}
const knowledgeFeatures=['decisions','daily_brief','catchup_brief','meeting_prep'];
function updateKnowledgeControls(){const feature=$('panel-feature').value;$('panel-knowledge-options').hidden=!knowledgeFeatures.includes(feature);if(feature==='daily_brief')$('panel-from').value=$('panel-to').value;}
$('panel-feature').onchange=updateKnowledgeControls;
$('panel-to').onchange=()=>{if($('panel-feature').value==='daily_brief')$('panel-from').value=$('panel-to').value;};
$('panel-from').onchange=()=>{if($('panel-feature').value==='daily_brief')$('panel-to').value=$('panel-from').value;};
function renderKnowledge(response){
 analysis=null;$('panel-results').replaceChildren();const {content,context}=response;
 const meta=add($('panel-results'),'p',`Read-only fictional context through ${context.window.toDate} (${context.window.timeZone}). Brief record window: ${context.window.fromDate} through ${context.window.toDate}.`);meta.className='muted';
 const cite=(parent,item)=>{
  for(const id of item.recordIds){const record=context.records.find(r=>r.id===id);add(parent,'p',`Record: ${record?.text??id} | ${record?.status??'unknown'} | ${record?.createdAt??''}`);}
  for(const id of item.taskIds){const current=context.currentTasks.find(t=>t.id===id);add(parent,'p',`Current task: ${current?.title??id} | owner ${name(current?.ownerId)} | ${current?.status??''}. Not a historical change record.`);}
  for(const ref of item.sources){const source=context.sources.find(s=>s.id===ref.conversationId);const excerpt=source?.excerpts.find(e=>e.id===ref.excerptId);add(parent,'blockquote',`${source?.title??ref.conversationId} [${ref.excerptId}]: ${excerpt?.text??'Evidence unavailable'}`);}
 };
 if(content.status)add($('panel-results'),'h3',`Evidence status: ${content.status.replaceAll('_',' ')}`);
 const entries=content.claims??content.highlights??content.agenda??[];
 for(const item of entries){
  const card=add($('panel-results'),'article','');card.className='action';card.dataset.knowledgeResult='true';
  if(item.kind){card.dataset.claimKind=item.kind;add(card,'strong',item.kind.replaceAll('_',' '));add(card,'p',item.text);}
  else{card.dataset.agenda='true';add(card,'h3',item.title);add(card,'p',`Proposed question: ${item.question}`);add(card,'p',`Desired outcome: ${item.desiredOutcome}`);}
  cite(card,item);
 }
 if(!entries.length)add($('panel-results'),'p',response.feature==='meeting_prep'?'No supported agenda items in this context.':'No supported records match this request or date window.');
 for(const question of content.questions??content.followUpQuestions??[]){
  const card=add($('panel-results'),'div','');add(card,'p',`Follow-up question: ${question}`);const button=add(card,'button','Ask this question');button.type='button';button.onclick=()=>{$('panel-feature').value='decisions';$('panel-prompt').value=question;updateKnowledgeControls();$('panel-prompt').focus();$('panel-status').textContent='Follow-up prepared. Submit to ask; no AI call has been made.';};
 }
 const details=add($('panel-results'),'details','');add(details,'summary','Inspect the authorized history used for this result');for(const record of context.records)add(details,'p',`${record.id}: ${record.text} (${record.status})`);
 $('panel-status').textContent=response.mode==='replay'?'OFFLINE REFERENCE: filtered fictional history, not interpretation of your question or model accuracy. No workspace changes were made.':`Gemini answer ready (${response.model}, ${(response.latencyMs/1000).toFixed(1)} s). Check the sources. No decisions, tasks or meetings were changed.`;
}
$('panel-form').onsubmit=async event=>{
 event.preventDefault();if(busy)return;const prompt=$('panel-prompt').value.trim();if(prompt.length<10){$('panel-status').textContent='Describe your work in at least 10 characters.';return;}
 lock(true);$('panel-status').textContent='Analyzing your request...';analysis=null;$('panel-results').replaceChildren();
 try{
  const feature=$('panel-feature').value;
  const result=await api('/api/ai-panel',{prompt,feature,mode:$('panel-mode').value,...(knowledgeFeatures.includes(feature)?{viewerId:$('panel-viewer').value,role:$('panel-role').value,includeProjectContext:$('panel-project-context').checked,fromDate:$('panel-from').value,toDate:$('panel-to').value,timeZone:$('panel-timezone').value}:{})});
  if(result.analysis)renderAnalysis(result);else if(result.content)renderKnowledge(result);else renderSearch(result);
 }catch(error){tellError(error);}finally{lock(false);$('refreshUsage').click();}
};
const examples={dependencies:'What work is blocked by the speaker-ID export, and whose task should be prioritized?',overlap:'Check whether my proposed speaker-ID export duplicates work already owned by someone else.',conversations:'I need to identify who said what so we can assign tasks.',helpers:'Who could help me connect speaker IDs to participants?',decisions:'Was video actually approved, and what was the recorded reason for the demo scope?',daily_brief:'Give me a daily brief of decisions, assumptions and unresolved questions.',catchup_brief:'What did I miss while away? Include changed decisions and unanswered questions.',meeting_prep:'Prepare a design meeting agenda to clarify scope, privacy assumptions and open decisions.'};
for(const button of document.querySelectorAll('[data-panel-feature]'))button.onclick=()=>{const feature=button.dataset.panelFeature;$('panel-feature').value=feature;updateKnowledgeControls();if(feature==='catchup_brief'){$('panel-from').value='2026-10-23';$('panel-to').value='2026-10-26';}$('panel-prompt').value=examples[feature];$('panel-prompt').focus();$('panel-status').textContent='Action selected. Submit when ready; selecting an option does not make an AI call.';};
$('panel-undo').onclick=async()=>{if(busy||!workspace)return;lock(true);try{const result=await api('/api/workspace/undo',{expectedRevision:workspace.revision});workspace=result.workspace;analysis=null;$('panel-results').replaceChildren();renderWorkspace();$('panel-status').textContent=result.description+'. Any earlier analysis is now stale.';}catch(error){tellError(error);}finally{lock(false);}};
$('panel-refresh').onclick=async()=>{if(busy)return;lock(true);try{const data=await api('/api/workspace');workspace=data;conversations=data.conversations;analysis=null;$('panel-results').replaceChildren();renderWorkspace();$('panel-status').textContent='Workspace refreshed. No AI call was made.';}catch(error){tellError(error);}finally{lock(false);}};
try{const data=await api('/api/workspace');workspace=data;conversations=data.conversations;renderWorkspace();}catch(error){tellError(error);}
