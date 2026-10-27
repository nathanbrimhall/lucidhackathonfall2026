import { Client } from "@colyseus/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.config.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({ OFFICE_LAYOUT: "legacy",
  PUBLIC_SERVER_URL: "http://localhost:2567", ALLOWED_ORIGINS: "http://localhost:2567",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters", DATABASE_URL: ":memory:",
  GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
});
let app: ReturnType<typeof createApplication>;
let base: string;
let token: string;
let userId: string;

async function post(path: string, body: unknown, bearer?: string) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  app = createApplication(config);
  base = `http://127.0.0.1:${await app.start(0)}`;
});
afterAll(async () => { await app.stop(); });

describe("M0 HTTP and WebSocket foundation", () => {
  it("exposes liveness and storage readiness independently of media", async () => {
    expect((await fetch(base + "/healthz")).status).toBe(200);
    const readiness = await fetch(base + "/readyz");
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toMatchObject({ status: "ready", dependencies: { storage: "up" } });
  });
  it("rejects unauthorized, forged and cross-office application joins", async () => {
    expect((await post("/api/offices/demo-office/join", { protocolVersion: 1 })).status).toBe(401);
    expect((await post("/api/offices/demo-office/join", { protocolVersion: 1 }, "forged")).status).toBe(401);
    expect((await post("/api/sessions/guest", { inviteCode: "wrong", displayName: "Ada" })).status).toBe(401);
    const response = await post("/api/sessions/guest", { inviteCode: config.inviteCode, displayName: "Ada" });
    expect(response.status).toBe(201);
    const session = await response.json() as { token: string; userId: string };
    token = session.token; userId = session.userId;
    expect((await post("/api/offices/another-office/join", { protocolVersion: 1 }, token)).status).toBe(403);
    expect((await post("/api/offices/demo-office/join", { protocolVersion: 2 }, token)).status).toBe(400);
    expect((await post("/api/offices/demo-office/join", { protocolVersion: 1, userId: "forged" }, token)).status).toBe(400);
  });
  it("resumes identity with a saved bearer token without redeeming another invite", async () => {
    const response = await fetch(base + "/api/sessions/current", { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId, displayName: "Ada", officeId: "demo-office" });
  });
  it("blocks direct matchmaking paths", async () => {
    const sdk = new Client(base);
    await expect(sdk.joinOrCreate("office", { protocolVersion: 1 })).rejects.toBeDefined();
    sdk.auth.token = token;
    await expect(sdk.create("office", { protocolVersion: 1 })).rejects.toBeDefined();
  });
  it("consumes an authorized seat using the pinned SDK and receives schema state without secrets", async () => {
    const response = await post("/api/offices/demo-office/join", { protocolVersion: 1 }, token);
    expect(response.status).toBe(200);
    const sdk = new Client(base);
    const seat = await response.json() as Parameters<Client["consumeSeatReservation"]>[0];
    const room = await sdk.consumeSeatReservation<{ officeId: string; protocolVersion: number; toJSON(): unknown }>(seat);
    try {
      room.onMessage("session.ready", () => {});
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for schema state")), 2000);
        room.onStateChange.once(() => { clearTimeout(timer); resolve(); });
      });
      const state = room.state.toJSON();
      expect(state).toMatchObject({ officeId: "demo-office", protocolVersion: 1, mapId: "office", mapVersion: 1 });
      expect(JSON.stringify(state)).not.toContain(token);
      expect(state).toHaveProperty(`players.${room.sessionId}.userId`, userId);
    } finally { await room.leave(); }
  });
  it("rejects malformed, oversized requests and unauthorized browser origins", async () => {
    const malformed = await fetch(base + "/api/sessions/guest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await post("/api/sessions/guest", { text: "x".repeat(5000) })).status).toBe(413);
    expect((await fetch(base + "/healthz", { headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
    const allowed = await fetch(base + "/healthz", { headers: { Origin: "http://localhost:2567" } });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:2567");
  });
});
