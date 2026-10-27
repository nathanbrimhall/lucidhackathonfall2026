import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createDemoApp } from "../../tools/ai-demo/app.js";
import { fixtures } from "../../tools/ai-eval/fixtures.js";
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function start(options: Parameters<typeof createDemoApp>[0] = {}) {
  const app=createDemoApp({reviewDatabase:":memory:",...options});
  const server = app.listen(0, "127.0.0.1"); server.once("close",()=>app.locals.close()); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`;
  return { url, run: (body: unknown, origin: string | null = url) => fetch(`${url}/api/run`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) }) };
}
describe("local transcript application", () => {
  it("serves the app, lists fixtures, and runs replay without credentials", async () => {
    const { url, run } = await start({ env: {} });
    expect(await (await fetch(url)).text()).toContain("Conversation Lab");
    const list = await (await fetch(`${url}/api/fixtures`)).json(); expect(list.fixtures).toHaveLength(fixtures.length);
    const response = await run({ fixtureId: "commitments", mode: "replay" });
    const result = await response.json(); expect(result.status).toBe("success"); expect(result.notes.actionItems).toHaveLength(2);
  });
  it("saves and approves a preview over HTTP without making another provider call",async()=>{
    const request=vi.fn<typeof fetch>();const {url,run}=await start({request,env:{}});
    const result=await(await run({fixtureId:"commitments",mode:"replay",reviewerUserId:"nathan"})).json();
    const bundle=result.followups;const message=bundle.proposals.find((p:{kind:string})=>p.kind==="message");
    const route=`${url}/api/reviews/${bundle.id}/proposals/${message.id}`;
    const mutate=(body:unknown,origin=url)=>fetch(route,{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify(body)});
    expect((await mutate({expectedRevision:0,action:"approve"},"https://evil.example")).status).toBe(403);
    const response=await mutate({expectedRevision:0,action:"approve",changes:{kind:"message",recipientUserId:"cameron",body:"Please send the transcript format when ready."}});
    expect(response.status).toBe(200);
    expect((await mutate({expectedRevision:0,action:"discard"})).status).toBe(409);
    const exported=await(await fetch(`${url}/api/reviews/${bundle.id}/export`)).json();
    expect(exported.proposals).toHaveLength(1);expect(exported.proposals[0].body).toBe("Please send the transcript format when ready.");
    expect((await(await fetch(`${url}/api/reviews`)).json()).reviews[0].approved).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });
  it("blocks cross-origin, missing-origin and malformed requests", async () => {
    const { run } = await start();
    expect((await run({ fixtureId: "commitments", mode: "live" }, "https://evil.example")).status).toBe(403);
    expect((await run({}, null)).status).toBe(403);
    expect((await run({ fixtureId: "unknown", mode: "replay" })).status).toBe(400);
    expect((await run({ fixtureId: "commitments", mode: "live", job: {} })).status).toBe(400);
  });
  it("stops repeated free-tier calls after quota failure and exposes no provider body", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("private provider error", { status: 429 }));
    const { run } = await start({ request, env: { AI_PROVIDER: "gemini", GEMINI_API_KEY: "fake-key", AI_WORKER_SECRET: "test-secret-at-least-32-characters" } });
    const result = await (await run({ fixtureId: "commitments", mode: "live" })).json();
    expect(result.error.code).toBe("QUOTA_EXCEEDED");
    expect((await run({ fixtureId: "commitments", mode: "live" })).status).toBe(429);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
