import { describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../src/config.js";
import { createProviders } from "../src/providers.js";
import { draft, summaryJob } from "./fixtures.js";
const env = { AI_PROVIDER: "gemini", AI_GEMINI_OUTPUT_MODE: "schema", AI_WORKER_SECRET: "test-worker-secret-at-least-32-characters", GEMINI_API_KEY: "google-test-key", OPENAI_API_KEY: "must-not-use" };
const config = loadWorkerConfig(env);
const response = (text: string) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });
describe("Gemini-only provider", () => {
  it("requires the Gemini key even when an OpenAI key is present", () => {
    expect(() => loadWorkerConfig({ ...env, GEMINI_API_KEY: "" })).toThrow("GEMINI_API_KEY");
    expect(config.apiKey).toBe("google-test-key");
    expect(() => loadWorkerConfig({ ...env, AI_PROVIDER_BASE_URL: "https://api.openai.com/v1" })).toThrow();
  });
  it("sends inline WAV to Google using only the Gemini key", async () => {
    const request = vi.fn<typeof fetch>(async () => response("Hello"));
    expect(await createProviders(config, request).transcribe(new Uint8Array([1, 2]), new AbortController().signal)).toBe("Hello");
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(options?.headers).toEqual({ "x-goog-api-key": "google-test-key", "Content-Type": "application/json" });
    expect(JSON.parse(options?.body as string).contents[0].parts[1].inlineData).toEqual({ mimeType: "audio/wav", data: "AQI=" });
  });
  it("validates structured notes and rejects invented evidence", async () => {
    const request = vi.fn<typeof fetch>(async () => response(JSON.stringify(draft)));
    expect(await createProviders(config, request).summarize(summaryJob, new AbortController().signal)).toEqual(draft);
    expect(JSON.parse(request.mock.calls[0][1]?.body as string).generationConfig.responseMimeType).toBe("application/json");
    const invalid = vi.fn<typeof fetch>(async () => response(JSON.stringify({ ...draft, summary: [{ text: "invented", segmentIds: ["missing"] }] })));
    await expect(createProviders(config, invalid).summarize(summaryJob, new AbortController().signal)).rejects.toThrow();
  });
  it("fails on quota errors without falling back or retrying", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("quota", { status: 429 }));
    await expect(createProviders(config, request).summarize(summaryJob, new AbortController().signal)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
