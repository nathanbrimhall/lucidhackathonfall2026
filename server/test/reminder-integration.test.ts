import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.config.js";
import { loadConfig } from "../src/config.js";
import type { GuestSession, ReminderDue, ReminderRecord, RequestError } from "../../shared/src/protocol.js";
import type { OfficeState } from "../src/rooms/schema/OfficeState.js";

const directory = mkdtempSync(join(tmpdir(), "office-reminders-"));
const config = loadConfig({ OFFICE_LAYOUT: "legacy",
  PUBLIC_SERVER_URL: "http://localhost:2567", ALLOWED_ORIGINS: "http://localhost:2567",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters", DATABASE_URL: join(directory, "office.sqlite"),
  GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
});
let app: ReturnType<typeof createApplication> | undefined;
let base: string;
const rooms = new Set<Room<InstanceType<typeof OfficeState>>>();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean | Promise<boolean>, timeout = 4000) {
  const started = Date.now();
  while (!await check()) { if (Date.now() - started > timeout) throw new Error("Reminder integration timed out"); await pause(25); }
}
async function start() { app = createApplication(config); base = `http://127.0.0.1:${await app.start(0)}`; }
function http(path: string, method = "GET", body?: unknown, guest?: GuestSession, origin?: string) {
  return fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(guest ? {Authorization: `Bearer ${guest.token}`} : {}), ...(origin ? {Origin: origin} : {}) }, ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
}
async function guest(name: string) {
  const response = await http("/api/sessions/guest", "POST", { displayName: name, inviteCode: config.inviteCode });
  expect(response.status).toBe(201); return await response.json() as GuestSession;
}
async function connect(person: GuestSession) {
  const seat = await http("/api/offices/demo-office/join", "POST", {protocolVersion: 1}, person);
  expect(seat.status).toBe(200);
  const room = await new Client(base).consumeSeatReservation<InstanceType<typeof OfficeState>>(await seat.json());
  rooms.add(room); room.onMessage("session.ready", () => {}); room.onMessage("audio.policy", () => {});
  const due: ReminderDue[] = [], errors: RequestError[] = [];
  room.onMessage("reminder.due", payload => due.push(payload)); room.onMessage("request.error", error => errors.push(error));
  await eventually(() => Boolean(room.state?.players?.has(room.sessionId)));
  return {room, due, errors};
}
afterAll(async () => {
  for (const room of rooms) await room.leave();
  await app?.stop(); rmSync(directory, {recursive: true, force: true});
});

describe("M5 reminder HTTP, private delivery, and application replacement", () => {
  it("persists offline work, retries privately, enforces ownership/revisions, and acknowledges across restart", async () => {
    await start(); const ada = await guest("Ada"), grace = await guest("Grace");
    const payload = { requestId: randomUUID(), text: "Private follow-up", dueAt: new Date(Date.now() - 1000).toISOString(), timezone: "America/Denver" };
    expect((await http("/api/reminders", "POST", payload)).status).toBe(401);
    expect((await http("/api/reminders", "POST", {...payload, timezone:"Mars/Olympus"}, ada)).status).toBe(400);
    expect((await http("/api/reminders", "POST", {...payload, ownerUserId:grace.userId}, ada)).status).toBe(400);
    const response = await http("/api/reminders", "POST", payload, ada);
    expect(response.status).toBe(201); const reminder = await response.json() as ReminderRecord;
    expect(await (await http("/api/reminders", "POST", payload, ada)).json()).toEqual(reminder);
    expect((await http("/api/reminders", "POST", {...payload, text:"different"}, ada)).status).toBe(409);
    expect(await (await http("/api/reminders", "GET", undefined, grace)).json()).toEqual({reminders: [], nextCursor:null});
    expect((await http("/api/reminders?before=invalid", "GET", undefined, ada)).status).toBe(400);
    const cors = await http(`/api/reminders/${reminder.id}`, "OPTIONS", undefined, ada, "http://localhost:2567");
    expect(cors.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
    // Replace the application, retaining only its SQLite volume and the guest token.
    await app!.stop(); app = undefined; await start();
    const outsider = await connect(grace), owner = await connect(ada);
    await eventually(() => owner.due.length > 0);
    expect(owner.due[0]!.reminder).toMatchObject({id:reminder.id, text:payload.text, timezone:payload.timezone});
    expect(outsider.due).toEqual([]);
    expect(JSON.stringify(outsider.room.state.toJSON())).not.toContain(payload.text);
    const notificationId = owner.due[0]!.notificationId;
    outsider.room.send("reminder.ack", {notificationId});
    await eventually(() => outsider.errors.some(error => error.code === "NOT_FOUND"));
    owner.room.send("reminder.ack", {notificationId:"forged"});
    await eventually(() => owner.errors.some(error => error.code === "INVALID_INPUT"));
    await eventually(() => owner.due.length >= 2, 7000);
    expect(owner.due[1]!.notificationId).toBe(notificationId);
    owner.room.send("reminder.ack", {notificationId});
    await eventually(async () => {
      const result = await (await http("/api/reminders", "GET", undefined, ada)).json() as {reminders:ReminderRecord[]};
      return result.reminders[0]?.status === "acknowledged";
    });
    owner.room.send("reminder.ack", {notificationId}); // Lost acknowledgement response is harmless.
    const another = {...payload, requestId:randomUUID(), text:"Move this deadline", dueAt:new Date(Date.now()+60000).toISOString()};
    const editable = await (await http("/api/reminders", "POST", another, ada)).json() as ReminderRecord;
    expect((await http(`/api/reminders/${editable.id}`, "PATCH", {requestId:randomUUID(), revision:editable.revision,status:"canceled"}, grace)).status).toBe(404);
    const edit = {requestId:randomUUID(), revision:editable.revision, text:"Updated deadline"};
    const changed = await http(`/api/reminders/${editable.id}`, "PATCH", edit, ada);
    expect(changed.status).toBe(200); const edited = await changed.json() as ReminderRecord;
    expect(edited.revision).toBe(editable.revision+1);
    expect(await (await http(`/api/reminders/${editable.id}`, "PATCH", edit, ada)).json()).toEqual(edited);
    expect((await http(`/api/reminders/${editable.id}`, "PATCH", {requestId:randomUUID(),revision:editable.revision,status:"canceled"}, ada)).status).toBe(409);
    expect((await http(`/api/reminders/${editable.id}`, "PATCH", {requestId:randomUUID(),revision:edited.revision,status:"canceled"}, ada)).status).toBe(200);
    for (const person of [owner,outsider]) { await person.room.leave(); rooms.delete(person.room); }
    await app!.stop(); app = undefined; await start();
    const resumed = await connect(ada); await pause(1200);
    expect(resumed.due).toEqual([]);
    const final = await (await http("/api/reminders", "GET", undefined, ada)).json() as {reminders:ReminderRecord[]};
    expect(final.reminders.find(item => item.id === reminder.id)?.status).toBe("acknowledged");
    expect(final.reminders.find(item => item.id === editable.id)?.status).toBe("canceled");
  }, 20000);
});
