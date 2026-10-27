import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createDemoApp } from "../../tools/ai-demo/app.js";
import { validateDiscovery, conversations } from "../../tools/ai-demo/discovery.js";
let server:Server|undefined;
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));server=undefined;}});
const env={AI_PROVIDER:"gemini",GEMINI_API_KEY:"fictional-key",AI_WORKER_SECRET:"s".repeat(32),AI_USAGE_DATABASE:":memory:"};
async function start(request:typeof fetch){const app=createDemoApp({env,request,cooldownMs:0,reviewDatabase:":memory:"});server=app.listen(0,"127.0.0.1");server.once("close",()=>app.locals.close());await new Promise<void>(done=>server!.once("listening",done));const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;return {url,post:(body:unknown,origin=url)=>fetch(url+'/api/discovery',{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(body)})};}
it("rejects invented conversations, evidence, duplicates, and malformed output",()=>{
 for(const match of [{conversationId:"secret",reason:"why",evidenceIds:["e1"]},{conversationId:"lunch",reason:"why",evidenceIds:["invented"]}])expect(()=>validateDiscovery({matches:[match]})).toThrow();
 const match={conversationId:"lunch",reason:"why",evidenceIds:["e1"]};expect(()=>validateDiscovery({matches:[match,match]})).toThrow();expect(()=>validateDiscovery({matches:null})).toThrow();expect(validateDiscovery({matches:[]})).toEqual([]);
});
it("uses one tracked Gemini call and returns source excerpts without sending messages",async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({matches:[{conversationId:"speaker-mapping",reason:"Speaker identities help you assign ownership.",evidenceIds:["e1"]}]})}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,totalTokenCount:150}})));
 const {url,post}=await start(request);expect((await fetch(url)).status).toBe(200);
 const response=await post({interest:"I need to identify who said what in the transcript."});expect(response.status).toBe(200);const result=await response.json();expect(result.matches[0].evidence[0].text).toBe(conversations[0].excerpts[0].text);expect(result.fictional).toBe(true);expect(request).toHaveBeenCalledTimes(1);
 expect((await post({interest:"short"})).status).toBe(400);expect((await post({interest:"A valid fictional question here"},"https://evil.example")).status).toBe(403);expect(request).toHaveBeenCalledTimes(1);
});
it("handles quota and malformed output without retry",async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValue(new Response('',{status:429}));const {post}=await start(request);const response=await post({interest:"How do we avoid duplicated outgoing messages?"});expect(response.status).toBe(503);expect((await response.json()).error).toBe("QUOTA_EXCEEDED");expect(request).toHaveBeenCalledTimes(1);
});
it("routes helper searches through Gemini and validates the helper evidence",async()=>{
 const request=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));expect(body.contents[0].parts[0].text).toContain('"helpers"');expect(body.systemInstruction.parts[0].text).toContain('Never infer availability');
  return new Response(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({helpers:[{personId:"cameron",reason:"He is testing speaker identity mapping.",conversationId:"speaker-mapping",evidenceIds:["e2"]}]})}]}}]}));
 });
 const {post}=await start(request);const response=await post({interest:"I need help connecting speaker IDs to participants",mode:"helpers"});expect(response.status).toBe(200);expect((await response.json()).helpers[0].person.id).toBe("cameron");expect(request).toHaveBeenCalledTimes(1);
});
it("rejects model-invented helper identities before displaying a recommendation",async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({helpers:[{personId:"invented",reason:"Trust me",conversationId:"speaker-mapping",evidenceIds:["e1"]}]})}]}}]})));
 const {post}=await start(request);const response=await post({interest:"Help me identify speakers from audio",mode:"helpers"});expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"INVALID_OUTPUT"});expect(request).toHaveBeenCalledTimes(1);
});
it("returns an empty helper list without inventing someone",async()=>{
 const request=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"helpers":[]}'}]}}]})));
 const {post}=await start(request);const response=await post({interest:"I need a specialist in growing tomatoes",mode:"helpers"});expect(response.status).toBe(200);expect((await response.json()).helpers).toEqual([]);expect(request).toHaveBeenCalledTimes(1);
});
it("validates modes and bounds before spending provider quota",async()=>{
 const request=vi.fn<typeof fetch>();const {post}=await start(request);
 for(const body of [{interest:"A fictional task description",mode:"send-message"},{interest:"x".repeat(1001)},{interest:"valid fictional question",conversations:[{id:"private"}]}])expect((await post(body)).status).toBe(400);
 expect(request).not.toHaveBeenCalled();
});
it("shares the active-request guard across conversation and helper searches",async()=>{
 let release!:()=>void;let started!:()=>void;
 const ready=new Promise<void>(done=>{started=done;});const gate=new Promise<void>(done=>{release=done;});
 const request=vi.fn<typeof fetch>().mockImplementation(async()=>{started();await gate;return new Response(JSON.stringify({candidates:[{finishReason:"STOP",content:{parts:[{text:'{"matches":[]}'}]}}]}));});
 const {post}=await start(request);const pending=post({interest:"A fictional speaker identity question"});
 await ready;
 try{expect((await post({interest:"A fictional helper identity question",mode:"helpers"})).status).toBe(429);expect(request).toHaveBeenCalledTimes(1);}
 finally{release();expect((await pending).status).toBe(200);}
});
