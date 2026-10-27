let bundle = null;
const dirty = new Set();
let busy = false;
const $ = id => document.getElementById(id);
function announce(text) { $('reviewStatus').textContent = text; }
function errorMessage(error) { return error instanceof TypeError ? "Cannot reach the local demo server. Your unsaved edits are still here. Restart the demo and try saving again." : error.message; }
function node(tag, text, className) { const element = document.createElement(tag); if(text) element.textContent=text;if(className) element.className=className;return element; }
function name(id) { return bundle.participants.find(p=>p.userId===id)?.displayName ?? 'Choose a participant'; }
function updateControls() {
  const approved = bundle?.proposals.filter(p=>p.status==='approved').length ?? 0;
  $('exportApproved').disabled = !approved || dirty.size>0 || busy;
  $('loadReview').disabled = dirty.size>0 || busy;
  $('reviewSummary').textContent = bundle ? `${approved} approved / ${bundle.proposals.length} proposals. ${dirty.size ? 'Unsaved edits: save or reset before exporting or loading another review.' : 'Approved items are saved locally. Nothing has been sent or created in another app.'}` : 'Generate notes to create message and task proposals.';
}
export function hasUnsavedReviewChanges() { return dirty.size>0 || busy; }
export async function refreshReviewHistory() {
  try {
    const response=await fetch('/api/reviews'); if(!response.ok) return;
    const data=await response.json(); const select=$('savedReviews');const previous=select.value;select.replaceChildren();
    for(const review of data.reviews){const option=node('option',`${new Date(review.createdAt).toLocaleString()} - ${review.approved}/${review.proposals} approved`);option.value=review.id;select.append(option);}
    if([...select.options].some(option=>option.value===previous))select.value=previous;
    if(bundle && [...select.options].some(option=>option.value===bundle.id))select.value=bundle.id;
  } catch { /* Current review remains visible when history is unavailable. */ }
}
export function renderReview(value) {
  bundle=value;dirty.clear();$('reviewProposals').replaceChildren();
  if(bundle)for(const proposal of bundle.proposals)$('reviewProposals').append(renderCard(proposal));
  announce(bundle ? `Reviewing as ${name(bundle.reviewerUserId)}. Message wording comes from the extracted actions; no extra Gemini call.` : '');
  updateControls();void refreshReviewHistory();
}
function localDateValue(iso) {
  if(!iso)return '';
  const date=new Date(iso);const pad=n=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function renderCard(proposal) {
  const card=node('article',null,'proposal');card.dataset.proposalId=proposal.id;card.dataset.proposalKind=proposal.kind;
  const heading=node('div',null,'proposal-heading');heading.append(node('strong',proposal.kind==='message'?'Message draft':'Task proposal'),node('span',proposal.status,'badge'));card.append(heading);
  if(proposal.kind==='message')card.append(node('p',`From: ${name(proposal.senderUserId)}. Recipient suggestions refer to this conversation's participants; no Slack or Teams account is connected.`,'muted'));
  const personLabel=node('label',proposal.kind==='message'?'To':'Owner');const select=node('select');select.setAttribute('aria-label',proposal.kind==='message'?'Message recipient':'Task owner');
  const empty=node('option','Choose a participant');empty.value='';select.append(empty);
  for(const participant of bundle.participants){if(proposal.kind==='message' && participant.userId===proposal.senderUserId)continue;const option=node('option',`${participant.displayName} (${participant.userId})`);option.value=participant.userId;select.append(option);}
  select.value=(proposal.kind==='message'?proposal.recipientUserId:proposal.ownerUserId)??'';personLabel.append(select);card.append(personLabel);
  const contentLabel=node('label',proposal.kind==='message'?'Message':'Task title');const content=node(proposal.kind==='message'?'textarea':'input');content.setAttribute('aria-label',proposal.kind==='message'?'Message body':'Task title');content.value=proposal.kind==='message'?proposal.body:proposal.title;content.maxLength=proposal.kind==='message'?6000:4000;content.required=true;contentLabel.append(content);card.append(contentLabel);
  let due;
  if(proposal.kind==='task'){const label=node('label','Due (your local time, optional)');due=node('input');due.type='datetime-local';due.max='9999-12-31T23:59';due.setAttribute('aria-label','Task due date');due.value=localDateValue(proposal.dueAt);label.append(due);card.append(label);}
  const evidence=node('details');evidence.append(node('summary','Conversation evidence'));
  for(const id of proposal.sourceSegmentIds){const source=bundle.sources.find(s=>s.id===id);evidence.append(node('p',`[${id}] ${source?name(source.speakerUserId)+': '+source.text:'Source unavailable'}`,'evidence'));}card.append(evidence);
  const changed=()=>{dirty.add(proposal.id);heading.lastChild.textContent='unsaved edits';updateControls();};
  for(const input of [select,content,...(due?[due]:[])]){input.disabled=proposal.status==='discarded';input.addEventListener('input',changed);input.addEventListener('change',changed);}
  const controls=node('div',null,'proposal-controls');
  const button=(text,action)=>{const element=node('button',text);element.type='button';element.onclick=action;controls.append(element);return element;};
  async function mutate(action) {
    if(busy)return;
    const payload={expectedRevision:proposal.revision,action};
    if(action==='save'||action==='approve') {
      if(!content.reportValidity() || (due && !due.reportValidity()))return;
      if(action==='approve'&&!select.value){announce(proposal.kind==='message'?'Choose a recipient before approving.':'Choose a task owner before approving.');select.focus();return;}
      payload.changes=proposal.kind==='message'?{kind:'message',recipientUserId:select.value||null,body:content.value}:{kind:'task',ownerUserId:select.value||null,title:content.value,dueAt:due.value===localDateValue(proposal.dueAt)?proposal.dueAt:due.value?new Date(due.value).toISOString():null};
    }
    busy=true;updateControls();
    for(const element of document.querySelectorAll('#reviewProposals button'))element.disabled=true;
    for(const element of card.querySelectorAll('input,select,textarea'))element.disabled=true;
    try {
      const response=await fetch(`/api/reviews/${encodeURIComponent(bundle.id)}/proposals/${encodeURIComponent(proposal.id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      bundle=result;dirty.delete(proposal.id);card.replaceWith(renderCard(bundle.proposals.find(p=>p.id===proposal.id)));
      announce(action==='approve'?'Approved locally. Nothing was sent or created in another app.':action==='save'?'Edits saved. This item needs approval before export.':action==='discard'?'Proposal discarded. You can restore it.':'Proposal restored as a draft.');
      void refreshReviewHistory();
    } catch(error){announce(errorMessage(error));for(const element of card.querySelectorAll('input,select,textarea'))element.disabled=proposal.status==='discarded';}
    finally {busy=false;for(const element of document.querySelectorAll('#reviewProposals button'))element.disabled=false;updateControls();}
  }
  if(proposal.status==='discarded')button('Restore',()=>mutate('restore'));
  else {
    button('Save edits',()=>mutate('save'));
    button('Approve',()=>mutate('approve'));
    button('Discard',()=>mutate('discard'));
    button('Reset edits',()=>{dirty.delete(proposal.id);card.replaceWith(renderCard(bundle.proposals.find(p=>p.id===proposal.id)));updateControls();});
  }
  card.append(controls);return card;
}
$('loadReview').onclick=async()=>{
  if(hasUnsavedReviewChanges()||!$('savedReviews').value)return;
  try{const response=await fetch(`/api/reviews/${encodeURIComponent($('savedReviews').value)}`);const result=await response.json();if(!response.ok)throw new Error(result.error);renderReview(result);}catch(error){announce(errorMessage(error));}
};
$('exportApproved').onclick=async()=>{
  if(!bundle||hasUnsavedReviewChanges())return;
  try{const response=await fetch(`/api/reviews/${encodeURIComponent(bundle.id)}/export`);if(!response.ok)throw new Error('Could not export this review.');const blob=await response.blob();const url=URL.createObjectURL(blob);const anchor=node('a');anchor.href=url;anchor.download='approved-followups.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);announce('Approved items exported as JSON. Nothing was sent or created in another app.');}catch(error){announce(errorMessage(error));}
};
updateControls();void refreshReviewHistory();
