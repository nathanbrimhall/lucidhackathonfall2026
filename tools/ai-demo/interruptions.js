export const presenceOptions=['available','away','meeting','dnd'];
export function shouldInterrupt(presence,allowImmediate){return presence==='available' && allowImmediate===true;}
const key='lucid-demo-interruptions-v1';
export function loadPreferences(storage){try{const data=JSON.parse(storage.getItem(key));if(data && presenceOptions.includes(data.presence)&&typeof data.allowImmediate==='boolean')return {presence:data.presence,allowImmediate:data.allowImmediate};}catch{}return {presence:'available',allowImmediate:false};}
if(typeof document!=='undefined'){
 const presence=document.getElementById('interrupt-presence'),allow=document.getElementById('interrupt-allow'),notice=document.getElementById('interrupt-notice'),inbox=document.getElementById('interrupt-inbox');
 let preferences;try{preferences=loadPreferences(localStorage);}catch{preferences={presence:'available',allowImmediate:false};}
 presence.value=preferences.presence;allow.checked=preferences.allowImmediate;
 const update=()=>{preferences={presence:presence.value,allowImmediate:allow.checked};try{localStorage.setItem(key,JSON.stringify(preferences));}catch{notice.textContent='Preferences apply for this session; browser storage is unavailable.';}};
 presence.onchange=update;allow.onchange=update;
 const add=(parent,tag,text)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
 function simulate(person='Cameron',topic='speaker identity mapping'){
  const card=document.createElement('article');card.className='action';add(card,'strong',`${person}: invitation to discuss ${topic}`);
  add(card,'p','Fictional invitation only. No person was contacted.');
  const dismiss=add(card,'button','Dismiss');dismiss.type='button';dismiss.onclick=()=>card.remove();inbox.prepend(card);
  if(shouldInterrupt(preferences.presence,preferences.allowImmediate))notice.textContent=`New demo invitation from ${person}. You can review it below.`;
  else notice.textContent='Invitation saved quietly. Review it when convenient.';
 }
 document.getElementById('simulate-invitation').onclick=()=>simulate();
 document.getElementById('clear-invitations').onclick=()=>{inbox.replaceChildren();notice.textContent='Demo inbox cleared.';};
 document.addEventListener('demo-helper-invitation',event=>simulate(event.detail.name,event.detail.topic));
}
