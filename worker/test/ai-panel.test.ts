import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createDemoApp } from "../../tools/ai-demo/app.js";
import { referenceDependencies, referenceOverlap } from "../../tools/ai-demo/coordination.js";
const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}});
async function start(options:Parameters<typeof createDemoApp>[0]={}){
 const app=createDemoApp({env:{},cooldownMs:0,reviewDatabase:":memory:",...options});const server=app.listen(0,"127.0.0.1");server.once("close",()=>app.locals.close());servers.push(server);await new Promise<void>(done=>server.once("listening",done));const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;
 return {url,post:(path:string,body:unknown,origin=url)=>fetch(url+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)})};
}
const prompt={prompt:"What tasks are waiting on the speaker-ID export?",feature:"dependencies",mode:"replay"};
const env={AI_PROVIDER:"gemini",GEMINI_API_KEY:"fictional-key",AI_WORKER_SECRET:"s".repeat(32),AI_USAGE_DATABASE:":memory:"};
const response=(raw:unknown)=>new Response(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(raw)}]}}],usageMetadata:{promptTokenCount:120,candidatesTokenCount:70,totalTokenCount:190}}));
it("runs the offline review/undo flow with no credentials or provider calls",async()=>{
 const request=vi.fn<typeof fetch>();const {url,post}=await start({request});const initial=await(await fetch(url+'/api/workspace')).json();expect(initial.revision).toBe(0);
 const result=await(await post('/api/ai-panel',prompt)).json();expect(result.analysis.dependencies).toHaveLength(3);expect(result.promptInterpreted).toBe(false);
 expect((await(await fetch(url+'/api/workspace')).json()).revision).toBe(0);
 const body={analysisId:result.analysis.id,expectedRevision:0,kind:"dependency_all",index:0};expect((await post('/api/workspace/review',body,'https://evil.example')).status).toBe(403);
 const applied=await(await post('/api/workspace/review',body)).json();expect(applied.workspace.tasks.find((t:{id:string})=>t.id==='speaker-export').coordination.count).toBe(3);
 expect((await post('/api/workspace/review',body)).status).toBe(409);expect((await post('/api/workspace/undo',{expectedRevision:0})).status).toBe(409);
 const undo=await(await post('/api/workspace/undo',{expectedRevision:1})).json();expect(undo.workspace.tasks.find((t:{id:string})=>t.id==='speaker-export').coordination.count).toBe(0);expect(request).not.toHaveBeenCalled();
});
it("confirms overlap and serves the same reviewed workspace on refresh",async()=>{
 const {url,post}=await start();const result=await(await post('/api/ai-panel',{...prompt,feature:"overlap"})).json();const applied=await post('/api/workspace/review',{analysisId:result.analysis.id,expectedRevision:0,kind:"overlap",index:0});expect(applied.status).toBe(200);
 const saved=await(await fetch(url+'/api/workspace')).json();expect(saved.notifications).toHaveLength(1);expect(saved.tasks.find((t:{id:string})=>t.id==='proposed-export').status).toBe('linked');
});
it("makes one bounded live request and shares the session budget with existing discovery",async()=>{
 const request=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{const body=JSON.parse(String(init?.body));expect(JSON.parse(body.contents[0].parts[0].text).tasks).toBeInstanceOf(Array);return response(referenceDependencies);});
 const {post}=await start({env,request,maxLiveCalls:1});const first=await post('/api/ai-panel',{...prompt,mode:"live"});expect(first.status).toBe(200);expect(request).toHaveBeenCalledTimes(1);
 expect((await post('/api/discovery',{interest:"Who can help with speaker mapping?",mode:"helpers"})).status).toBe(429);expect(request).toHaveBeenCalledTimes(1);
});
it("rejects client task injection and unsupported feature modes before any provider call",async()=>{
 const request=vi.fn<typeof fetch>();const {post}=await start({request});
 for(const body of [{...prompt,tasks:[{id:'injected'}]},{...prompt,feature:'unknown-feature'},{...prompt,mode:'automatic'},{...prompt,prompt:'short'},{...prompt,feature:'helpers'}])expect((await post('/api/ai-panel',body)).status).toBe(400);
 expect((await post('/api/workspace/review',{analysisId:'made-up',expectedRevision:0,kind:'overlap',index:0})).status).toBe(404);expect(request).not.toHaveBeenCalled();
});
it("rejects malformed or invented model output without changing workspace",async()=>{
 const raw=structuredClone(referenceOverlap);raw.overlaps[0].existingTaskId='private-task';const request=vi.fn<typeof fetch>().mockResolvedValue(response(raw));const {url,post}=await start({env,request});
 expect((await post('/api/ai-panel',{...prompt,feature:'overlap',mode:'live'})).status).toBe(400);const state=await(await fetch(url+'/api/workspace')).json();expect(state.revision).toBe(0);expect(state.notifications).toEqual([]);expect(request).toHaveBeenCalledTimes(1);
});
it("does not retry a quota error or change tasks",async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValue(new Response('',{status:429}));const {url,post}=await start({env,request});const failed=await post('/api/ai-panel',{...prompt,mode:'live'});expect(failed.status).toBe(503);expect((await failed.json()).error).toBe('QUOTA_EXCEEDED');expect(request).toHaveBeenCalledTimes(1);expect((await(await fetch(url+'/api/workspace')).json()).revision).toBe(0);
});
