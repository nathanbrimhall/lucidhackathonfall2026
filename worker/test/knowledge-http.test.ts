import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createDemoApp } from "../../tools/ai-demo/app.js";
import { referenceKnowledge } from "../../tools/ai-demo/knowledge-runner.js";
import type { KnowledgeContext } from "../../tools/ai-demo/knowledge.js";
const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}});
async function start(options:Parameters<typeof createDemoApp>[0]={}){
 const app=createDemoApp({env:{},reviewDatabase:":memory:",cooldownMs:0,...options});const server=app.listen(0,"127.0.0.1");server.once("close",()=>app.locals.close());servers.push(server);await new Promise<void>(done=>server.once("listening",done));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 return {url,post:(body:unknown,origin=url)=>fetch(url+'/api/ai-panel',{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)})};
}
const env={AI_PROVIDER:"gemini",GEMINI_API_KEY:"fictional-key",AI_WORKER_SECRET:"s".repeat(32),AI_USAGE_DATABASE:":memory:"};
const question={prompt:"Was video ever approved, and why was audio-only chosen?",feature:"decisions",mode:"replay"};
const response=(content:unknown)=>new Response(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(content)}]}}],usageMetadata:{promptTokenCount:200,candidatesTokenCount:100,totalTokenCount:300}}));
it("all four reference tools work offline and leave tasks and notifications unchanged",async()=>{
 const request=vi.fn<typeof fetch>();const {url,post}=await start({request});const before=await(await fetch(url+'/api/workspace')).json();
 for(const feature of ['decisions','daily_brief','catchup_brief','meeting_prep']){
  const result=await post({...question,feature,...(feature==='daily_brief'?{fromDate:'2026-10-26',toDate:'2026-10-26'}:{})});expect(result.status).toBe(200);const body=await result.json();expect(body.readOnly).toBe(true);expect(body.fictional).toBe(true);expect(body.promptInterpreted).toBe(false);expect(JSON.stringify(body.context)).not.toContain('restricted-personnel');
 }
 expect(await(await fetch(url+'/api/workspace')).json()).toEqual(before);expect(request).not.toHaveBeenCalled();
});
it("sends only authorized context to Gemini and shares the existing budget",async()=>{
 const request=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const input=JSON.parse(body.contents[0].parts[0].text) as KnowledgeContext&{prompt:string};expect(JSON.stringify(input)).not.toContain('restricted-personnel');expect(input.role).toBe('lead');expect(body.systemInstruction.parts[0].text).toContain('untrusted data');return response(referenceKnowledge('decisions',input));
 });
 const {post}=await start({env,request,maxLiveCalls:1});const result=await post({...question,mode:'live',role:'lead'});expect(result.status).toBe(200);const body=await result.json();expect(body.usage.totalTokens).toBe(300);expect(body.promptInterpreted).toBe(true);expect(request).toHaveBeenCalledTimes(1);expect((await post({...question,mode:'live',feature:'meeting_prep'})).status).toBe(429);expect(request).toHaveBeenCalledTimes(1);
});
it("rejects date errors, invalid viewer/role, context injection and hostile origins without provider calls",async()=>{
 const request=vi.fn<typeof fetch>();const {post}=await start({request});
 for(const extra of [{feature:'daily_brief'},{feature:'catchup_brief',fromDate:'2026-10-27',toDate:'2026-10-26'},{fromDate:'2026-02-30'},{viewerId:'administrator'},{role:'owner'},{records:[{id:'forged'}]},{timeZone:'invalid-zone'}])expect((await post({...question,...extra,mode:'live'})).status).toBe(400);
 expect((await post(question,'https://evil.example')).status).toBe(403);expect(request).not.toHaveBeenCalled();
});
it("does not display invented reasoning or leak an inaccessible record from model output",async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValue(response({status:'supported',claims:[{kind:'reasoning',text:'A secret reason',recordIds:['personnel-budget'],taskIds:[],sources:[{conversationId:'restricted-personnel',excerptId:'e1'}]}],questions:[]}));
 const {url,post}=await start({env,request});const result=await post({...question,mode:'live'});expect(result.status).toBe(503);expect(await result.json()).toEqual({error:'INVALID_OUTPUT'});expect((await(await fetch(url+'/api/workspace')).json()).revision).toBe(0);expect(request).toHaveBeenCalledTimes(1);
});
it("returns an explicit unknown for dates before the fictional history",async()=>{
 const {post}=await start();const result=await(await post({...question,toDate:'2026-10-22'})).json();expect(result.content).toEqual({status:'not_found',claims:[],questions:[]});expect(result.context.sources).toEqual([]);
});
it("live provider failures do not retry or mutate workspace",async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValue(new Response('',{status:429}));const {url,post}=await start({env,request});const result=await post({...question,mode:'live',feature:'meeting_prep'});expect(result.status).toBe(503);expect((await result.json()).error).toBe('QUOTA_EXCEEDED');expect(request).toHaveBeenCalledTimes(1);const workspace=await(await fetch(url+'/api/workspace')).json();expect(workspace.revision).toBe(0);expect(workspace.notifications).toEqual([]);
});
