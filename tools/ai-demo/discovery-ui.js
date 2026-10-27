const root=document.getElementById('discovery');
const field=document.getElementById('discovery-interest');
const button=document.getElementById('discover-button');
const status=document.getElementById('discovery-status');
const results=document.getElementById('discovery-results');
const catalog=document.getElementById('discovery-catalog');
const add=(parent,tag,text)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
try {
  const response=await fetch('/api/discovery/conversations');if(!response.ok)throw new Error();
  const {conversations}=await response.json();
  for(const conversation of conversations){const details=document.createElement('details');add(details,'summary',conversation.title);add(details,'p',conversation.participants.join(', '));for(const excerpt of conversation.excerpts)add(details,'p',`[${excerpt.id}] ${excerpt.text}`);catalog.append(details);}
}catch{add(catalog,'p','Cannot load the fictional conversations. Restart the demo server and refresh.');}
button.onclick=async()=>{
  const interest=field.value.trim();
  if(interest.length<10){status.textContent='Describe what you are working on in at least 10 characters.';return;}
  button.disabled=true;status.textContent='Looking for relevant discussions with Gemini...';results.replaceChildren();
  try{
    const response=await fetch('/api/discovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({interest,mode:document.getElementById("discovery-mode").value})});
    const result=await response.json();if(!response.ok)throw new Error(result.error);
    for(const match of result.matches ?? []){
      const card=document.createElement('article');card.className='action';add(card,'h3',match.conversation.title);
      add(card,'p',`${match.conversation.participants.join(', ')} · ${new Date(match.conversation.time).toLocaleString()}`);
      add(card,'strong','Why this may help');add(card,'p',match.reason);
      for(const excerpt of match.evidence)add(card,'blockquote',`[${excerpt.id}] ${excerpt.text}`);
      const detail=document.createElement('details');add(detail,'summary','Read shared conversation');for(const excerpt of match.conversation.excerpts)add(detail,'p',excerpt.text);card.append(detail);results.append(card);
    }
    for(const helper of result.helpers ?? []){
      const card=document.createElement('article');card.className='action';add(card,'h3',helper.person.name);add(card,'p',`Stated focus: ${helper.person.skills}`);add(card,'p',helper.reason);add(card,'p',`Shared discussion: ${helper.conversation.title}`);
      for(const excerpt of helper.evidence)add(card,'blockquote',`[${excerpt.id}] ${excerpt.text}`);
      const draft=add(card,'details','');add(draft,'summary','Prepare a question');const label=add(draft,'label','Question draft (local only)');const input=add(label,'textarea',`Hi ${helper.person.name}, could you point me toward context for this question? ${interest}`);input.maxLength=2000;input.style.height='100px';
      add(draft,'p','This draft stays here. No message is sent.');
      const simulate=add(card,'button','Simulate an invitation in my inbox');simulate.type='button';simulate.onclick=()=>document.dispatchEvent(new CustomEvent('demo-helper-invitation',{detail:{name:helper.person.name,topic:interest}}));results.append(card);
    }
    const count=(result.matches ?? result.helpers ?? []).length;
    status.textContent=count?`${count} suggestions - ${result.model} - ${(result.latencyMs/1000).toFixed(1)} s. Check the supporting excerpts.`:'No relevant discussions found or no supported helper match. Try describing a different work problem.';
  }catch(error){
    const messages={QUOTA_EXCEEDED:'Google returned a quota error. Further calls are paused; check the usage panel.',QUOTA_PAUSED:'Gemini calls are paused after a quota error.',LOCAL_BUDGET_EXCEEDED:'The local daily request cap has been reached.',TIMEOUT:'Gemini timed out. No automatic retry was made.',SERVICE_UNAVAILABLE:'Gemini is temporarily unavailable. No automatic retry was made.',INVALID_OUTPUT:'The response could not be validated. No matches were displayed.'};
    status.textContent=error instanceof TypeError?'Cannot reach the local server. Start npm run ai:demo and refresh.':messages[error.message]??error.message;
  }finally{button.disabled=false;document.getElementById('refreshUsage').click();}
};
