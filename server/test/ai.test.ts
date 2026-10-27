import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AIRepository } from "../src/repositories/AIRepository.js";
import { openStorage, type Storage } from "../src/repositories/Storage.js";
import { AIError, AISessionService, type AIMeeting, type AIMember } from "../src/services/AISessionService.js";
import type { LiveKitService } from "../src/services/LiveKitService.js";
import { aiWorkerJobSchema, type AiCaptureJob, type AiDraftNotes, type AiSummaryJob, type AiTranscriptSegment } from "../../shared/src/ai-worker.js";

const config = loadConfig({
  PUBLIC_SERVER_URL: "http://localhost:2567", ALLOWED_ORIGINS: "http://localhost:2567",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters", DATABASE_URL: ":memory:",
  GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:7880", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
  AI_ENABLED: "true", AI_WORKER_SECRET: "test-worker-secret-distinct-and-at-least-32-characters",
});
let storage: Storage, repo: AIRepository, service: AISessionService;
let directory: string, databasePath: string;
let ada: AIMember, grace: AIMember, outsider: AIMember, meeting: AIMeeting;
const media = { issueAssistant: vi.fn(async () => "assistant-token"), removeAssistant: vi.fn(async () => {}) };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  vi.clearAllMocks();
  media.issueAssistant.mockResolvedValue("assistant-token");
  directory = mkdtempSync(join(tmpdir(), "office-ai-"));
  databasePath = join(directory, "office.sqlite");
  storage = openStorage(databasePath);
  repo = new AIRepository(storage);
  const member = (name: string): AIMember => ({ ...storage.createGuest(name, config.officeId), sessionId: randomUUID(), mediaIdentity: randomUUID() });
  ada = member("Ada"); grace = member("Grace"); outsider = member("Outsider");
  meeting = { meetingSessionId: randomUUID(), roomName: "meeting-epoch-1", members: [ada, grace], send: vi.fn(), indicator: vi.fn(), rotate: vi.fn() };
  service = new AISessionService(repo, config, media as unknown as LiveKitService);
  service.syncMeeting(meeting.meetingSessionId, meeting);
});
afterEach(() => {
  service.shutdown();
  storage.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
function request() { return service.request(meeting.meetingSessionId, ada.sessionId, randomUUID()); }
function approve(id: string, revision = 1) {
  service.consent(ada.sessionId, id, revision, true);
  service.consent(grace.sessionId, id, revision, true);
}
async function capture() {
  const s = request(); approve(s.aiSessionId);
  const job = await service.claim();
  expect(job?.kind).toBe("capture");
  expect(aiWorkerJobSchema.safeParse(job).success).toBe(true);
  return { session: repo.get(s.aiSessionId)!, job: job as AiCaptureJob };
}
function segment(speakerUserId = ada.userId, id = "segment-1"): AiTranscriptSegment {
  return { id, speakerUserId, startMs: 0, endMs: 1500, text: "Ada will send the design tomorrow." };
}
function notes(segmentId = "segment-1", ownerUserId: string | null = ada.userId): AiDraftNotes {
  return { summary: [{ text: "The team discussed the design.", segmentIds: [segmentId] }], decisions: [], actionItems: [{ text: "Send the design", segmentIds: [segmentId], ownerUserId, dueAt: null }] };
}
async function processing() {
  const { session, job } = await capture();
  service.segments(job.id, job.leaseToken, [segment()]);
  service.stop(ada.sessionId, session.aiSessionId, session.revision);
  const summary = await service.claim();
  expect(summary?.kind).toBe("summarize");
  expect(aiWorkerJobSchema.safeParse(summary).success).toBe(true);
  return { session, capture: job, job: summary as AiSummaryJob };
}
function expectCode(action: () => unknown, code: string) {
  try { action(); throw new Error("Expected an AI authorization error"); }
  catch (error) { expect(error).toBeInstanceOf(AIError); expect((error as AIError).code).toBe(code); }
}

describe("M4 explicit requests and consent", () => {
  it("does not capture on meeting entry, request alone, or partial consent; dispatch is idempotent", async () => {
    expect(await service.claim()).toBeNull();
    const id = randomUUID();
    const s = service.request(meeting.meetingSessionId, ada.sessionId, id);
    expect(service.request(meeting.meetingSessionId, ada.sessionId, id).aiSessionId).toBe(s.aiSessionId);
    expect(service.request(meeting.meetingSessionId, grace.sessionId, randomUUID()).aiSessionId).toBe(s.aiSessionId);
    expect(await service.claim()).toBeNull();
    service.consent(ada.sessionId, s.aiSessionId, 1, true);
    service.consent(ada.sessionId, s.aiSessionId, 1, true);
    expect(await service.claim()).toBeNull();
    expect(media.issueAssistant).not.toHaveBeenCalled();
    service.consent(grace.sessionId, s.aiSessionId, 1, true);
    service.consent(grace.sessionId, s.aiSessionId, 1, true);
    const job = await service.claim();
    expect(job?.kind).toBe("capture");
    expect(await service.claim()).toBeNull();
    expect(media.issueAssistant).toHaveBeenCalledTimes(1);
    expect(storage.db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 1 });
  });

  it("requires current meeting membership and current consent revision", () => {
    const s = request();
    expectCode(() => service.request(meeting.meetingSessionId, outsider.sessionId, randomUUID()), "FORBIDDEN");
    expectCode(() => service.consent(outsider.sessionId, s.aiSessionId, 1, true), "FORBIDDEN");
    expectCode(() => service.stop(outsider.sessionId, s.aiSessionId, 1), "FORBIDDEN");
    expectCode(() => service.consent(ada.sessionId, s.aiSessionId, 0, true), "STALE_CONSENT");
    expectCode(() => service.stop(ada.sessionId, "missing", 1), "NOT_FOUND");
  });

  it("authenticates worker calls with a distinct exact bearer secret", () => {
    service.authenticate(`Bearer ${config.aiWorkerSecret}`);
    for (const header of [undefined, "", config.aiWorkerSecret, `Bearer ${config.sessionSecret}`, `Bearer ${config.aiWorkerSecret}x`]) {
      expectCode(() => service.authenticate(header), "UNAUTHORIZED");
    }
    const disabled = new AISessionService(repo, { ...config, aiEnabled: false }, media as unknown as LiveKitService);
    expectCode(() => disabled.authenticate(`Bearer ${config.aiWorkerSecret}`), "UNAUTHORIZED");
    expectCode(() => disabled.request(meeting.meetingSessionId, ada.sessionId, randomUUID()), "AI_UNAVAILABLE");
  });

  it("resets all consent, erases old context, and revokes leases when the roster changes", async () => {
    const { session, job } = await capture();
    service.segments(job.id, job.leaseToken, [segment()]);
    meeting = { ...meeting, members: [ada, grace, outsider], roomName: "meeting-epoch-2" };
    expect(service.syncMeeting(meeting.meetingSessionId, meeting)).toBe(true);
    const reset = repo.get(session.aiSessionId)!;
    expect(reset).toMatchObject({ status: "paused", revision: 2, partial: true, readers: [] });
    expect(reset.roster.map(r => r.consented)).toEqual([false, false, false]);
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    expect(media.removeAssistant).toHaveBeenCalledTimes(1);
    expect(service.heartbeat(job.id, job.leaseToken).active).toBe(false);
    expectCode(() => service.segments(job.id, job.leaseToken, [segment()]), "FORBIDDEN");
    expect(service.complete(job.id, job.leaseToken)).toEqual({ accepted: false });
    expectCode(() => service.consent(ada.sessionId, session.aiSessionId, 1, true), "STALE_CONSENT");
    approve(session.aiSessionId, 2);
    expect(await service.claim()).toBeNull();
    service.consent(outsider.sessionId, session.aiSessionId, 2, true);
    const fresh = await service.claim();
    expect(fresh).toMatchObject({ kind: "capture", revision: 2, roomName: "meeting-epoch-2" });
    expect(fresh!.leaseToken).not.toBe(job.leaseToken);
  });

  it("rejects a token issued after consent was withdrawn during asynchronous dispatch", async () => {
    let release!: (token: string) => void;
    media.issueAssistant.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const s = request(); approve(s.aiSessionId);
    const claimed = service.claim();
    service.consent(grace.sessionId, s.aiSessionId, 1, false);
    release("late-token");
    expect(await claimed).toBeNull();
    expect(repo.get(s.aiSessionId)?.status).toBe("canceled");
    expect(media.removeAssistant).toHaveBeenCalled();
    expect(meeting.rotate).toHaveBeenCalledTimes(1);
  });
});

describe("M4 private transcript and structured notes lifecycle", () => {
  it("does not requeue a free-tier quota failure", async () => {
    const { session, job } = await processing();
    service.fail(job.id, job.leaseToken, "QUOTA_EXCEEDED");
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "failed", error: "QUOTA_EXCEEDED" });
    expect(await service.claim()).toBeNull();
  });
  it.each(["capture", "processing"] as const)("withdrawal during %s deletes transcript and rejects late worker results", async phase => {
    const { session, job: captureJob } = await capture();
    service.segments(captureJob.id, captureJob.leaseToken, [segment()]);
    let job: AiCaptureJob | AiSummaryJob = captureJob;
    if (phase === "processing") {
      service.stop(ada.sessionId, session.aiSessionId, 1);
      job = await service.claim() as AiSummaryJob;
    }
    service.consent(grace.sessionId, session.aiSessionId, 1, false);
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "canceled", revision: 2 });
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    expect(service.heartbeat(job.id, job.leaseToken)).toEqual({ active: false, finish: false });
    expect(service.complete(job.id, job.leaseToken, notes())).toEqual({ accepted: false });
    expect(repo.notes(ada.userId)).toEqual([]);
    expect(await service.claim()).toBeNull();
  });

  it("stops capture, freezes readers, persists private notes across restart, and deletes raw text", async () => {
    const { session, capture: captureJob, job } = await processing();
    expect(media.removeAssistant).toHaveBeenCalledTimes(1);
    expect(meeting.rotate).toHaveBeenCalledTimes(1);
    expect(service.heartbeat(captureJob.id, captureJob.leaseToken).active).toBe(false);
    expect(job.readers).toEqual([ada.userId, grace.userId]);
    expect(job.segments).toEqual([segment()]);
    meeting = { ...meeting, members: [outsider] };
    service.syncMeeting(meeting.meetingSessionId, meeting);
    expectCode(() => service.consent(outsider.sessionId, session.aiSessionId, session.revision, false), "FORBIDDEN");
    expectCode(() => service.stop(outsider.sessionId, session.aiSessionId, session.revision), "FORBIDDEN");
    expect(repo.get(session.aiSessionId)?.status).toBe("processing");
    expect(service.complete(job.id, job.leaseToken, notes())).toEqual({ accepted: true });
    expect(service.complete(job.id, job.leaseToken, notes())).toEqual({ accepted: false });
    const [note] = repo.notes(ada.userId);
    expect(note).toMatchObject({ aiSessionId: session.aiSessionId, partial: true, draft: notes() });
    expect(repo.note(note!.id, grace.userId)).toEqual(note);
    expect(repo.note(note!.id, outsider.userId)).toBeUndefined();
    expect(repo.notes(outsider.userId)).toEqual([]);
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    expect(repo.get(session.aiSessionId)?.status).toBe("completed");
    storage.close();
    storage = openStorage(databasePath); repo = new AIRepository(storage);
    service = new AISessionService(repo, config, media as unknown as LiveKitService);
    expect(repo.notes(ada.userId)).toEqual([note]);
    expect(repo.note(note!.id, outsider.userId)).toBeUndefined();
  });

  it("rejects forged speakers, conflicting segment IDs, and rolls back a bad batch", async () => {
    const { session, job } = await capture();
    expectCode(() => service.segments(job.id, job.leaseToken, [segment(), segment(outsider.userId, "forged")]), "INVALID_INPUT");
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    service.segments(job.id, job.leaseToken, [segment(), segment()]);
    expect(repo.segments(session.aiSessionId)).toHaveLength(1);
    expectCode(() => service.segments(job.id, job.leaseToken, [{ ...segment(), text: "altered" }]), "INVALID_INPUT");
    expectCode(() => service.segments(job.id, job.leaseToken, [{ ...segment(ada.userId, "too-long"), endMs: config.aiMaxDurationSeconds * 1000 + 1 }]), "INVALID_INPUT");
    expect(repo.segments(session.aiSessionId)).toEqual([segment()]);
  });

  it("rejects forged source references, forged action owners, malformed notes, and capture uploads to summary jobs", async () => {
    const { session, job } = await processing();
    expectCode(() => service.complete(job.id, job.leaseToken, notes("unknown-source")), "INVALID_INPUT");
    expectCode(() => service.complete(job.id, job.leaseToken, notes("segment-1", outsider.userId)), "INVALID_INPUT");
    for (const invalid of [undefined, null, {}, { ...notes(), extra: true }, { ...notes(), summary: [{ text: "Unsourced", segmentIds: [] }] }, { ...notes(), actionItems: [{ ...notes().actionItems[0], dueAt: "tomorrow" }] }]) {
      expectCode(() => service.complete(job.id, job.leaseToken, invalid), "INVALID_INPUT");
    }
    expectCode(() => service.segments(job.id, job.leaseToken, [segment()]), "FORBIDDEN");
    expect(repo.notes(ada.userId)).toEqual([]);
    expect(repo.get(session.aiSessionId)?.status).toBe("processing");
    expect(repo.segments(session.aiSessionId)).toHaveLength(1);
    expect(service.complete(job.id, job.leaseToken, notes())).toEqual({ accepted: true });
  });

  it("fails a stop without transcript and removes all active worker authorization", async () => {
    const { session, job } = await capture();
    service.stop(ada.sessionId, session.aiSessionId, 1);
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "failed", error: "NO_TRANSCRIPT" });
    expect(service.complete(job.id, job.leaseToken)).toEqual({ accepted: false });
    expect(await service.claim()).toBeNull();
    expect(repo.notes(ada.userId)).toEqual([]);
  });

  it("automatically finalizes when the last member exits and privately delivers notes after meeting removal", async () => {
    meeting.members = [ada];
    service.syncMeeting(meeting.meetingSessionId, meeting);
    const s = request(); service.consent(ada.sessionId, s.aiSessionId, 1, true);
    const job = await service.claim() as AiCaptureJob;
    service.segments(job.id, job.leaseToken, [segment()]);
    expect(service.syncMeeting(meeting.meetingSessionId)).toBe(false);
    expect(repo.get(s.aiSessionId)?.status).toBe("processing");
    expect(service.heartbeat(job.id, job.leaseToken).active).toBe(false);
    const summary = await service.claim() as AiSummaryJob;
    expect(summary).toMatchObject({ kind: "summarize", readers: [ada.userId], segments: [segment()] });
    vi.mocked(meeting.send).mockClear();
    expect(service.complete(summary.id, summary.leaseToken, notes())).toEqual({ accepted: true });
    expect(meeting.send).toHaveBeenCalledWith(ada.userId, "notes.ready", expect.objectContaining({ aiSessionId: s.aiSessionId }));
    expect(vi.mocked(meeting.send).mock.calls.every(([userId]) => userId === ada.userId)).toBe(true);
    expect(repo.notes(ada.userId)).toHaveLength(1);
    expect(repo.notes(grace.userId)).toEqual([]);
    expect(repo.segments(s.aiSessionId)).toEqual([]);
  });
});

describe("M4 worker leases and durable recovery", () => {
  it("reports worker liveness separately and bounds a capture waiting for dispatch", () => {
    expect(service.workerStatus()).toBe("down");
    service.authenticate(`Bearer ${config.aiWorkerSecret}`);
    expect(service.workerStatus()).toBe("up");
    const s=request(); approve(s.aiSessionId);
    vi.setSystemTime(Date.now()+16000); service.tick();
    expect(service.workerStatus()).toBe("down");
    expect(repo.get(s.aiSessionId)).toMatchObject({status:"failed",error:"WORKER_DISPATCH_TIMEOUT"});
    expect(repo.segments(s.aiSessionId)).toEqual([]);
  });

  it("charges consent waiting against the total session duration budget", async () => {
    const s=request();
    vi.setSystemTime(Date.now()+300000);
    approve(s.aiSessionId);
    const job=await service.claim() as AiCaptureJob;
    expect(job.kind).toBe("capture");
    expect(job.maxDurationSeconds).toBe(300);
  });

  it("rejects wrong and exactly expired leases; heartbeat extends only a live lease", async () => {
    const { session, job } = await capture();
    expect(service.heartbeat(job.id, "forged").active).toBe(false);
    expectCode(() => service.segments(job.id, "forged", [segment()]), "FORBIDDEN");
    expect(service.complete(job.id, "forged")).toEqual({ accepted: false });
    vi.setSystemTime(Date.now() + 14_000);
    expect(service.heartbeat(job.id, job.leaseToken).active).toBe(true);
    vi.setSystemTime(Date.now() + 15_000);
    expect(service.heartbeat(job.id, job.leaseToken).active).toBe(false);
    expectCode(() => service.segments(job.id, job.leaseToken, [segment()]), "FORBIDDEN");
    service.tick();
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "failed", error: "WORKER_LEASE_EXPIRED" });
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    expect(media.removeAssistant).toHaveBeenCalledTimes(1);
  });

  it("retries summary once with a fresh lease, rejects old responses, then erases a second expiry", async () => {
    const { session, job } = await processing();
    vi.setSystemTime(Date.now() + 15_000); service.tick();
    const retry = await service.claim() as AiSummaryJob;
    expect(retry.id).toBe(job.id);
    expect(retry.leaseToken).not.toBe(job.leaseToken);
    expect(retry.segments).toEqual(job.segments);
    expect(repo.job(job.id)?.attempts).toBe(2);
    expect(service.complete(job.id, job.leaseToken, notes())).toEqual({ accepted: false });
    vi.setSystemTime(Date.now() + 15_000); service.tick();
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "failed", error: "WORKER_LEASE_EXPIRED" });
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    expect(await service.claim()).toBeNull();
  });

  it("retries a reported summary failure once and never retries capture", async () => {
    const { session, job } = await processing();
    service.fail(job.id, job.leaseToken, "PROVIDER_FAILED");
    const retry = await service.claim() as AiSummaryJob;
    service.fail(retry.id, retry.leaseToken, "PROVIDER_FAILED");
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "failed", error: "PROVIDER_FAILED" });
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    const second = await capture();
    service.fail(second.job.id, second.job.leaseToken, "CAPTURE_FAILED");
    expect(repo.get(second.session.aiSessionId)).toMatchObject({ status: "failed", error: "CAPTURE_FAILED" });
    expect(await service.claim()).toBeNull();
  });

  it("invalidates in-flight work and raw transcript after an unclean application restart", async () => {
    const { session, job } = await processing();
    storage.close();
    storage = openStorage(databasePath); repo = new AIRepository(storage);
    service = new AISessionService(repo, config, media as unknown as LiveKitService);
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "failed", error: "SERVER_RESTARTED" });
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    expect(service.complete(job.id, job.leaseToken, notes())).toEqual({ accepted: false });
    expect(await service.claim()).toBeNull();
    expect(repo.notes(ada.userId)).toEqual([]);
  });

  it("bounds processing to two minutes even while the worker keeps its lease alive", async () => {
    const { session, job } = await processing();
    for (let step = 0; step < 12; step++) {
      vi.setSystemTime(Date.now() + 10_000);
      expect(service.heartbeat(job.id, job.leaseToken).active).toBe(true);
      service.tick();
    }
    expect(repo.get(session.aiSessionId)?.status).toBe("processing");
    vi.setSystemTime(Date.now() + 1); service.tick();
    expect(repo.get(session.aiSessionId)).toMatchObject({ status: "failed", error: "PROCESSING_TIMEOUT" });
    expect(service.complete(job.id, job.leaseToken, notes())).toEqual({ accepted: false });
    expect(repo.segments(session.aiSessionId)).toEqual([]);
    expect(repo.notes(ada.userId)).toEqual([]);
  });
});
