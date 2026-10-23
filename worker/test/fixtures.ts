import type { AiCaptureJob, AiSummaryJob } from "../../shared/src/ai-worker.js";
import { loadWorkerConfig } from "../src/config.js";

export const config = loadWorkerConfig({ AI_WORKER_SECRET: "test-worker-secret-at-least-32-characters", OPENAI_API_KEY: "test-key" });
export const captureJob: AiCaptureJob = {
  id: "job-1", leaseToken: "lease-1", aiSessionId: "ai-1", revision: 1, kind: "capture",
  roomName: "meet_one", url: "ws://localhost:7880", token: "test-media-token", maxDurationSeconds: 60,
  speakers: [{ userId: "alice", mediaIdentity: "media-alice" }],
};
export const summaryJob: AiSummaryJob = {
  id: "job-2", leaseToken: "lease-2", aiSessionId: "ai-1", revision: 1, kind: "summarize", readers: ["alice"],
  segments: [{ id: "segment-1", speakerUserId: "alice", startMs: 0, endMs: 1_000, text: "We decided to ship Friday." }],
};
export const draft = { summary: [{ text: "Ship Friday", segmentIds: ["segment-1"] }], decisions: [], actionItems: [] };
