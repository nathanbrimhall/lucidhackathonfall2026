import { aiWorkerClaimResponseSchema, aiWorkerHeartbeatSchema, type AiDraftNotes, type AiTranscriptSegment, type AiWorkerHeartbeat, type AiWorkerJob } from "../../shared/src/ai-worker.js";
import type { WorkerConfig } from "./config.js";

export interface WorkerApi {
  claim(workerId: string, signal: AbortSignal): Promise<AiWorkerJob | null>;
  heartbeat(job: AiWorkerJob, signal: AbortSignal): Promise<AiWorkerHeartbeat>;
  segments(job: AiWorkerJob, segments: AiTranscriptSegment[], signal: AbortSignal): Promise<void>;
  complete(job: AiWorkerJob, signal: AbortSignal, notes?: AiDraftNotes): Promise<void>;
  fail(job: AiWorkerJob): Promise<void>;
}
export function createWorkerApi(config: WorkerConfig, request: typeof fetch = fetch): WorkerApi {
  async function post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await request(`${config.serverUrl}/internal/ai/jobs${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${config.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Worker API request failed"); }
    return response.status === 204 ? undefined : response.json();
  }
  return {
    async claim(workerId, signal) { return aiWorkerClaimResponseSchema.parse(await post("/claim", { workerId }, signal)).job; },
    async heartbeat(job, signal) { return aiWorkerHeartbeatSchema.parse(await post(`/${encodeURIComponent(job.id)}/heartbeat`, { leaseToken: job.leaseToken }, signal)); },
    async segments(job, segments, signal) { await post(`/${encodeURIComponent(job.id)}/segments`, { leaseToken: job.leaseToken, segments }, signal); },
    async complete(job, signal, notes) { await post(`/${encodeURIComponent(job.id)}/complete`, { leaseToken: job.leaseToken, ...(notes ? { notes } : {}) }, signal); },
    async fail(job) { await post(`/${encodeURIComponent(job.id)}/fail`, { leaseToken: job.leaseToken, code: "WORKER_FAILED" }, AbortSignal.timeout(5_000)); },
  };
}
