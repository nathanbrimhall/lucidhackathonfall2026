import { randomUUID } from "node:crypto";
import type { AiWorkerJob } from "../../shared/src/ai-worker.js";
import type { AudioCapture } from "./audio.js";
import type { WorkerApi } from "./client.js";
import type { WorkerConfig } from "./config.js";
import type { AiProviders } from "./providers.js";

export interface JobDependencies { api: WorkerApi; capture: AudioCapture; providers: AiProviders; config: WorkerConfig }

/** All work is scoped to a leased revision; failure to re-authorize always stops processing. */
export async function runJob(job: AiWorkerJob, deps: JobDependencies, shutdown: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([shutdown, controller.signal]);
  let cancelled = false;
  let finishing = false;
  let failure: unknown;
  let heartbeatRunning = false;
  const authorize = async () => {
    signal.throwIfAborted();
    const state = await deps.api.heartbeat(job, signal);
    if (!state.active) { cancelled = true; controller.abort(); }
    else if (state.finish && job.kind === "capture") { finishing = true; controller.abort(); }
    signal.throwIfAborted();
  };
  const interval = setInterval(() => {
    if (heartbeatRunning || signal.aborted) return;
    heartbeatRunning = true;
    void authorize().catch((error) => { if (!cancelled && !finishing && !shutdown.aborted) failure ??= error; controller.abort(); })
      .finally(() => { heartbeatRunning = false; });
  }, 2_000);
  let duration: ReturnType<typeof setTimeout> | undefined;
  try {
    await authorize();
    if (job.kind === "capture") {
      duration = setTimeout(() => { finishing = true; controller.abort(); }, job.maxDurationSeconds * 1000);
      let transcriptChars = 0;
      await deps.capture.run(job, {
        signal, chunkSeconds: deps.config.chunkSeconds,
        async onChunk(chunk, captureSignal) {
          const chunkSignal = AbortSignal.any([signal, captureSignal]);
          // No stale buffered chunk reaches the provider, even if capture was already in progress.
          await authorize();
          chunkSignal.throwIfAborted();
          const text = await deps.providers.transcribe(chunk.wav, chunkSignal);
          await authorize();
          chunkSignal.throwIfAborted();
          transcriptChars += text.length;
          if (transcriptChars > deps.config.maxTranscriptChars) throw new Error("Transcript budget exceeded");
          if (text) await deps.api.segments(job, [{ id: randomUUID(), speakerUserId: chunk.speakerUserId,
            startMs: chunk.startMs, endMs: chunk.endMs, text }], chunkSignal);
        },
      });
      if (failure) throw failure;
      // Natural return requires duration/finish; unexpected media exit must fail closed.
      if (!finishing && !cancelled && !shutdown.aborted) throw new Error("Capture ended unexpectedly");
      if (finishing && !cancelled && !shutdown.aborted) {
        // Provider calls were aborted above; only already finalized segments are summarized.
        await deps.api.complete(job, shutdown);
      }
    } else {
      const notes = await deps.providers.summarize(job, signal);
      await authorize();
      await deps.api.complete(job, signal, notes);
    }
  } catch (error) {
    if (!cancelled && !shutdown.aborted && !finishing) {
      await deps.api.fail(job).catch(() => {});
      throw failure ?? error;
    }
  } finally {
    clearInterval(interval); if (duration) clearTimeout(duration);
    controller.abort();
  }
}

export function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(stop, milliseconds);
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
}
