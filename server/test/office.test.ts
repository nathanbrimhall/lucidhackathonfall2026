import { Client, type Room } from "@colyseus/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/app.config.js";
import { loadConfig } from "../src/config.js";
import type { OfficeState } from "../src/rooms/schema/OfficeState.js";
import type { GuestSession, RequestError } from "../../shared/src/protocol.js";
import { AuthService, AuthError } from "../src/auth/AuthService.js";

const config = loadConfig({
  PUBLIC_SERVER_URL: "http://localhost:2567", ALLOWED_ORIGINS: "http://localhost:2567",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters", DATABASE_URL: ":memory:",
  GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
});
type State = InstanceType<typeof OfficeState>;
type OfficeClient = Room<State>;
let app: ReturnType<typeof createApplication>;
let base: string;
let sdk: Client;
let ada: GuestSession, grace: GuestSession;
let first: OfficeClient, second: OfficeClient;
const rooms = new Set<OfficeClient>();
const errors = new Map<OfficeClient, RequestError[]>();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean, timeout = 2000) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeout) throw new Error("Timed out waiting for office state");
    await pause(10);
  }
}
function post(path: string, body: unknown, token?: string) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
async function guest(displayName: string) {
  const res = await post("/api/sessions/guest", { inviteCode: config.inviteCode, displayName });
  expect(res.status).toBe(201);
  return await res.json() as GuestSession;
}
const reserve = (person: GuestSession) => post("/api/offices/demo-office/join", { protocolVersion: 1 }, person.token);
async function consume(response: Response) {
  expect(response.status).toBe(200);
  const room = await sdk.consumeSeatReservation<State>(await response.json());
  room.onMessage("session.ready", () => {});
  const messages: RequestError[] = [];
  room.onMessage("request.error", message => messages.push(message));
  errors.set(room, messages);
  rooms.add(room);
  await eventually(() => room.state?.players?.has(room.sessionId) ?? false);
  return room;
}
async function leave(room: OfficeClient) { await room.leave(); rooms.delete(room); }

beforeAll(async () => {
  // Short reconnect timeout keeps expiry coverage fast; production defaults to 30 seconds.
  app = createApplication(config, { maxClients: 3, reconnectionSeconds: 0.5 });
  base = `http://127.0.0.1:${await app.start(0)}`;
  sdk = new Client(base);
  [ada, grace] = await Promise.all([guest("Ada"), guest("Grace")]);
});
afterAll(async () => {
  for (const room of rooms) { room.reconnection.enabled = false; await room.leave(); }
  await app.stop();
});

describe("M1 authoritative shared office", () => {
  it("serializes simultaneous joins into one office with public presence and map metadata", async () => {
    [first, second] = await Promise.all([reserve(ada).then(consume), reserve(grace).then(consume)]);
    expect(first.roomId).toBe(second.roomId);
    await eventually(() => first.state.players.size === 2 && second.state.players.size === 2);
    expect(second.state.players.get(first.sessionId)).toMatchObject({ userId: ada.userId, displayName: "Ada", connected: true, x: 3, y: 3, audioMode: "floor", zoneId: "", lastProcessedInputSeq: -1 });
    expect(first.state.mapId).toBe("office");
    expect(first.state.mapVersion).toBe(1);
    expect(first.state.serverTick).toBeGreaterThanOrEqual(0);
    const json = JSON.stringify(first.state.toJSON());
    expect(json).not.toContain(ada.token);
    expect(json).not.toContain("expiresAt");
  });

  it("serves the validated map only to office members", async () => {
    expect((await fetch(base + "/api/offices/demo-office/map")).status).toBe(401);
    const headers = { Authorization: `Bearer ${ada.token}` };
    expect((await fetch(base + "/api/offices/other/map", { headers })).status).toBe(403);
    const response = await fetch(base + "/api/offices/demo-office/map", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mapId: first.state.mapId, version: first.state.mapVersion, units: "tiles", spawnPoints: [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 }] });
  });

  it("rejects duplicate active seats and full offices without creating another room", async () => {
    const duplicate = await reserve(ada);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "DUPLICATE_CONNECTION" } });
    const thirdGuest = await guest("Third");
    const third = await consume(await reserve(thirdGuest));
    const fourthGuest = await guest("Fourth");
    const full = await reserve(fourthGuest);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: { code: "ROOM_FULL" } });
    expect(third.roomId).toBe(first.roomId);
    await leave(third);
    const replacement = await consume(await reserve(fourthGuest));
    expect(replacement.roomId).toBe(first.roomId);
    await leave(replacement);
  });

  it("rejects duplicate concurrent pending reservations", async () => {
    const person = await guest("Pending");
    const responses = await Promise.all([reserve(person), reserve(person)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const pending = await consume(responses.find(r => r.ok)!);
    await leave(pending);
  });

  it("replicates authoritative movement and stops held input after 250ms", async () => {
    const origin = first.state.players.get(first.sessionId)!.x;
    first.send("player.input", { seq: 1, dx: 1, dy: 0 });
    await eventually(() => second.state.players.get(first.sessionId)!.lastProcessedInputSeq === 1);
    await pause(350);
    const player = second.state.players.get(first.sessionId)!;
    expect(player.x).toBeGreaterThan(origin);
    expect(player.x - origin).toBeLessThanOrEqual(1.01);
    expect(player.facing).toBe("right");
    const stoppedX = player.x;
    await pause(120);
    expect(player.x).toBe(stoppedX);
  });

  it("rejects teleport, speed and nonfinite payloads and ignores stale sequences", async () => {
    const player = second.state.players.get(first.sessionId)!;
    const x = player.x;
    const beforeErrors = errors.get(first)!.length;
    for (const payload of [
      { seq: 2, dx: 1, dy: 0, x: 999, y: 999 },
      { seq: 2, dx: 100, dy: 0 }, { seq: 2, dx: Infinity, dy: 0 },
      { seq: 2, dx: 1, dy: 0, dt: 100000 }, { seq: -1, dx: 1, dy: 0 },
    ]) first.send("player.input", payload);
    first.send("player.input", { seq: 1, dx: -1, dy: 0 });
    first.send("player.input", { seq: 0, dx: -1, dy: 0 });
    await eventually(() => errors.get(first)!.length === beforeErrors + 5);
    expect(errors.get(first)!.slice(beforeErrors).every(e => e.code === "INVALID_INPUT")).toBe(true);
    await pause(120);
    expect(player.x).toBe(x);
    expect(player.lastProcessedInputSeq).toBe(1);
  });

  it("applies only the latest direction per tick and bounds diagonal speed", async () => {
    const player = second.state.players.get(first.sessionId)!;
    const start = { x: player.x, y: player.y };
    for (let seq = 2; seq <= 11; seq++) first.send("player.input", { seq, dx: -1, dy: 0 });
    first.send("player.input", { seq: 12, dx: 1, dy: 1 });
    await eventually(() => player.lastProcessedInputSeq === 12);
    await pause(350);
    expect(player.x).toBeGreaterThan(start.x);
    expect(player.y).toBeGreaterThan(start.y);
    expect(Math.hypot(player.x - start.x, player.y - start.y)).toBeLessThanOrEqual(1.01);
  });

  it("replicates own status while rejecting identity forgery", async () => {
    first.send("player.status", { status: "busy" });
    await eventually(() => second.state.players.get(first.sessionId)!.status === "busy");
    const count = errors.get(first)!.length;
    first.send("player.status", { status: "away", sessionId: second.sessionId });
    await eventually(() => errors.get(first)!.length > count);
    expect(second.state.players.get(second.sessionId)!.status).toBe("available");
    expect(second.state.players.get(first.sessionId)!.status).toBe("busy");
  });

  it("rate limits message bursts without allowing extra simulation steps", async () => {
    // A fresh rate window avoids coupling to earlier malformed-input checks.
    await pause(1050);
    const player = second.state.players.get(first.sessionId)!;
    const start = { x: player.x, y: player.y };
    for (let seq = 13; seq < 113; seq++) first.send("player.input", { seq, dx: 1, dy: 0 });
    await eventually(() => errors.get(first)!.some(e => e.code === "RATE_LIMITED"));
    await pause(350);
    expect(player.lastProcessedInputSeq).toBeLessThanOrEqual(72);
    expect(Math.hypot(player.x - start.x, player.y - start.y)).toBeLessThanOrEqual(1.01);
  });

  it("stops on drop, preserves the reserved player, reconnects and requires fresh input", async () => {
    const sessionId = first.sessionId;
    const reconnectToken = first.reconnectionToken;
    const player = second.state.players.get(sessionId)!;
    const sequence = player.lastProcessedInputSeq;
    first.reconnection.enabled = false;
    first.connection.close();
    rooms.delete(first);
    await eventually(() => !player.connected);
    const x = player.x;
    expect((await reserve(ada)).status).toBe(409);
    const reconnected = await sdk.reconnect<State>(reconnectToken);
    reconnected.onMessage("session.ready", () => {});
    reconnected.onMessage("request.error", () => {});
    rooms.add(reconnected);
    first = reconnected;
    expect(first.sessionId).toBe(sessionId);
    await eventually(() => player.connected);
    expect(player.status).toBe("busy");
    expect(player.x).toBe(x);
    await pause(120);
    expect(player.x).toBe(x);
    first.send("player.input", { seq: sequence + 1, dx: -1, dy: 0 });
    await eventually(() => player.x < x);
  });

  it("removes expired reconnect reservations and admits the same identity again", async () => {
    const sessionId = first.sessionId;
    const reconnectToken = first.reconnectionToken;
    first.reconnection.enabled = false;
    first.connection.close();
    rooms.delete(first);
    await eventually(() => !second.state.players.has(sessionId));
    await expect(sdk.reconnect(reconnectToken)).rejects.toBeDefined();
    first = await consume(await reserve(ada));
    expect(first.sessionId).not.toBe(sessionId);
    expect(first.roomId).toBe(second.roomId);
  });

  it("rechecks authorization on reconnect and releases a denied reconnect seat", async () => {
    const sessionId = first.sessionId;
    const reconnectToken = first.reconnectionToken;
    first.reconnection.enabled = false;
    first.connection.close();
    rooms.delete(first);
    await eventually(() => second.state.players.get(sessionId)?.connected === false);
    const authenticate = vi.spyOn(AuthService.prototype, "authenticate").mockImplementationOnce(() => {
      throw new AuthError("UNAUTHORIZED", "Session revoked or expired");
    });
    try { await expect(sdk.reconnect(reconnectToken)).rejects.toBeDefined(); }
    finally { authenticate.mockRestore(); }
    await eventually(() => !second.state.players.has(sessionId));
    first = await consume(await reserve(ada));
    expect(first.sessionId).not.toBe(sessionId);
  });

  it("cleans up consented leaves immediately and retains the canonical office when empty", async () => {
    const canonicalId = first.roomId;
    const sessionId = first.sessionId;
    await leave(first);
    await eventually(() => !second.state.players.has(sessionId));
    await leave(second);
    const newJoin = await consume(await reserve(ada));
    expect(newJoin.roomId).toBe(canonicalId);
    expect(newJoin.state.players.size).toBe(1);
    await leave(newJoin);
  });
});
