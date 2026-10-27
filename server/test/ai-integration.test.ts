import { randomUUID } from "node:crypto";
import { Client, type Room } from "@colyseus/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.config.js";
import { loadConfig } from "../src/config.js";
import { LiveKitService, type LiveKitBackend } from "../src/services/LiveKitService.js";
import type { OfficeState } from "../src/rooms/schema/OfficeState.js";
import type { AIStatus, GuestSession, MediaTransition, MeetingEntered, NoteRecord, RequestError } from "../../shared/src/protocol.js";
import { aiWorkerJobSchema, type AiCaptureJob, type AiDraftNotes, type AiSummaryJob } from "../../shared/src/ai-worker.js";

const config = loadConfig({ OFFICE_LAYOUT: "legacy",
  PUBLIC_SERVER_URL: "http://localhost:2567", ALLOWED_ORIGINS: "http://localhost:2567",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters", DATABASE_URL: ":memory:",
  GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
  AI_ENABLED: "true", AI_WORKER_SECRET: "test-worker-secret-distinct-and-at-least-32-characters",
});
type OfficeClient = Room<InstanceType<typeof OfficeState>>;
interface Person {
  guest: GuestSession; room: OfficeClient; seq: number;
  entered: MeetingEntered[]; transitions: MediaTransition[]; statuses: AIStatus[]; errors: RequestError[]; ready: { noteId: string; aiSessionId: string }[];
}
const backend: LiveKitBackend = {
  issueToken: vi.fn(async () => "member-media-token"), removeParticipant: vi.fn(async () => {}),
  deleteRoom: vi.fn(async () => {}), verifyWebhook: vi.fn(async () => { throw new Error("unused"); }),
};
const media = new LiveKitService(config, { backend });
let app: ReturnType<typeof createApplication>, base: string;
const people: Person[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean, timeout = 4000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error("Timed out waiting for AI integration state"); await pause(10); }
}
function post(path: string, body: unknown, token?: string, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
}
const worker = (path: string, body: unknown) => post(`/internal/ai/jobs/${path}`, body, config.aiWorkerSecret);
const get = (path: string, person?: Person) => fetch(base + path, { headers: person ? { Authorization: `Bearer ${person.guest.token}` } : {} });
async function claim() {
  const response = await worker("claim", { workerId: "integration-worker" });
  expect(response.status).toBe(200);
  const { job } = await response.json();
  if (job) expect(aiWorkerJobSchema.safeParse(job).success).toBe(true);
  return job as AiCaptureJob | AiSummaryJob | null;
}
async function join(name: string) {
  const guest = await (await post("/api/sessions/guest", { inviteCode: config.inviteCode, displayName: name })).json() as GuestSession;
  const seat = await post("/api/offices/demo-office/join", { protocolVersion: 1 }, guest.token);
  const room = await new Client(base).consumeSeatReservation<InstanceType<typeof OfficeState>>(await seat.json());
  const p: Person = { guest, room, seq: 0, entered: [], transitions: [], statuses: [], errors: [], ready: [] };
  room.onMessage("session.ready", () => {}); room.onMessage("audio.policy", () => {}); room.onMessage("meeting.exited", () => {});
  room.onMessage("meeting.entered", e => p.entered.push(e)); room.onMessage("media.transition", e => p.transitions.push(e));
  room.onMessage("request.error", e => p.errors.push(e)); room.onMessage("ai.status", e => p.statuses.push(e)); room.onMessage("notes.ready", e => p.ready.push(e));
  people.push(p);
  await eventually(() => room.state?.players?.has(room.sessionId) ?? false);
  return p;
}
async function walk(p: Person, path: { x: number; y: number }[]) {
  const player = p.room.state.players.get(p.room.sessionId)!;
  for (const target of path) {
    const until = Date.now() + 10_000;
    while (Math.hypot(target.x - player.x, target.y - player.y) > 0.05) {
      if (Date.now() > until) throw new Error(`Stuck at ${player.x},${player.y}`);
      const clamp = (v: number) => Math.max(-1, Math.min(1, v * 2));
      p.room.send("player.input", { seq: ++p.seq, dx: clamp(target.x - player.x), dy: clamp(target.y - player.y) });
      await pause(50);
    }
  }
  p.room.send("player.input", { seq: ++p.seq, dx: 0, dy: 0 });
}
const enter = (p: Person) => walk(p, [{ x: p.room.state.players.get(p.room.sessionId)!.x, y: 7.5 }, { x: 23, y: 7.5 }]);
const latest = (p: Person) => p.statuses.at(-1);
async function request(p: Person) {
  const before = p.statuses.length;
  p.room.send("ai.request", { requestId: randomUUID() });
  await eventually(() => p.statuses.length > before && latest(p)?.status === "requesting_consent");
  return latest(p)!;
}
async function approve(p: Person, s: AIStatus) {
  p.room.send("ai.consent", { aiSessionId: s.aiSessionId, revision: s.revision, consent: true });
  await eventually(() => latest(p)?.roster.find(r => r.userId === p.guest.userId)?.consented === true);
}
function draft(userId: string): AiDraftNotes {
  return { summary: [{ text: "Design discussion", segmentIds: ["source-1"] }], decisions: [], actionItems: [{ text: "Send the design", segmentIds: ["source-1"], ownerUserId: userId, dueAt: null }] };
}
beforeAll(async () => { app = createApplication(config, { reconnectionSeconds: 0 }, media); base = `http://127.0.0.1:${await app.start(0)}`; });
afterAll(async () => { for (const p of people) if (p.room.connection.isOpen) await p.room.leave(); await app.stop(); });

describe("M4 authenticated worker HTTP and Colyseus meeting integration", () => {
  it("keeps worker routes private and validates their contract before dispatch", async () => {
    const outsider = await join("Outside observer");
    expect((await post("/internal/ai/jobs/claim", { workerId: "browser" })).status).toBe(401);
    expect((await post("/internal/ai/jobs/claim", { workerId: "guest" }, outsider.guest.token)).status).toBe(401);
    expect((await post("/internal/ai/jobs/claim", { workerId: "worker" }, config.aiWorkerSecret, { Origin: config.allowedOrigins[0]! })).status).toBe(403);
    expect((await worker("claim", { workerId: "worker", forgedRoom: "room" })).status).toBe(400);
    expect((await worker("job/segments", { leaseToken: "x", segments: [{ id: "x", speakerUserId: "x", startMs: 10, endMs: 0, text: "invalid" }] })).status).toBe(400);
    expect(await claim()).toBeNull();
    outsider.room.send("ai.request", { requestId: randomUUID() });
    await eventually(() => outsider.errors.length > 0);
    expect(outsider.errors.at(-1)?.code).toBe("FORBIDDEN");
    expect((await get("/api/notes")).status).toBe(401);
    expect(await (await get("/api/notes", outsider)).json()).toEqual({ notes: [] });
  });

  it("captures only with unanimous consent, saves private notes, and revokes capture before a new entrant hears the meeting", async () => {
    const outsider = people[0]!;
    const [ada, grace] = [await join("Ada"), await join("Grace")];
    await Promise.all([enter(ada), enter(grace)]);
    await eventually(() => ada.entered.length === 1 && grace.entered.length === 1);
    expect(await claim()).toBeNull();
    const initial = await request(ada);
    await eventually(() => latest(grace)?.aiSessionId === initial.aiSessionId);
    expect(outsider.statuses).toEqual([]);
    await approve(ada, initial);
    expect(await claim()).toBeNull();
    await approve(grace, initial);
    await eventually(() => latest(ada)?.status === "capturing");
    const capture = await claim() as AiCaptureJob;
    expect(capture.kind).toBe("capture");
    expect(capture.speakers.map(s => s.userId).sort()).toEqual([ada.guest.userId, grace.guest.userId].sort());
    const jwt = JSON.parse(Buffer.from(capture.token.split(".")[1]!, "base64url").toString("utf8"));
    expect(jwt.video).toMatchObject({ room: capture.roomName, roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false });
    expect(await claim()).toBeNull();
    const source = { id: "source-1", speakerUserId: ada.guest.userId, startMs: 0, endMs: 1000, text: "Private design discussion." };
    expect((await worker(`${capture.id}/segments`, { leaseToken: capture.leaseToken, segments: [source] })).status).toBe(200);
    ada.room.send("ai.stop", { aiSessionId: initial.aiSessionId, revision: initial.revision });
    await eventually(() => latest(ada)?.status === "processing");
    expect(await (await worker(`${capture.id}/heartbeat`, { leaseToken: capture.leaseToken })).json()).toMatchObject({ active: false });
    const summary = await claim() as AiSummaryJob;
    expect(summary.kind).toBe("summarize"); expect(summary.segments).toEqual([source]);
    expect(summary.context?.participants.map(p => p.userId).sort()).toEqual([...summary.readers].sort());
    expect(summary.context?.participants.every(p => Boolean(p.displayName))).toBe(true);
    expect(Number.isFinite(Date.parse(summary.context!.conversationStartedAt))).toBe(true);
    expect(summary.context?.timeZone).toBe("UTC");
    expect((await worker(`${summary.id}/complete`, { leaseToken: summary.leaseToken, notes: draft(outsider.guest.userId) })).status).toBe(400);
    expect((await worker(`${summary.id}/complete`, { leaseToken: summary.leaseToken, notes: draft(ada.guest.userId) })).status).toBe(200);
    await eventually(() => ada.ready.length === 1 && grace.ready.length === 1);
    expect(outsider.ready).toEqual([]);
    const noteId = ada.ready[0]!.noteId;
    const note = await (await get(`/api/notes/${noteId}`, ada)).json() as NoteRecord;
    expect(note).toMatchObject({ id: noteId, aiSessionId: initial.aiSessionId, draft: draft(ada.guest.userId) });
    expect(await (await get(`/api/notes/${noteId}`, grace)).json()).toEqual(note);
    expect((await get(`/api/notes/${noteId}`, outsider)).status).toBe(404);
    expect(await (await get("/api/notes", outsider)).json()).toEqual({ notes: [] });
    expect(JSON.stringify(outsider.room.state.toJSON())).not.toContain(source.text);
    expect(JSON.stringify(outsider.room.state.toJSON())).not.toContain(capture.token);

    const second = await request(ada); await approve(ada, second); await approve(grace, second);
    const oldCapture = await claim() as AiCaptureJob;
    expect(oldCapture.kind).toBe("capture");
    expect((await worker(`${oldCapture.id}/segments`, { leaseToken: oldCapture.leaseToken, segments: [source] })).status).toBe(200);
    const beforeRevision = media.getBinding(ada.room.sessionId)!.transitionRevision;
    await enter(outsider);
    await eventually(() => latest(ada)?.status === "paused" && latest(outsider)?.status === "paused");
    expect(latest(ada)?.revision).toBe(second.revision + 1);
    expect(latest(ada)?.roster.every(r => !r.consented)).toBe(true);
    expect(media.getBinding(ada.room.sessionId)!.transitionRevision).toBeGreaterThan(beforeRevision);
    expect(media.getBinding(ada.room.sessionId)!.roomName).not.toBe(oldCapture.roomName);
    expect(backend.deleteRoom).toHaveBeenCalledWith(oldCapture.roomName);
    expect(await (await worker(`${oldCapture.id}/heartbeat`, { leaseToken: oldCapture.leaseToken })).json()).toMatchObject({ active: false });
    expect((await worker(`${oldCapture.id}/segments`, { leaseToken: oldCapture.leaseToken, segments: [source] })).status).toBe(403);
    expect(await (await worker(`${oldCapture.id}/complete`, { leaseToken: oldCapture.leaseToken })).json()).toEqual({ accepted: false });
    expect(await claim()).toBeNull();
    const paused = latest(ada)!;
    for (const p of [ada, grace, outsider]) await approve(p, paused);
    const fresh = await claim() as AiCaptureJob;
    expect(fresh.kind).toBe("capture"); expect(fresh.roomName).not.toBe(oldCapture.roomName);
    expect(fresh.speakers).toHaveLength(3);
    // Stopping without any new audio must not summarize the previous roster's transcript.
    ada.room.send("ai.stop", { aiSessionId: paused.aiSessionId, revision: paused.revision });
    await eventually(() => latest(ada)?.status === "failed");
    expect(latest(ada)?.error).toBe("NO_TRANSCRIPT");
    expect(await claim()).toBeNull();
    expect(await (await get("/api/notes", outsider)).json()).toEqual({ notes: [] });
  }, 45_000);

  it("finishes the last occupant's capture on walking out and sends private notes.ready to that guest on the floor", async () => {
    const [outsider, ada, grace] = people;
    await Promise.all([outsider!.room.leave(), grace!.room.leave()]);
    await eventually(() => ada!.room.state.meetings.get("meeting-east")?.occupancy === 1);
    const s = await request(ada!); await approve(ada!, s);
    const capture = await claim() as AiCaptureJob;
    expect(capture.speakers).toHaveLength(1);
    expect((await worker(`${capture.id}/segments`, { leaseToken: capture.leaseToken, segments: [{ id: "source-1", speakerUserId: ada!.guest.userId, startMs: 0, endMs: 1000, text: "I will send the design." }] })).status).toBe(200);
    const readyCount = ada!.ready.length;
    await walk(ada!, [{ x: 19, y: 7.5 }]);
    await eventually(() => !ada!.room.state.meetings.has("meeting-east") && latest(ada!)?.status === "processing");
    expect(media.getBinding(ada!.room.sessionId)?.mode).toBe("floor");
    const summary = await claim() as AiSummaryJob;
    expect(summary.kind).toBe("summarize");
    expect(summary.readers).toEqual([ada!.guest.userId]);
    expect((await worker(`${summary.id}/complete`, { leaseToken: summary.leaseToken, notes: draft(ada!.guest.userId) })).status).toBe(200);
    await eventually(() => ada!.ready.length === readyCount + 1);
    const noteId = ada!.ready.at(-1)!.noteId;
    expect((await get(`/api/notes/${noteId}`, ada)).status).toBe(200);
    expect((await get(`/api/notes/${noteId}`, grace)).status).toBe(404);
    expect((await get(`/api/notes/${noteId}`, outsider)).status).toBe(404);
  }, 15_000);
});
