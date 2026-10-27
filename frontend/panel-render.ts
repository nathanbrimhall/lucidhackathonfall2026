/** Preserve a pressed control until its click is dispatched. */
export function createPanelRenderer(document:Document,paint:()=>void){
 let pressedPointer:number|undefined,queued=false,releaseTimer:ReturnType<typeof setTimeout>|undefined;
 const flush=()=>{if(pressedPointer===undefined&&queued){queued=false;paint();}};
 const release=(pointer=pressedPointer)=>{
  if(pointer!==pressedPointer)return;
  pressedPointer=undefined;if(releaseTimer!==undefined)clearTimeout(releaseTimer);releaseTimer=undefined;
  // Wait for the complete click, including the browser's default form submission.
  setTimeout(flush,0);
 };
 document.addEventListener('pointerdown',event=>{
  if(event.button!==0||!(event.target instanceof Element)||!event.target.closest('#side,#modal-root'))return;
  if(releaseTimer!==undefined)clearTimeout(releaseTimer);
  pressedPointer=event.pointerId;
 },true);
 document.addEventListener('click',()=>release(),true);
 document.addEventListener('pointerup',event=>{
  if(event.pointerId!==pressedPointer)return;const pointer=event.pointerId;
  // A canceled/dragged gesture may have no click; do not leave rendering paused.
  releaseTimer=setTimeout(()=>release(pointer),0);
 },true);
 document.addEventListener('pointercancel',event=>release(event.pointerId),true);
 document.defaultView?.addEventListener('blur',()=>release());
 return function render(){if(pressedPointer!==undefined){queued=true;return;}queued=false;paint();};
}
