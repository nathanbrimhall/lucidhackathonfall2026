import assert from "node:assert/strict";
import { Client } from "@colyseus/sdk";
import { PROTOCOL_VERSION, type PlayerState } from "../shared/src/protocol.js";

type SmokeState = {
  officeId: string;
  protocolVersion: number;
  mapId: string;
  mapVersion: number;
  serverTick: number;
  players: { values(): IterableIterator<PlayerState> };
};

async function main() {
  const base = process.env.PUBLIC_SERVER_URL ?? "http://localhost:2567";
  const officeId = process.env.OFFICE_ID ?? "demo-office";
  const inviteCode = process.env.GUEST_INVITE_CODE;
  assert(inviteCode, "Set GUEST_INVITE_CODE before running the smoke client");
  for (const path of ["/healthz", "/readyz"]) assert.equal((await fetch(base + path)).status, 200, path);

  const post = (path: string, body: unknown, token?: string) => fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal((await post(`/api/offices/${officeId}/join`, { protocolVersion: PROTOCOL_VERSION })).status, 401);
  const unauthenticatedClient = new Client(base);
  await assert.rejects(unauthenticatedClient.joinOrCreate("office", { protocolVersion: PROTOCOL_VERSION }));

  const createGuest = async (displayName: string) => {
    const response = await post("/api/sessions/guest", { inviteCode, displayName });
    assert.equal(response.status, 201);
    return await response.json() as { token: string; userId: string };
  };
  const firstGuest = await createGuest("Smoke client one");
  const secondGuest = await createGuest("Smoke client two");
  assert.notEqual(firstGuest.userId, secondGuest.userId, "smoke clients must use distinct identities");

  const resumed = await fetch(base + "/api/sessions/current", { headers: { Authorization: `Bearer ${firstGuest.token}` } });
  assert.equal((await resumed.json() as { userId: string }).userId, firstGuest.userId);

  const join = async (token: string) => {
    const response = await post(`/api/offices/${officeId}/join`, { protocolVersion: PROTOCOL_VERSION }, token);
    assert.equal(response.status, 200);
    return response.json() as Promise<Parameters<Client["consumeSeatReservation"]>[0]>;
  };
  const clientOne = new Client(base);
  const clientTwo = new Client(base);
  const [seatOne, seatTwo] = await Promise.all([join(firstGuest.token), join(secondGuest.token)]);
  let roomOne: Awaited<ReturnType<typeof clientOne.consumeSeatReservation<SmokeState>>> | undefined;
  let roomTwo: Awaited<ReturnType<typeof clientTwo.consumeSeatReservation<SmokeState>>> | undefined;

  const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 5000) => {
    const started = Date.now();
    while (!predicate()) {
      assert(Date.now() - started < timeoutMs, message);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const findPlayer = (room: NonNullable<typeof roomOne>, userId: string) => room.state?.players
    ? Array.from(room.state.players.values()).find(candidate => candidate.userId === userId)
    : undefined;
  const player = (room: NonNullable<typeof roomOne>, userId: string) => {
    const found = findPlayer(room, userId);
    assert(found, `Player ${userId} is missing`);
    return found;
  };
  let resolveRequestError: ((error: unknown) => void) | undefined;
  try {
    const firstRoom = roomOne = await clientOne.consumeSeatReservation<SmokeState>(seatOne);
    firstRoom.onMessage("session.ready", () => {});
    firstRoom.onMessage("request.error", (error: unknown) => resolveRequestError?.(error));
    const secondRoom = roomTwo = await clientTwo.consumeSeatReservation<SmokeState>(seatTwo);
    secondRoom.onMessage("session.ready", () => {});
    secondRoom.onMessage("request.error", () => {});
    assert.equal(firstRoom.roomId, secondRoom.roomId, "both clients must join the same office room");
    await waitFor(() => Boolean(findPlayer(firstRoom, firstGuest.userId) && findPlayer(firstRoom, secondGuest.userId)), "Both identities did not appear in the first room");
    await waitFor(() => Boolean(findPlayer(secondRoom, firstGuest.userId) && findPlayer(secondRoom, secondGuest.userId)), "Both identities did not appear in the second room");
    assert.equal(firstRoom.state.officeId, officeId);
    assert.equal(firstRoom.state.protocolVersion, PROTOCOL_VERSION);

    const initialOtherPlayer = { x: player(secondRoom, firstGuest.userId).x, y: player(secondRoom, firstGuest.userId).y };
    for (let seq = 1; seq <= 10; seq++) {
      firstRoom.send("player.input", { seq, dx: 1, dy: 0 });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await waitFor(() => {
      const moved = findPlayer(secondRoom, firstGuest.userId);
      return Boolean(moved && (moved.x !== initialOtherPlayer.x || moved.y !== initialOtherPlayer.y));
    }, "Second SDK client did not observe authoritative movement");
    assert.ok(player(secondRoom, firstGuest.userId).lastProcessedInputSeq > 0);

    firstRoom.send("player.input", { seq: 11, dx: 0, dy: 0 });
    await waitFor(() => player(secondRoom, firstGuest.userId).lastProcessedInputSeq >= 11, "Server did not process the stop input");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const beforeInvalid = { x: player(firstRoom, firstGuest.userId).x, y: player(firstRoom, firstGuest.userId).y };
    const invalidError = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No request.error returned for client coordinate injection")), 3000);
      resolveRequestError = (error) => { clearTimeout(timer); resolve(error); };
    });
    firstRoom.send("player.input", { x: 999999, y: 999999 });
    const error = await invalidError as { code?: string };
    resolveRequestError = undefined;
    assert.equal(error.code, "INVALID_INPUT");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual({ x: player(firstRoom, firstGuest.userId).x, y: player(firstRoom, firstGuest.userId).y }, beforeInvalid, "invalid coordinate payload changed authoritative position");

    console.log("M1 smoke passed: two identities, shared presence, authoritative movement, rejected coordinate injection");
  } finally {
    await Promise.all([roomOne?.leave(), roomTwo?.leave()]);
  }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Smoke failed"); process.exitCode = 1; });
