import {expect,it,vi} from 'vitest';
import {createRefreshQueue,readOfficeView} from '../refresh.js';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}

it('keeps tasks, inbox and usage current with one background read, without fetching hidden private panels',async()=>{
 const data={tasks:[{id:'t1',title:'Export IDs'}],messages:[{id:'m1',body:'Ready'}],notifications:[],assistantUsage:{today:{attempts:3}}};
 const api=vi.fn(async(path:string)=>{if(path!=='/api/collaboration')throw new Error('Unexpected private-data fetch');return data;});
 const result=await readOfficeView(api,'office');
 expect(api).toHaveBeenCalledTimes(1);expect(result.data).toEqual(data);expect(result.notes).toBeUndefined();expect(result.reminders).toBeUndefined();
});

it('loads fresh visible notes and reminders when opening their panels',async()=>{
 let note='Earlier note',reminder='Earlier reminder';
 const api=vi.fn(async(path:string)=>path==='/api/notes'?{notes:[note]}:path==='/api/reminders'?{reminders:[reminder]}:{tasks:[]});
 expect((await readOfficeView(api,'notes')).notes).toEqual(['Earlier note']);
 expect(api.mock.calls.map(([path])=>path)).not.toContain('/api/reminders');
 note='Newly saved note';reminder='New reminder';api.mockClear();
 expect((await readOfficeView(api,'notes')).notes).toEqual(['Newly saved note']);
 expect(api).toHaveBeenCalledTimes(2);api.mockClear();
 const current=await readOfficeView(api,'reminders');expect(current.reminders).toEqual(['New reminder']);expect(current.notes).toBeUndefined();
 expect(api.mock.calls.map(([path])=>path)).not.toContain('/api/notes');
});

it('merges simultaneous refresh triggers into one read',async()=>{
 const read=vi.fn(async(_force:boolean)=>{}),refresh=createRefreshQueue(read);
 await Promise.all([refresh(),refresh(true),refresh(true),refresh()]);
 expect(read).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalledWith(true);
});

it('queues one follow-up for writes arriving during an active read, preserving the updated data',async()=>{
 const started=deferred(),release=deferred();let revision=0,visible=-1,active=0,peak=0;
 const read=vi.fn(async(_force:boolean)=>{active++;peak=Math.max(peak,active);const snapshot=revision;
  if(read.mock.calls.length===1){started.resolve();await release.promise;}
  visible=snapshot;active--;
 });
 const refresh=createRefreshQueue(read),initial=refresh();await started.promise;
 revision=1;const followups=Array.from({length:10},()=>refresh(true));release.resolve();
 await Promise.all([initial,...followups]);
 expect(read).toHaveBeenCalledTimes(2);expect(read.mock.calls).toEqual([[false],[true]]);expect(visible).toBe(1);expect(peak).toBe(1);
});

it('does not schedule another read for overlapping polling ticks',async()=>{
 const started=deferred(),release=deferred();
 const read=vi.fn(async()=>{started.resolve();await release.promise;}),refresh=createRefreshQueue(read);
 const first=refresh();await started.promise;const ticks=Array.from({length:10},()=>refresh());release.resolve();
 await Promise.all([first,...ticks]);expect(read).toHaveBeenCalledTimes(1);
});

it('allows a later refresh after a failed read without leaving the queue stuck',async()=>{
 const read=vi.fn(async(_force:boolean)=>{}).mockRejectedValueOnce(new Error('Temporary read failure'));
 const refresh=createRefreshQueue(read);await expect(refresh(true)).rejects.toThrow('Temporary read failure');
 await refresh(true);expect(read).toHaveBeenCalledTimes(2);
});
