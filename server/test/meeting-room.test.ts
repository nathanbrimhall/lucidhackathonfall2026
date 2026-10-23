import { createHash } from "node:crypto";
import { Client, type Room } from "@colyseus/sdk";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.config.js";
import { loadConfig } from "../src/config.js";
import { LiveKitService, type LiveKitBackend, type MediaBinding } from "../src/services/LiveKitService.js";
import type { OfficeState } from "../src/rooms/schema/OfficeState.js";
import type { AudioPolicy, GuestSession, MediaCredentials, MediaTransition, MeetingEntered, MeetingExited, RequestError } from "../../shared/src/protocol.js";

const config = loadConfig({
  PUBLIC_SERVER_URL: "http://localhost:2567", ALLOWED_ORIGINS: "http://localhost:2567",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters", DATABASE_URL: ":memory:",
  GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
});
type State = InstanceType<typeof OfficeState>;
type OfficeClient = Room<State>;
interface Inbox { transitions: MediaTransition[]; entered: MeetingEntered[]; exited: MeetingExited[]; errors: RequestError[]; policy?: AudioPolicy; seq: number }
interface Person { guest: GuestSession; room: OfficeClient; inbox: Inbox }
const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
const backend: LiveKitBackend = {
  issueToken: vi.fn(async (binding: Readonly<MediaBinding>) => `signed-${binding.roomName}-${binding.transitionRevision}`),
  removeParticipant: vi.fn(async () => {}), deleteRoom: vi.fn(async () => {}),
  verifyWebhook: (body, auth) => receiver.receive(body, auth),
  // Reconciliation always fails here; the office must keep working.
  listRooms: vi.fn(async (): Promise<string[]> => { throw new Error("livekit unavailable"); }),
  listParticipants: vi.fn(async () => []),
};
const media = new LiveKitService(config, { backend });
const ZONE = "meeting-east";
let app: ReturnType<typeof createApplication>, base: string;
const people = new Set<Person>();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error("Timed out waiting for meeting state"); await pause(10); }
}
function post(path: string, body: unknown, token?: string) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
function listen(room: OfficeClient, inbox: Inbox = { transitions: [], entered: [], exited: [], errors: [], seq: 0 }) {
  room.onMessage("session.ready", () => {});
  room.onMessage("request.error", error => inbox.errors.push(error));
  room.onMessage("audio.policy", policy => { inbox.policy = policy; });
  room.onMessage("media.transition", transition => inbox.transitions.push(transition));
  room.onMessage("meeting.entered", entered => inbox.entered.push(entered));
  room.onMessage("meeting.exited", exited => inbox.exited.push(exited));
  return inbox;
}
async function join(name: string): Promise<Person> {
  const guest = await (await post("/api/sessions/guest", { inviteCode: config.inviteCode, displayName: name })).json() as GuestSession;
  const seat = await post("/api/offices/demo-office/join", { protocolVersion: 1 }, guest.token);
  const room = await new Client(base).consumeSeatReservation<State>(await seat.json());
  const person = { guest, room, inbox: listen(room) };
  people.add(person);
  await eventually(() => room.state?.players?.has(room.sessionId) ?? false);
  room.send("media.preferences", { muted: false, deafened: false });
  return person;
}
async function leave(person: Person) {
  people.delete(person);
  if (person.room.connection.isOpen) { person.room.reconnection.enabled = false; await person.room.leave(); }
}
const self = ({ room }: Person) => room.state.players.get(room.sessionId)!;
/** Real authoritative movement: proportional input slows near each waypoint, then an explicit stop. */
async function walk(person: Person, path: { x: number; y: number }[]) {
  const player = self(person);
  for (const target of path) {
    const until = Date.now() + 10_000;
    while (Math.hypot(target.x - player.x, target.y - player.y) > 0.05) {
      if (Date.now() > until) throw new Error(`Stuck at ${player.x},${player.y} walking to ${target.x},${target.y}`);
      const clamp = (v: number) => Math.max(-1, Math.min(1, v * 2));
      person.room.send("player.input", { seq: ++person.inbox.seq, dx: clamp(target.x - player.x), dy: clamp(target.y - player.y) });
      await pause(50);
    }
  }
  person.room.send("player.input", { seq: ++person.inbox.seq, dx: 0, dy: 0 });
}
/** Through the west doorway (y 6–8) to a point inside the meeting room. */
const enter = (person: Person, x = 23, y = 7.5) => walk(person, [{ x: self(person).x, y: 7.5 }, { x: 22.5, y: 7.5 }, { x, y }]);
const exit = (person: Person) => walk(person, [{ x: self(person).x, y: 7.5 }, { x: 19, y: 7.5 }]);
function token(person: Person, transitionRevision?: number) {
  return post("/api/media/token", { sessionId: person.room.sessionId, ...(transitionRevision === undefined ? {} : { transitionRevision }) }, person.guest.token);
}
async function ackAndFetch(person: Person, revision: number) {
  person.room.send("media.transition.ack", { revision });
  await eventually(() => media.getBinding(person.room.sessionId)?.acked === true);
  const response = await token(person, revision);
  expect(response.status).toBe(200);
  return await response.json() as MediaCredentials;
}
async function webhook(payload: object) {
  const body = JSON.stringify(payload);
  const access = new AccessToken(config.livekitApiKey, config.livekitApiSecret);
  access.sha256 = createHash("sha256").update(body).digest("base64");
  return fetch(base + "/api/livekit/webhook", { method: "POST", headers: { "Content-Type": "application/webhook+json", Authorization: await access.toJwt() }, body });
}
const identity = (person: Person) => media.getBinding(person.room.sessionId)!.mediaIdentity;
const deleted = (room: string) => vi.mocked(backend.deleteRoom).mock.calls.some(([name]) => name === room);
function expectPublicStateClean(person: Person) {
  expect(JSON.stringify(person.room.state.toJSON())).not.toMatch(/meet_|floor_|signed-|seat_/);
}

beforeAll(async () => {
  app = createApplication(config, { reconnectionSeconds: 3 }, media);
  base = `http://127.0.0.1:${await app.start(0)}`;
});
afterAll(async () => {
  for (const person of people) await leave(person);
  await app.stop();
});

describe("M3 meeting-room zones with private media", () => {
  it("keeps a private meeting from the person outside the wall, rotates on exit, and ends with the last occupant", async () => {
    const [a, b, c] = [await join("Ada"), await join("Bob"), await join("Cy")];
    const floorTokens = await Promise.all([a, b, c].map(async person => await (await token(person)).json() as MediaCredentials));
    expect(floorTokens.every(t => t.mode === "floor" && t.roomName === floorTokens[0].roomName && t.transitionRevision === 0)).toBe(true);
    await Promise.all([enter(a), enter(b, 24, 9.5), walk(c, [{ x: self(c).x, y: 9 }, { x: 20.7, y: 9 }])]);
    await eventually(() => a.inbox.entered.length === 1 && b.inbox.entered.length === 1 && a.inbox.transitions.length === 1 && b.inbox.transitions.length === 1);
    const meetingSessionId = a.inbox.entered[0].meetingSessionId;
    expect(a.inbox.entered[0]).toEqual({ zoneId: ZONE, meetingSessionId, name: "East meeting room", videoAvailable: true, revision: 1 });
    for (const { inbox } of [a, b]) expect(inbox.transitions[0]).toEqual({ revision: 1, mode: "meeting", zoneId: ZONE, meetingSessionId, reason: "zone_change" });
    expect(c.inbox.transitions).toEqual([]);
    expect(backend.removeParticipant).toHaveBeenCalledWith(floorTokens[0].roomName, identity(a));

    // Credentials wait for the current revision and the client's acknowledgement.
    for (const revision of [undefined, 1]) {
      const pending = await token(b, revision);
      expect(pending.status).toBe(409);
      expect(await pending.json()).toMatchObject({ error: { code: "TRANSITION_PENDING" } });
    }
    const stale = await token(b, 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "STALE_TRANSITION" } });
    b.room.send("media.transition.ack", { revision: 0 });
    b.room.send("media.transition.ack", { revision: 9 });
    b.room.send("media.transition.ack", { revision: "1" });
    await eventually(() => b.inbox.errors.length === 1);
    expect(b.inbox.errors[0].code).toBe("INVALID_INPUT");
    expect(media.getBinding(b.room.sessionId)?.acked).toBe(false);

    const [fromA, fromB] = [await ackAndFetch(a, 1), await ackAndFetch(b, 1)];
    const firstRoom = fromA.roomName;
    expect(firstRoom).toMatch(/^meet_/);
    expect(fromB).toMatchObject({ roomName: firstRoom, mode: "meeting", zoneId: ZONE, meetingSessionId, transitionRevision: 1, mediaIdentity: identity(b) });
    expect(await (await token(c)).json()).toMatchObject({ mode: "floor", zoneId: "", roomName: floorTokens[0].roomName });

    await eventually(() => a.inbox.policy?.mode === "meeting" && a.inbox.policy.speakers.length === 1 && b.inbox.policy?.speakers.length === 1 && c.inbox.policy?.mode === "floor");
    expect(a.inbox.policy).toMatchObject({ mode: "meeting", zoneId: ZONE, speakers: [{ mediaIdentity: identity(b), gain: 1 }] });
    expect(b.inbox.policy).toMatchObject({ mode: "meeting", zoneId: ZONE, speakers: [{ mediaIdentity: identity(a), gain: 1 }] });
    expect(c.inbox.policy).toMatchObject({ mode: "floor", zoneId: "", speakers: [] });
    expect(Math.hypot(self(c).x - c.room.state.players.get(b.room.sessionId)!.x, self(c).y - c.room.state.players.get(b.room.sessionId)!.y)).toBeLessThan(6);
    expect(c.room.state.players.get(a.room.sessionId)).toMatchObject({ zoneId: ZONE, audioMode: "meeting" });
    expect(self(c)).toMatchObject({ zoneId: "", audioMode: "floor" });
    expect(c.room.state.meetings.get(ZONE)!.toJSON()).toEqual({ zoneId: ZONE, meetingSessionId, occupancy: 2, videoAvailable: true, videoCallActive: false, assistantStatus: "none" });
    for (const person of [a, b, c]) expectPublicStateClean(person);

    // Bob leaves: floor for him, a fresh epoch for Ada, and his old credentials reach nothing current.
    const bobIdentity = identity(b), adaIdentity = identity(a);
    await exit(b);
    await eventually(() => b.inbox.transitions.length === 2 && a.inbox.transitions.length === 2 && b.inbox.exited.length === 1);
    expect(b.inbox.exited[0]).toEqual({ zoneId: ZONE, meetingSessionId, revision: 2 });
    expect(b.inbox.transitions[1]).toEqual({ revision: 2, mode: "floor", zoneId: "", reason: "zone_change" });
    expect(a.inbox.transitions[1]).toEqual({ revision: 2, mode: "meeting", zoneId: ZONE, meetingSessionId, reason: "epoch_rotation" });
    expect(a.inbox.entered).toHaveLength(1);
    expect(backend.removeParticipant).toHaveBeenCalledWith(firstRoom, bobIdentity);
    expect(backend.removeParticipant).toHaveBeenCalledWith(firstRoom, adaIdentity);
    expect(deleted(firstRoom)).toBe(true);
    const replay = await token(a, 1);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: "STALE_TRANSITION" } });
    const rotated = await ackAndFetch(a, 2);
    expect(rotated).toMatchObject({ mode: "meeting", meetingSessionId, transitionRevision: 2, mediaIdentity: adaIdentity });
    expect(rotated.roomName).toMatch(/^meet_/);
    expect(rotated.roomName).not.toBe(firstRoom);
    const floor = await ackAndFetch(b, 2);
    expect(floor).toMatchObject({ mode: "floor", zoneId: "", transitionRevision: 2, mediaIdentity: bobIdentity, roomName: floorTokens[0].roomName });
    vi.mocked(backend.removeParticipant).mockClear();
    expect((await webhook({ id: "replay-1", event: "participant_joined", room: { name: firstRoom }, participant: { identity: bobIdentity, sid: "PA_replay" } })).status).toBe(204);
    expect((await webhook({ id: "replay-2", event: "participant_joined", room: { name: rotated.roomName }, participant: { identity: bobIdentity, sid: "PA_replay2" } })).status).toBe(204);
    expect(vi.mocked(backend.removeParticipant).mock.calls).toEqual([[firstRoom, bobIdentity], [rotated.roomName, bobIdentity]]);
    await eventually(() => b.inbox.policy?.mode === "floor" && a.inbox.policy?.speakers.length === 0);
    expect(c.room.state.meetings.get(ZONE)).toMatchObject({ meetingSessionId, occupancy: 1 });
    expect(c.room.state.players.get(b.room.sessionId)).toMatchObject({ zoneId: "", audioMode: "floor" });

    // The last occupant walking out ends the session; a later visit starts a fresh one.
    await exit(a);
    await eventually(() => a.inbox.exited.length === 1 && a.inbox.transitions.length === 3 && !c.room.state.meetings.has(ZONE));
    expect(a.inbox.exited[0]).toEqual({ zoneId: ZONE, meetingSessionId, revision: 3 });
    expect(a.inbox.transitions[2]).toEqual({ revision: 3, mode: "floor", zoneId: "", reason: "zone_change" });
    await eventually(() => deleted(rotated.roomName));
    await pause(1000);
    await enter(a);
    await eventually(() => a.inbox.entered.length === 2);
    expect(a.inbox.entered[1].meetingSessionId).not.toBe(meetingSessionId);
    expect(a.inbox.transitions.at(-1)).toMatchObject({ revision: 4, mode: "meeting", meetingSessionId: a.inbox.entered[1].meetingSessionId, reason: "zone_change" });
    for (const person of [a, b, c]) expectPublicStateClean(person);
    for (const person of [a, b, c]) await leave(person);
  }, 45_000);

  it("drops muted speakers, evicts floor publishing from a meeting seat, and reconnects into the continuing meeting", async () => {
    const [d, e] = [await join("Dee"), await join("Eve")];
    const floorRoom = (await (await token(d)).json() as MediaCredentials).roomName;
    await Promise.all([enter(d), enter(e, 25, 9)]);
    await eventually(() => d.inbox.transitions.length === 1 && e.inbox.transitions.length === 1);
    const meetingSessionId = d.inbox.transitions[0].meetingSessionId!;
    await ackAndFetch(d, 1);
    await eventually(() => d.inbox.policy?.speakers.length === 1);
    e.room.send("media.preferences", { muted: true, deafened: false });
    await eventually(() => d.inbox.policy?.mode === "meeting" && d.inbox.policy.speakers.length === 0);

    vi.mocked(backend.removeParticipant).mockClear();
    expect((await webhook({ id: "floor-publish", event: "track_published", room: { name: floorRoom }, participant: { identity: identity(d), sid: "PA_floor" } })).status).toBe(204);
    expect(backend.removeParticipant).toHaveBeenCalledWith(floorRoom, identity(d));

    // Eve's drop rotates Dee once; Eve's reconnect joins the same session without another rotation.
    const sessionId = e.room.sessionId, reconnectToken = e.room.reconnectionToken;
    e.room.reconnection.enabled = false; e.room.connection.close();
    await eventually(() => d.inbox.transitions.length === 2 && d.room.state.meetings.get(ZONE)?.occupancy === 1);
    expect(d.inbox.transitions[1]).toMatchObject({ revision: 2, reason: "epoch_rotation", meetingSessionId });
    e.room = await new Client(base).reconnect<State>(reconnectToken);
    listen(e.room, e.inbox);
    await eventually(() => e.inbox.transitions.length === 2 && e.inbox.entered.length === 2);
    expect(e.room.sessionId).toBe(sessionId);
    expect(e.inbox.transitions[1]).toEqual({ revision: 2, mode: "meeting", zoneId: ZONE, meetingSessionId, reason: "reconnect" });
    expect(e.inbox.entered[1]).toMatchObject({ meetingSessionId, revision: 2 });
    const rejoined = await ackAndFetch(e, 2);
    const continuing = await ackAndFetch(d, 2);
    expect(rejoined.roomName).toBe(continuing.roomName);
    await eventually(() => d.room.state.meetings.get(ZONE)?.occupancy === 2);
    await pause(250);
    expect(d.inbox.transitions).toHaveLength(2);
    expect(d.room.state.meetings.get(ZONE)?.meetingSessionId).toBe(meetingSessionId);
    for (const person of [d, e]) await leave(person);
    await eventually(() => deleted(continuing.roomName));
  }, 30_000);

  it("ends a sole occupant's session on drop and starts a fresh session on reconnect", async () => {
    const [f, watcher] = [await join("Fay"), await join("Gus")];
    await enter(f);
    await eventually(() => f.inbox.entered.length === 1);
    const meetingSessionId = f.inbox.entered[0].meetingSessionId;
    const room = (await ackAndFetch(f, 1)).roomName;
    const sessionId = f.room.sessionId, reconnectToken = f.room.reconnectionToken;
    f.room.reconnection.enabled = false; f.room.connection.close();
    await eventually(() => !watcher.room.state.meetings.has(ZONE) && watcher.room.state.players.get(sessionId)?.connected === false);
    expect(watcher.room.state.players.get(sessionId)).toMatchObject({ zoneId: ZONE, audioMode: "floor" });
    expect(media.getBinding(sessionId)).toBeUndefined();
    expect((await token(f, 1)).status).toBe(403);
    await eventually(() => deleted(room));

    f.room = await new Client(base).reconnect<State>(reconnectToken);
    listen(f.room, f.inbox);
    await eventually(() => f.inbox.transitions.length === 2 && f.inbox.entered.length === 2);
    const fresh = f.inbox.entered[1].meetingSessionId;
    expect(fresh).not.toBe(meetingSessionId);
    expect(f.inbox.transitions[1]).toEqual({ revision: 2, mode: "meeting", zoneId: ZONE, meetingSessionId: fresh, reason: "reconnect" });
    expect((await token(f, 2)).status).toBe(409);
    const credentials = await ackAndFetch(f, 2);
    expect(credentials.roomName).not.toBe(room);
    expect(credentials).toMatchObject({ meetingSessionId: fresh, transitionRevision: 2 });
    await eventually(() => watcher.room.state.meetings.get(ZONE)?.occupancy === 1 && watcher.room.state.players.get(sessionId)?.audioMode === "meeting");
    await leave(f);
    await eventually(() => !watcher.room.state.meetings.has(ZONE) && deleted(credentials.roomName));
    await leave(watcher);
  }, 30_000);

  it("logs failed reconciliation without affecting the office", async () => {
    expect(backend.listRooms).toHaveBeenCalled();
    await expect(media.reconcile()).rejects.toThrow("livekit unavailable");
    expect((await fetch(base + "/healthz")).status).toBe(200);
    const person = await join("Hal");
    expect((await token(person)).status).toBe(200);
    await leave(person);
  });
});
