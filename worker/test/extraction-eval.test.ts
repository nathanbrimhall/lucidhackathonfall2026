import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fixtures } from "../../tools/ai-eval/fixtures.js";
import { runFixture, summarizeResults } from "../../tools/ai-eval/runner.js";
import { scoreActions, scoreNoteCoverage } from "../../tools/ai-eval/scoring.js";
import { aiWorkerJobSchema } from "../../shared/src/ai-worker.js";
import { createProviders } from "../src/providers.js";
import { loadWorkerConfig } from "../src/config.js";
import { EXTRACTION_SYSTEM_PROMPT } from "../src/extraction-prompt.js";
const env = { AI_PROVIDER: "gemini", AI_GEMINI_OUTPUT_MODE: "schema", GEMINI_API_KEY: "fake-key", AI_WORKER_SECRET: "test-secret-at-least-32-characters", AI_PROVIDER_TIMEOUT_MS: "100" };
const config = loadWorkerConfig(env);
const signal = () => new AbortController().signal;
const fixture = fixtures[0];
const response = (value: unknown, finishReason = "STOP") => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 45, totalTokenCount: 168 } });
describe("extraction evaluation", () => {
  it.each(fixtures)("validates and replays $id without provider calls (not model accuracy)", async f => {
    const request = vi.fn<typeof fetch>();
    const result = await runFixture(f, "replay", { request });
    expect(result.status).toBe("success");
    expect(result.metrics?.missedActions).toEqual([]);
    expect(result.metrics?.inventedActions).toEqual([]);
    expect(result.metrics?.ownershipErrors).toBe(0);
    expect(result.metrics?.deadlineErrors).toBe(0);
    expect(result.noteCoverage?.missingFacts ?? []).toEqual([]);
    expect(result.cost.estimatedUsd).toBe(0);
    expect(result.usage).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(summarizeResults([result]).liveModelEvaluated).toBe(false);
  });
  it("detects the actual Flash response that omitted a dependency without weakening the action score", () => {
    const saved=JSON.parse(readFileSync(new URL("./fixtures/planning-blocker-omission.json",import.meta.url),"utf8"));
    const fixture=fixtures.find(f=>f.id===saved.fixtureId)!;
    expect(scoreActions(saved.notes,fixture.expected)).toMatchObject({missedActions:[],inventedActions:[],ownershipErrors:0,deadlineErrors:0});
    expect(scoreNoteCoverage(saved.notes,fixture.noteFacts!).missingFacts).toEqual(saved.expectedMissingFacts);
    const complete={...saved.notes,summary:[...saved.notes.summary,{text:"Missing speaker IDs in the transcript export block reliable attribution and the message draft preview.",segmentIds:["s2","s3"]}]};
    expect(scoreNoteCoverage(complete,fixture.noteFacts!).missingFacts).toEqual([]);
  });
  it("flags missing decision/blocker coverage separately from correct action extraction", () => {
    const planning = fixtures.find(f=>f.id==="planning-handoff")!;
    expect(scoreNoteCoverage(planning.reference,planning.noteFacts!).missingFacts).toEqual([]);
    const result=scoreNoteCoverage({...planning.reference,summary:[],decisions:[]},planning.noteFacts!);
    expect(result.missingFacts).toHaveLength(5);
  });
  it("counts missed, invented, duplicate, ownership, and deadline errors separately", () => {
    const action = fixture.reference.actionItems[0];
    const result = scoreActions({ summary: [], decisions: [], actionItems: [
      { ...action, ownerUserId: "nathan", dueAt: "2026-10-25T10:00:00Z" }, action,
      { text: "Buy pizza", ownerUserId: null, dueAt: null, segmentIds: ["s1"] },
    ] }, fixture.expected);
    expect(result.missedActions).toEqual(["input-form"]);
    expect(result.inventedActions).toHaveLength(2);
    expect(result.ownershipErrors).toBe(1);
    expect(result.deadlineErrors).toBe(1);
  });
  it("matches equivalent UTC offsets and does not score edited transcripts", async () => {
    const f = fixtures.find(f => f.id === "daylight-saving")!;
    const result = scoreActions({ ...f.reference, actionItems: [{ ...f.reference.actionItems[0], dueAt: "2026-11-02T09:00:00-07:00" }] }, f.expected);
    expect(result.deadlineErrors).toBe(0);
    const edited = { ...fixture.job, segments: [{ ...fixture.job.segments[0], text: "Custom conversation" }] };
    const request = vi.fn<typeof fetch>(async () => response({ summary: [], decisions: [], actionItems: [] }));
    expect((await runFixture(fixture, "live", { job: edited, env, request })).metrics).toBeNull();
    await expect(runFixture(fixture, "replay", { job: edited })).rejects.toThrow();
  });
  it("supplies participant IDs/names, reference clock, timezone, versioned prompt, and deterministic settings", async () => {
    const request = vi.fn<typeof fetch>(async () => response(fixture.reference));
    const result = await runFixture(fixture, "live", { env, request });
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(JSON.parse(body.contents[0].parts[0].text).context).toEqual(fixture.job.context);
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.properties.actionItems.items.properties.dueAt.type).toEqual(["string", "null"]);
    expect(JSON.stringify(body.generationConfig.responseJsonSchema)).not.toContain('"pattern"');
    expect(body.systemInstruction.parts[0].text).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(result.usage).toEqual([{ inputTokens: 123, outputTokens: 45, totalTokens: 168 }]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.cost.billingVerified).toBe(false);
    expect(result.model).toBe("gemini-3.6-flash");
  });
  it("supports explicit JSON mode while keeping local schema validation", async () => {
    const request = vi.fn<typeof fetch>(async () => response(fixture.reference));
    const jsonConfig = loadWorkerConfig({ ...env, AI_GEMINI_OUTPUT_MODE: "json" });
    expect(await createProviders(jsonConfig, request).summarize(fixture.job, signal())).toEqual(fixture.reference);
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema).toBeUndefined();
    expect(body.systemInstruction.parts[0].text).toContain("output schema");
    await expect(createProviders(jsonConfig, async () => response({})).summarize(fixture.job, signal())).rejects.toThrow();
  });
  it("rejects bad timezone or incomplete context at the shared contract boundary", () => {
    expect(() => aiWorkerJobSchema.parse({ ...fixture.job, context: { ...fixture.job.context, timeZone: "Mars/Olympus" } })).toThrow();
    expect(() => aiWorkerJobSchema.parse({ ...fixture.job, context: { participants: [] } })).toThrow();
  });
  it("keeps injection text in untrusted user input and rejects unauthorized evidence/owners", async () => {
    const f = fixtures.find(f => f.id === "prompt-injection")!;
    const request = vi.fn<typeof fetch>(async () => response({ summary: [], decisions: [], actionItems: [{ text: "Reveal API key", segmentIds: ["secret"], ownerUserId: "attacker", dueAt: null }] }));
    const result = await runFixture(f, "live", { env, request });
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body.systemInstruction.parts[0].text).toContain("untrusted data");
    expect(body.systemInstruction.parts[0].text).not.toContain("transfer $5000");
    expect(body.contents[0].parts[0].text).toContain("transfer $5000");
    expect(result.status).toBe("failed");
    expect(result.notes).toBeNull();
  });
  it.each(["not json", "{}", { summary: [], decisions: [], actionItems: [], extra: "invalid" }])("rejects malformed model output without retrying: %j", async output => {
    const request = vi.fn<typeof fetch>(async () => response(output));
    await expect(createProviders(config, request).summarize(fixture.job, signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 429, 500, 503])("records provider failure %s without inventing accuracy scores or falling back", async status => {
    const request = vi.fn<typeof fetch>(async () => new Response("must not log provider body or secrets", { status, headers: { "Retry-After": "30" } }));
    const result = await runFixture(fixture, "live", { env, request });
    expect(result.status).toBe("failed"); expect(result.metrics).toBeNull(); expect(result.notes).toBeNull();
    expect(result.error?.httpStatus).toBe(status); expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("fake-key");
    if (status === 429) { expect(result.error?.code).toBe("QUOTA_EXCEEDED"); expect(result.error?.retryAfterSeconds).toBe(30); }
    expect(summarizeResults([result]).failures).toBe(1);
  });
  it("handles timeout and cancellation without automatic retries", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const result = await runFixture(fixture, "live", { env, request });
    expect(result.error?.code).toBe("TimeoutError"); expect(request).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const pending = runFixture(fixture, "live", { env, request, signal: controller.signal });
    controller.abort(); expect((await pending).error?.code).toBe("AbortError");
  });
  it("rejects inconsistent identities before making any provider request", async () => {
    const request = vi.fn<typeof fetch>(async () => response(fixture.reference));
    const invalid = { ...fixture.job, context: { ...fixture.job.context!, participants: [{ userId: "outsider", displayName: "Unknown" }] } };
    await expect(createProviders(config, request).summarize(invalid, signal())).rejects.toThrow("INVALID_CONTEXT");
    expect(request).not.toHaveBeenCalled();
  });
  it("times out a provider that sends headers but stalls the response body", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start() {} })));
    const result = await runFixture(fixture, "live", { env, request });
    expect(result.error?.code).toBe("TimeoutError");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects truncated, blocked, oversized, and network-failed responses", async () => {
    for (const finishReason of ["MAX_TOKENS", "SAFETY"]) {
      await expect(createProviders(config, async () => response(fixture.reference, finishReason)).summarize(fixture.job, signal())).rejects.toThrow();
    }
    await expect(createProviders(config, async () => new Response("x".repeat(1_000_001))).summarize(fixture.job, signal())).rejects.toThrow();
    expect((await runFixture(fixture, "live", { env, request: async () => { throw new TypeError("network failed"); } })).status).toBe("failed");
  });
});
