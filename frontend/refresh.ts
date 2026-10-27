/** Merge concurrent refreshes; a write during a read queues one fresh follow-up. */
export function createRefreshQueue(read:(force:boolean)=>Promise<void>){
 let running:Promise<void>|undefined,again=false,forced=false;
 return function refresh(force=false):Promise<void>{
  forced ||= force;
  if(running){if(force)again=true;return running;}
  running=Promise.resolve().then(async()=>{
   try{
    do{again=false;const force=forced;forced=false;await read(force);}while(again);
   }finally{running=undefined;}
  });
  return running;
 };
}

/** Keep shared work current; request private detail only for its visible panel. */
export async function readOfficeView(api:(path:string)=>Promise<any>,panel:string){
 const [data,n,r]=await Promise.all([
  api('/api/collaboration'),
  panel==='notes'?api('/api/notes'):Promise.resolve(null),
  panel==='reminders'?api('/api/reminders'):Promise.resolve(null),
 ]);
 return {data,notes:n?.notes,reminders:r?.reminders};
}
