import { randomUUID } from "node:crypto";
import { createLiveKitCapture } from "./audio.js";
import { createWorkerApi } from "./client.js";
import { loadWorkerConfig } from "./config.js";
import { createProviders } from "./providers.js";
import { delay, runJob } from "./runner.js";

async function main() {
  const config = loadWorkerConfig();
  const controller = new AbortController();
  for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => controller.abort());
  const api = createWorkerApi(config);
  const providers = createProviders(config);
  const capture = createLiveKitCapture();
  const workerId = `worker_${randomUUID()}`;
  // One active job per process. Scale independent worker replicas for more sessions.
  console.info(JSON.stringify({ event: "ai_worker_started" }));
  while (!controller.signal.aborted) {
    try {
      const job = await api.claim(workerId, controller.signal);
      if (job) await runJob(job, { api, providers, capture, config }, controller.signal);
      else await delay(1_000, controller.signal);
    } catch {
      // Never log provider payloads, raw audio, transcript, credentials, or tokens.
      if (!controller.signal.aborted) {
        console.error(JSON.stringify({ event: "ai_worker_request_failed" }));
        await delay(2_000, controller.signal);
      }
    }
  }
}
main().catch(() => { console.error(JSON.stringify({ event: "ai_worker_start_failed" })); process.exitCode = 1; });
