import { createHash } from "node:crypto";
import { Client, type Room } from "@colyseus/sdk";
import { AccessToken, WebhookReceiver } from "livekit-server-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.config.js";
import { loadConfig } from "../src/config.js";
import { LiveKitService, type LiveKitBackend } from "../src/services/LiveKitService.js";
import type { AudioPolicy, GuestSession, MediaCredentials } from "../../shared/src/protocol.js";

const config = loadConfig({ OFFICE_LAYOUT: "legacy",
  PUBLIC_SERVER_URL: "http://localhost:2567", ALLOWED_ORIGINS: "http://localhost:2567",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters", DATABASE_URL: ":memory:",
  GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
});
const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
const backend: LiveKitBackend = {
  issueToken: vi.fn(async () => "signed-media-token"),
  removeParticipant: vi.fn(async () => {}), deleteRoom: vi.fn(async () => {}),
  verifyWebhook: (body, auth) => receiver.receive(body, auth),
};
const media = new LiveKitService(config, { backend });
let app: ReturnType<typeof createApplication>, base: string;
let ada: GuestSession, grace: GuestSession, first: Room, second: Room;
const policies = new Map<Room, AudioPolicy>();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean) {
  const until = Date.now() + 2000;
  while (!check()) { if (Date.now() > until) throw new Error("Timed out waiting for media policy"); await pause(10); }
}
function post(path: string, body: unknown, token?: string) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
async function guest(name: string) {
  return await (await post("/api/sessions/guest", { inviteCode: config.inviteCode, displayName: name })).json() as GuestSession;
}
async function join(person: GuestSession) {
  const seat = await post("/api/offices/demo-office/join", { protocolVersion: 1 }, person.token);
  const room = await new Client(base).consumeSeatReservation(await seat.json());
  room.onMessage("session.ready", () => {}); room.onMessage("request.error", () => {});
  room.onMessage("audio.policy", policy => policies.set(room, policy));
  return room;
}
beforeAll(async () => {
  app = createApplication(config, { reconnectionSeconds: 0.5 }, media);
  base = `http://127.0.0.1:${await app.start(0)}`;
  ada = await guest("Ada"); grace = await guest("Grace");
});
afterAll(async () => { await first?.leave(); await second?.leave(); await app.stop(); });

describe("M2 authenticated media and private policy delivery", () => {
  it("requires a joined connection owned by the authenticated guest", async () => {
    expect((await post("/api/media/token", { sessionId: "fake" })).status).toBe(401);
    expect((await post("/api/media/token", { sessionId: "fake" }, ada.token)).status).toBe(403);
    first = await join(ada); second = await join(grace);
    expect((await post("/api/media/token", { sessionId: first.sessionId }, grace.token)).status).toBe(403);
    expect((await post("/api/media/token", { sessionId: first.sessionId, roomName: "forged" }, ada.token)).status).toBe(400);
    const credentials = await (await post("/api/media/token", { sessionId: first.sessionId }, ada.token)).json() as MediaCredentials;
    expect(credentials).toMatchObject({ url: config.livekitPublicUrl, token: "signed-media-token" });
    expect(credentials.mediaIdentity).not.toBe(ada.userId);
    expect(credentials.mediaIdentity).not.toBe(first.sessionId);
    expect(JSON.stringify(first.state)).not.toContain(credentials.token);
  });
  it("sends monotonic private proximity policies and respects mute and deafen", async () => {
    await eventually(() => policies.has(first) && policies.has(second));
    expect(policies.get(first)!.speakers).toEqual([]); // Microphones start muted.
    first.send("media.preferences", { muted: false, deafened: false });
    second.send("media.preferences", { muted: false, deafened: false });
    await eventually(() => policies.get(first)!.speakers.length === 1 && policies.get(second)!.speakers.length === 1);
    const firstBinding = media.getBinding(first.sessionId)!;
    expect(policies.get(second)!.speakers).toEqual([{ mediaIdentity: firstBinding.mediaIdentity, distance: 1, gain: 1 }]);
    const revision = policies.get(first)!.revision;
    first.send("media.preferences", { muted: true, deafened: true });
    await eventually(() => policies.get(first)!.revision > revision && policies.get(first)!.speakers.length === 0 && policies.get(second)!.speakers.length === 0);
  });
  it("immediately invalidates a dropped seat and creates a fresh identity on reconnect", async () => {
    const sessionId = first.sessionId, reconnectToken = first.reconnectionToken;
    const old = media.getBinding(sessionId)!;
    first.reconnection.enabled = false; first.connection.close();
    await eventually(() => !media.getBinding(sessionId));
    expect((await post("/api/media/token", { sessionId }, ada.token)).status).toBe(403);
    expect(backend.removeParticipant).toHaveBeenCalledWith(old.roomName, old.mediaIdentity);
    first = await new Client(base).reconnect(reconnectToken);
    first.onMessage("session.ready", () => {}); first.onMessage("request.error", () => {});
    first.onMessage("audio.policy", policy => policies.set(first, policy));
    expect(media.getBinding(sessionId)?.mediaIdentity).not.toBe(old.mediaIdentity);
    expect((await post("/api/media/token", { sessionId }, ada.token)).status).toBe(200);
  });
  it("verifies exact webhook body signatures, deduplicates, and rejects stale identity joins", async () => {
    const body = JSON.stringify({ event: "participant_joined", id: "webhook-one", room: { name: "old-floor" }, participant: { identity: "old-seat", sid: "PA_old" } });
    const access = new AccessToken(config.livekitApiKey, config.livekitApiSecret);
    access.sha256 = createHash("sha256").update(body).digest("base64");
    const auth = await access.toJwt();
    const webhook = (payload: string, authorization?: string) => fetch(base + "/api/livekit/webhook", { method: "POST", headers: { "Content-Type": "application/webhook+json", ...(authorization ? { Authorization: authorization } : {}) }, body: payload });
    expect((await webhook(body)).status).toBe(401);
    expect((await webhook(body + " ", auth)).status).toBe(401);
    expect((await webhook(body, auth)).status).toBe(204);
    const calls = vi.mocked(backend.removeParticipant).mock.calls.length;
    expect((await webhook(body, auth)).status).toBe(204);
    expect(backend.removeParticipant).toHaveBeenCalledTimes(calls);
    expect(backend.removeParticipant).toHaveBeenCalledWith("old-floor", "old-seat");
    expect((await post("/api/livekit/webhook", {})).status).toBe(400);
  });
});
