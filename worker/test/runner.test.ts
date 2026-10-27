import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerApi } from "../src/client.js";
import type { AudioCapture } from "../src/audio.js";
import { ProviderError, type AiProviders } from "../src/providers.js";
import { runJob } from "../src/runner.js";
import { captureJob, config, draft, summaryJob } from "./fixtures.js";

function dependencies() {
  const api = {
    claim: vi.fn(), heartbeat: vi.fn(async () => ({ active: true, finish: false })),
    segments: vi.fn(async () => {}), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}),
  } satisfies WorkerApi;
  const providers = { transcribe: vi.fn<AiProviders["transcribe"]>(async () => "Finalized speech"), summarize: vi.fn<AiProviders["summarize"]>(async () => draft) } satisfies AiProviders;
  const capture: AudioCapture = { run: vi.fn() };
  return { api, providers, capture, config };
}
const chunk = { speakerUserId: "alice", startMs: 0, endMs: 1_000, wav: new Uint8Array([1]) };
afterEach(() => vi.useRealTimers());

describe("leased job runner", () => {
  it("reports quota failures distinctly so the server will not retry", async () => {
    const deps = dependencies();
    deps.providers.summarize.mockRejectedValue(new ProviderError("QUOTA_EXCEEDED", 429));
    await expect(runJob(summaryJob, deps, new AbortController().signal)).rejects.toThrow("QUOTA_EXCEEDED");
    expect(deps.api.fail).toHaveBeenCalledWith(summaryJob, "QUOTA_EXCEEDED");
    expect(deps.api.complete).not.toHaveBeenCalled();
  });
  it("checks authorization before a chunk reaches transcription", async () => {
    const deps = dependencies();
    deps.api.heartbeat.mockResolvedValueOnce({ active: true, finish: false }).mockResolvedValue({ active: false, finish: false });
    deps.capture.run = async (_job, options) => { await options.onChunk(chunk, options.signal); };
    await runJob(captureJob, deps, new AbortController().signal);
    expect(deps.providers.transcribe).not.toHaveBeenCalled();
    expect(deps.api.segments).not.toHaveBeenCalled();
    expect(deps.api.complete).not.toHaveBeenCalled();
  });

  it("discards results when consent changes while a provider is processing", async () => {
    const deps = dependencies();
    deps.api.heartbeat.mockResolvedValueOnce({ active: true, finish: false }).mockResolvedValueOnce({ active: true, finish: false }).mockResolvedValue({ active: false, finish: false });
    deps.capture.run = async (_job, options) => { await options.onChunk(chunk, options.signal); };
    await runJob(captureJob, deps, new AbortController().signal);
    expect(deps.providers.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.api.segments).not.toHaveBeenCalled();
    expect(deps.api.fail).not.toHaveBeenCalled();
  });

  it("aborts pending provider calls on the cancellation heartbeat", async () => {
    vi.useFakeTimers();
    const deps = dependencies();
    deps.api.heartbeat.mockResolvedValueOnce({ active: true, finish: false }).mockResolvedValueOnce({ active: true, finish: false }).mockResolvedValue({ active: false, finish: false });
    let pendingSignal: AbortSignal | undefined;
    deps.providers.transcribe.mockImplementation(async (_wav, signal) => new Promise((_resolve, reject) => {
      pendingSignal = signal; signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    deps.capture.run = async (_job, options) => { await options.onChunk(chunk, options.signal); };
    const result = runJob(captureJob, deps, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(pendingSignal?.aborted).toBe(true);
    expect(deps.api.segments).not.toHaveBeenCalled();
    expect(deps.api.complete).not.toHaveBeenCalled();
  });

  it("completes duration-limited capture using only committed segments", async () => {
    vi.useFakeTimers();
    const deps = dependencies();
    deps.capture.run = async (_job, options) => {
      await options.onChunk(chunk, options.signal);
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const result = runJob({ ...captureJob, maxDurationSeconds: 1 }, deps, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000); await result;
    expect(deps.api.segments).toHaveBeenCalledTimes(1);
    expect(deps.api.complete).toHaveBeenCalledTimes(1);
    expect(deps.api.fail).not.toHaveBeenCalled();
  });

  it("fails closed when media unexpectedly ends or transcript exceeds budget", async () => {
    const deps = dependencies();
    deps.capture.run = async () => {};
    await expect(runJob(captureJob, deps, new AbortController().signal)).rejects.toThrow("unexpectedly");
    expect(deps.api.fail).toHaveBeenCalledTimes(1);
    deps.config = { ...config, maxTranscriptChars: 1 };
    deps.capture.run = async (_job, options) => { await options.onChunk(chunk, options.signal); };
    await expect(runJob(captureJob, deps, new AbortController().signal)).rejects.toThrow("budget");
    expect(deps.api.segments).not.toHaveBeenCalled();
  });

  it("revalidates authorization before saving summary results", async () => {
    const deps = dependencies();
    deps.api.heartbeat.mockResolvedValueOnce({ active: true, finish: false }).mockResolvedValue({ active: false, finish: false });
    await runJob(summaryJob, deps, new AbortController().signal);
    expect(deps.providers.summarize).toHaveBeenCalledTimes(1);
    expect(deps.api.complete).not.toHaveBeenCalled();
    expect(deps.api.fail).not.toHaveBeenCalled();
  });
});
