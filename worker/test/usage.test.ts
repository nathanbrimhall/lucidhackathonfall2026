import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UsageTracker } from "../src/usage.js";
import { createProviders } from "../src/providers.js";
import { loadWorkerConfig } from "../src/config.js";
import { fixtures } from "../../tools/ai-eval/fixtures.js";
describe("persistent local Gemini usage guard", () => {
  it("shares the daily budget across instances and counts unknown-token requests", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-usage-"));
    const path = join(root,"usage.sqlite");
    let tracker = new UsageTracker(path,"not-a-real-key",1);
    try {
      const id=tracker.reserve("flash","summary"); tracker.finish(id,{ code:"TypeError" }); tracker.close();
      tracker = new UsageTracker(path,"not-a-real-key",1);
      expect(tracker.status().today.attempts).toBe(1);
      expect(tracker.status().today.requestsWithUnknownTokens).toBe(1);
      expect(()=>tracker.reserve("flash","summary")).toThrow("LOCAL_BUDGET_EXCEEDED");
      expect(readFileSync(path).includes(Buffer.from("not-a-real-key"))).toBe(false);
    } finally {
      tracker.close();
      if (!resolve(root).startsWith(resolve(tmpdir(),"lucid-usage-"))) throw new Error("Unexpected temporary test path");
      rmSync(root,{recursive:true,force:true});
    }
  });
  it("does not treat service overload or malformed responses as quota exhaustion", () => {
    const tracker=new UsageTracker(":memory:","fake");
    try {
      const id=tracker.reserve("flash","summary"); tracker.finish(id,{code:"SERVICE_UNAVAILABLE",httpStatus:503});
      expect(tracker.status().quotaPaused).toBe(false);
      expect(tracker.status().today.quotaErrors).toBe(0);
      tracker.reserve("flash","summary");
    } finally { tracker.close(); }
  });
  it("pauses all models on 429 with unknown reset time until explicit manual retry", () => {
    const tracker=new UsageTracker(":memory:","fake");
    try {
      const id=tracker.reserve("flash","summary"); tracker.finish(id,{code:"QUOTA_EXCEEDED",httpStatus:429});
      expect(tracker.status()).toMatchObject({quotaPaused:true,blockedUntil:null,providerRequestsRemaining:null});
      expect(()=>tracker.reserve("another-model","summary")).toThrow("QUOTA_PAUSED");
      tracker.allowManualRetry(); tracker.reserve("flash","summary");
      expect(tracker.status().today.attempts).toBe(2);
    } finally { tracker.close(); }
  });
  it("uses provider retry-after without automatically making a request and rolls local days over in UTC", () => {
    let now=Date.parse("2026-10-25T23:59:50Z");
    const tracker=new UsageTracker(":memory:","fake",2,()=>now);
    try {
      const id=tracker.reserve("flash","summary"); tracker.finish(id,{code:"QUOTA_EXCEEDED",httpStatus:429,retryAfterSeconds:20});
      expect(tracker.status().quotaPaused).toBe(true);
      now+=21000;
      expect(tracker.status().quotaPaused).toBe(false);
      expect(tracker.status().today.attempts).toBe(0);
      expect(tracker.status().lifetime.attempts).toBe(1);
    } finally { tracker.close(); }
  });
  it("records token counts once and keeps credentials isolated", () => {
    const tracker=new UsageTracker(":memory:","fake");
    try {
      const id=tracker.reserve("flash","summary");
      tracker.finish(id,{httpStatus:200,usage:{inputTokens:100,outputTokens:20,totalTokens:130}});
      tracker.finish(id,{httpStatus:200,usage:{inputTokens:100,outputTokens:20,totalTokens:130}});
      expect(tracker.status().today).toMatchObject({attempts:1,totalTokens:130,responsesReceived:1});
      expect(JSON.stringify(tracker.status())).not.toContain('"credential"');
    } finally { tracker.close(); }
  });
  it("prevents any further HTTP request after a quota response", async () => {
    const tracker=new UsageTracker(":memory:","fake");
    const config=loadWorkerConfig({AI_PROVIDER:"gemini",GEMINI_API_KEY:"fake",AI_WORKER_SECRET:"test-worker-secret-at-least-32-characters"});
    let requests=0;
    const providers=createProviders(config,async()=>{requests++;return new Response("do not store raw provider body",{status:429});},{usageTracker:tracker});
    try {
      await expect(providers.summarize(fixtures[0].job,new AbortController().signal)).rejects.toThrow("QUOTA_EXCEEDED");
      await expect(providers.summarize(fixtures[0].job,new AbortController().signal)).rejects.toThrow("QUOTA_PAUSED");
      expect(requests).toBe(1); expect(tracker.status().today.quotaErrors).toBe(1);
    } finally { tracker.close(); }
  });
});
