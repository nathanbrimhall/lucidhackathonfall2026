import {afterEach,expect,it,vi} from "vitest";
import {createApplication} from "../src/app.config.js";
import {loadConfig} from "../src/config.js";
import {LiveKitService} from "../src/services/LiveKitService.js";
const testEnv={PUBLIC_SERVER_URL:"http://localhost:2567",ALLOWED_ORIGINS:"http://localhost:2567",SESSION_SECRET:"test-only-session-secret-at-least-32-characters",DATABASE_URL:":memory:",GUEST_INVITE_CODE:"test-invite-code",OFFICE_ID:"demo-office",LIVEKIT_INTERNAL_URL:"http://127.0.0.1:1",LIVEKIT_PUBLIC_URL:"ws://127.0.0.1:1",LIVEKIT_API_KEY:"testkey",LIVEKIT_API_SECRET:"test-only-livekit-secret-at-least-32-characters"};
let app:ReturnType<typeof createApplication>|undefined;
afterEach(async()=>{if(app){await app.stop();app=undefined;}});
it("serves the integrated office and authenticates collaboration writes and source access",async()=>{
 const config=loadConfig({...testEnv,OFFICE_LAYOUT:"prototype"});const media=new LiveKitService(config,{backend:{issueToken:vi.fn(async()=>"test-token"),removeParticipant:vi.fn(async()=>{}),deleteRoom:vi.fn(async()=>{}),verifyWebhook:vi.fn(async()=>{throw new Error("unused");})}});
 app=createApplication(config,{},media,{assistantEnv:{}});const port=await app.start(0),base=`http://127.0.0.1:${port}`;
 const post=(path:string,body:unknown,token?:string)=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
 expect((await fetch(base)).status).toBe(200);expect(await(await fetch(base)).text()).toContain('LIVE OFFICE');
 expect((await fetch(base+'/api/collaboration')).status).toBe(401);expect((await(await fetch(base+'/api/demo')).json()).enabled).toBe(false);expect((await post('/api/demo/session',{userId:'fake'})).status).toBe(404);
 const a=await(await post('/api/sessions/guest',{displayName:'Nathan',inviteCode:config.inviteCode})).json(),b=await(await post('/api/sessions/guest',{displayName:'Cameron',inviteCode:config.inviteCode})).json();
 const task=await(await post('/api/collaboration/tasks',{requestId:'task-1',title:'Export IDs',ownerUserId:b.userId},a.token)).json();expect(task.status).toBe('proposed');
 const patch=(token:string)=>fetch(base+'/api/collaboration/tasks/'+task.id,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({revision:1,status:'open'})});
 expect((await patch(a.token)).status).toBe(403);expect((await patch(b.token)).status).toBe(200);
 const state=await(await fetch(base+'/api/collaboration',{headers:{Authorization:`Bearer ${a.token}`}})).json();expect(state.tasks[0].status).toBe('open');expect(state.directory).toHaveLength(2);expect(state.profile.allowInterrupt).toBe(false);
 expect((await post('/api/assistant',{feature:'decisions',prompt:'What was decided?'},a.token)).status).toBe(503);
 expect((await post('/api/collaboration/drafts',{noteId:'not-readable',body:'Hi',recipientUserId:b.userId},a.token)).status).toBe(404);
});
it("keeps demo persona login out of production and isolates seeded private notes",async()=>{
 const config=loadConfig({...testEnv,OFFICE_LAYOUT:'prototype'});const backend={issueToken:vi.fn(async()=>"test-token"),removeParticipant:vi.fn(async()=>{}),deleteRoom:vi.fn(async()=>{}),verifyWebhook:vi.fn(async()=>{throw new Error("unused");})};
 app=createApplication(config,{},new LiveKitService(config,{backend}),{manualDemo:true,assistantEnv:{}});const base=`http://127.0.0.1:${await app.start(0,'127.0.0.1')}`;
 const demo=await(await fetch(base+'/api/demo')).json();expect(demo.enabled).toBe(true);expect(demo.users).toHaveLength(3);expect(JSON.stringify(demo)).not.toContain('token');
 for(const user of demo.users){const response=await fetch(base+'/api/demo/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user.userId})});expect(response.status).toBe(200);const session=await response.json();const notes=await(await fetch(base+'/api/notes',{headers:{Authorization:'Bearer '+session.token}})).json();expect(notes.notes).toHaveLength(user.displayName==='Demo Maya'?0:2);}
 const unknown=await fetch(base+'/api/demo/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:'invented-person'})});expect(unknown.status).toBe(404);
});
