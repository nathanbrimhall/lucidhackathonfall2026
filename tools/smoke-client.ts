import assert from "node:assert/strict";
import { Client } from "@colyseus/sdk";
import { PROTOCOL_VERSION } from "../shared/src/protocol.js";

async function main() {
  const base = process.env.PUBLIC_SERVER_URL ?? "http://localhost:2567";
  const officeId = process.env.OFFICE_ID ?? "demo-office";
  const inviteCode = process.env.GUEST_INVITE_CODE;
  assert(inviteCode, "Set GUEST_INVITE_CODE before running the smoke client");
  for (const path of ["/healthz", "/readyz"]) assert.equal((await fetch(base + path)).status, 200, path);
  const post = (path: string, body: unknown, token?: string) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post(`/api/offices/${officeId}/join`, { protocolVersion: PROTOCOL_VERSION })).status, 401);
  const sdk = new Client(base);
  await assert.rejects(sdk.joinOrCreate("office", { protocolVersion: PROTOCOL_VERSION }));
  const guestResponse = await post("/api/sessions/guest", { inviteCode, displayName: "Smoke client" });
  assert.equal(guestResponse.status, 201);
  const guest = await guestResponse.json() as { token: string; userId: string };
  const resumed = await fetch(base + "/api/sessions/current", { headers: { Authorization: `Bearer ${guest.token}` } });
  assert.equal((await resumed.json() as { userId: string }).userId, guest.userId);
  const joinResponse = await post(`/api/offices/${officeId}/join`, { protocolVersion: PROTOCOL_VERSION }, guest.token);
  assert.equal(joinResponse.status, 200);
  const seat = await joinResponse.json() as Parameters<Client["consumeSeatReservation"]>[0];
  const room = await sdk.consumeSeatReservation<{ officeId: string; protocolVersion: number }>(seat);
  room.onMessage("session.ready", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No schema state received")), 3000);
      room.onStateChange.once(() => { clearTimeout(timeout); resolve(); });
    });
    assert.equal(room.state.officeId, officeId);
    assert.equal(room.state.protocolVersion, PROTOCOL_VERSION);
    console.log("M0 smoke passed: health, unauthorized rejection, guest resume, SDK seat and schema state");
  } finally { await room.leave(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Smoke failed"); process.exitCode = 1; });
