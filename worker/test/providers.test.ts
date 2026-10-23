import { describe, expect, it, vi } from "vitest";
import { createProviders, validateNotes } from "../src/providers.js";
import { config, draft, summaryJob } from "./fixtures.js";

describe("real provider adapter", () => {
  it("sends in-memory WAV multipart data to the configured transcription endpoint", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ text: " Hello there " }));
    const result = await createProviders(config, request).transcribe(new Uint8Array([1, 2]), new AbortController().signal);
    expect(result).toBe("Hello there");
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(options?.headers).toEqual({ Authorization: "Bearer test-key" });
    const form = options?.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(await (form.get("file") as Blob).arrayBuffer()).toEqual(new Uint8Array([1, 2]).buffer);
  });

  it("requests strict structured output and validates model evidence", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(draft) } }] }));
    expect(await createProviders(config, request).summarize(summaryJob, new AbortController().signal)).toEqual(draft);
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.max_completion_tokens).toBe(6_000);
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.messages[0].content).toContain("untrusted data");
  });

  it("rejects invented evidence, unauthorized owners, unbounded notes, and invalid dates", () => {
    expect(() => validateNotes({ ...draft, summary: [{ text: "Invented", segmentIds: ["missing"] }] }, summaryJob)).toThrow();
    expect(() => validateNotes({ ...draft, actionItems: [{ text: "Do it", segmentIds: ["segment-1"], ownerUserId: "mallory", dueAt: null }] }, summaryJob)).toThrow();
    expect(() => validateNotes({ ...draft, extra: "instructions" }, summaryJob)).toThrow();
    expect(() => validateNotes({ ...draft, actionItems: [{ text: "Do it", segmentIds: ["segment-1"], ownerUserId: null, dueAt: "Friday" }] }, summaryJob)).toThrow();
    expect(() => validateNotes({ ...draft, summary: Array(51).fill(draft.summary[0]) }, summaryJob)).toThrow();
  });

  it.each(["length", "stop"])("bounds retries on truncation or malformed/refused output (%s)", async (finish_reason) => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason, message: { content: "{}", refusal: "refused" } }] }));
    await expect(createProviders(config, request).summarize(summaryJob, new AbortController().signal)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts pending HTTP calls on cancellation without retrying", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const result = createProviders(config, request).summarize(summaryJob, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds successful response size before parsing", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("x".repeat(1_000_001)));
    await expect(createProviders(config, request).transcribe(new Uint8Array(), new AbortController().signal)).rejects.toThrow();
  });

  it("applies an HTTP timeout", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    }));
    await expect(createProviders({ ...config, providerTimeoutMs: 10 }, request).transcribe(new Uint8Array(), new AbortController().signal)).rejects.toThrow("timed out");
  });
});
