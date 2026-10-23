import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mapSchema, type MeetingZone, type OfficeMap } from "../../shared/src/map-contract.js";
import { loadOfficeMap } from "../src/domain/map.js";
import { zoneAt } from "../src/domain/meeting-zones.js";
import { MEETING_REENTRY_COOLDOWN_MS, Meetings } from "../src/domain/meetings.js";
import { movePlayer, SIMULATION_INTERVAL_MS } from "../src/domain/movement.js";
import { computeMeetingAudio, computeProximity, type ProximityParticipant } from "../src/domain/proximity.js";

function zone(id: string, x: number, y: number, width = 3, height = 3): MeetingZone {
  return { id, name: id, bounds: { x, y, width, height }, audioMode: "meeting", videoEnabled: false };
}
// Test-only fixture: two zones sharing the x = 5 wall, owned by the right-hand zone.
const adjacent: OfficeMap = mapSchema.parse({ ...loadOfficeMap(), meetingZones: [zone("a", 2, 2), zone("b", 5, 2)] });
let ids = 0;
const sequential = () => `id-${++ids}`;

describe("meeting-zone membership", () => {
  it("owns left/top edges and excludes right/bottom edges exactly", () => {
    const map = loadOfficeMap();
    expect(zoneAt(map, { x: 21.5, y: 2 })?.id).toBe("meeting-east");
    expect(zoneAt(map, { x: 21.5, y: 11.999 })?.id).toBe("meeting-east");
    expect(zoneAt(map, { x: 21.4999, y: 7 })).toBeUndefined();
    expect(zoneAt(map, { x: 30, y: 7 })).toBeUndefined();
    expect(zoneAt(map, { x: 25, y: 12 })).toBeUndefined();
    expect(zoneAt(map, { x: 25, y: 1.999 })).toBeUndefined();
    expect(zoneAt(adjacent, { x: 5, y: 3 })?.id).toBe("b");
    expect(zoneAt(adjacent, { x: 4.999, y: 3 })?.id).toBe("a");
  });

  it("enters through the doorway once and cannot pass through the wall", () => {
    const map = loadOfficeMap();
    let position = { x: 19, y: 7 };
    const zones: string[] = [];
    for (let tick = 0; tick < 40; tick++) {
      position = movePlayer(map, position, { dx: 1, dy: 0 }, SIMULATION_INTERVAL_MS);
      const id = zoneAt(map, position)?.id ?? "";
      if (zones.at(-1) !== id) zones.push(id);
    }
    expect(zones).toEqual(["", "meeting-east"]);
    let blocked = { x: 19, y: 4 };
    for (let tick = 0; tick < 40; tick++) blocked = movePlayer(map, blocked, { dx: 1, dy: 0 }, SIMULATION_INTERVAL_MS);
    expect(blocked.x).toBeLessThanOrEqual(20.75);
    expect(zoneAt(map, blocked)).toBeUndefined();
  });
});

describe("meeting session state machine", () => {
  it("creates a session on first entry, joins it without rotation, and deduplicates", () => {
    const meetings = new Meetings(sequential);
    expect(meetings.move("s1", "")).toMatchObject({ transitions: [] });
    const first = meetings.move("s1", "a");
    const session = meetings.session("a")!;
    expect(session.roomName).toMatch(/^meet_/);
    expect(first).toMatchObject({ entered: { zoneId: "a", meetingSessionId: session.meetingSessionId }, retiredRooms: [], zones: ["a"] });
    expect(first.transitions).toEqual([{ sessionId: "s1", revision: 1, mode: "meeting", zoneId: "a", meetingSessionId: session.meetingSessionId, roomName: session.roomName, reason: "zone_change" }]);
    const second = meetings.move("s2", "a");
    expect(second.transitions).toHaveLength(1);
    expect(second.retiredRooms).toEqual([]);
    expect(meetings.session("a")).toMatchObject({ epoch: 0, roomName: session.roomName });
    expect([...meetings.session("a")!.occupants]).toEqual(["s1", "s2"]);
    expect(meetings.move("s2", "a").transitions).toEqual([]);
  });

  it("rotates the epoch for remaining occupants on exit and ends the session on last exit", () => {
    let now = 0;
    const meetings = new Meetings(sequential, () => now);
    meetings.move("s1", "a"); meetings.move("s2", "a"); meetings.move("s3", "a");
    const { meetingSessionId, roomName } = meetings.session("a")!;
    const exit = meetings.move("s1", "");
    const rotated = { ...meetings.session("a")! };
    expect(rotated).toMatchObject({ meetingSessionId, epoch: 1 });
    expect(rotated.roomName).not.toBe(roomName);
    expect(exit.retiredRooms).toEqual([roomName]);
    expect(exit.exited).toEqual({ zoneId: "a", meetingSessionId });
    expect(exit.transitions).toEqual([
      { sessionId: "s2", revision: 2, mode: "meeting", zoneId: "a", meetingSessionId, roomName: rotated.roomName, reason: "epoch_rotation" },
      { sessionId: "s3", revision: 2, mode: "meeting", zoneId: "a", meetingSessionId, roomName: rotated.roomName, reason: "epoch_rotation" },
      { sessionId: "s1", revision: 2, mode: "floor", zoneId: "", reason: "zone_change" },
    ]);
    const drop = meetings.leave("s2");
    expect(drop.transitions.map(t => [t.sessionId, t.reason])).toEqual([["s3", "epoch_rotation"]]);
    expect(drop.retiredRooms).toEqual([rotated.roomName]);
    const last = meetings.move("s3", "");
    expect(meetings.session("a")).toBeUndefined();
    expect(last.retiredRooms).toHaveLength(1);
    expect(last.transitions.map(t => t.sessionId)).toEqual(["s3"]);
    expect(meetings.move("s1", "a")).toMatchObject({ transitions: [], zones: [] });
    now = MEETING_REENTRY_COOLDOWN_MS;
    const revisit = meetings.move("s1", "a");
    expect(revisit.entered!.meetingSessionId).not.toBe(meetingSessionId);
    expect(meetings.revision("s1")).toBe(3);
  });

  it("moves directly between adjacent rooms, rotating only the room left behind", () => {
    const meetings = new Meetings(sequential);
    meetings.move("s1", "a"); meetings.move("s2", "a");
    const a = meetings.session("a")!.roomName;
    const change = meetings.move("s1", "b");
    expect(change.exited?.zoneId).toBe("a");
    expect(change.entered?.zoneId).toBe("b");
    expect(change.retiredRooms).toEqual([a]);
    expect(change.zones).toEqual(["a", "b"]);
    expect(change.transitions.map(t => [t.sessionId, t.zoneId, t.roomName, t.reason])).toEqual([
      ["s2", "a", meetings.session("a")!.roomName, "epoch_rotation"],
      ["s1", "b", meetings.session("b")!.roomName, "zone_change"],
    ]);
    expect(meetings.zoneOf("s1")).toBe("b");
  });

  it("keeps revisions monotonic through spaced doorway crossings and reconnects", () => {
    let now = 0;
    const meetings = new Meetings(randomUUID, () => now);
    meetings.move("stay", "a");
    const seen: number[] = [];
    for (let i = 0; i < 20; i++, now += 1000) for (const t of meetings.move("churn", i % 2 ? "" : "a").transitions) if (t.sessionId === "churn") seen.push(t.revision);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(meetings.revision("stay")).toBe(11);
    const rooms = new Set<string>();
    for (let i = 0; i < 5; i++, now += 1000) { meetings.move("churn", "a"); rooms.add(meetings.session("a")!.roomName); meetings.move("churn", ""); }
    expect(rooms.size).toBe(5);
    meetings.leave("churn");
    // Reconnect is not a walking re-entry and is never deferred.
    now -= 999;
    expect(meetings.move("churn", "a", "reconnect").transitions.at(-1)).toMatchObject({ revision: 31, reason: "reconnect" });
    expect(meetings.forget("churn").transitions).toHaveLength(1);
    expect(meetings.revision("churn")).toBe(0);
  });
});

describe("doorway flapping", () => {
  it("exits immediately but defers re-entry, bounding rotations to about one per cooldown", () => {
    let now = 0;
    const meetings = new Meetings(randomUUID, () => now);
    meetings.move("stay", "a"); meetings.move("flap", "a");
    const rotations: number[] = [];
    for (let tick = 0; tick < 40; tick++) {
      now += 50;
      const target = tick % 2 ? "a" : "";
      const change = meetings.move("flap", target);
      for (const t of change.transitions) if (t.sessionId === "stay") rotations.push(t.revision);
      if (!target) expect(meetings.zoneOf("flap")).toBe("");
    }
    // 40 crossings over 2 s: one exit at the start, one re-entry and exit after the cooldown.
    expect(rotations.length).toBeGreaterThanOrEqual(1);
    expect(rotations.length).toBeLessThanOrEqual(Math.ceil(40 * 50 / MEETING_REENTRY_COOLDOWN_MS) + 1);
    expect(meetings.revision("stay")).toBe(1 + rotations.length);
    // A deferred player stays on the floor until the first tick after the cooldown.
    now += MEETING_REENTRY_COOLDOWN_MS;
    expect(meetings.move("flap", "a").entered?.zoneId).toBe("a");
  });

  it("does not delay first entry or a direct room-to-room move after a long stay", () => {
    let now = 0;
    const meetings = new Meetings(randomUUID, () => now);
    expect(meetings.move("s1", "a").entered?.zoneId).toBe("a");
    meetings.move("s1", "");
    now = 10;
    expect(meetings.move("s1", "a").transitions).toEqual([]);
    now = 1010;
    expect(meetings.move("s1", "a").entered?.zoneId).toBe("a");
    now = 5000;
    const direct = meetings.move("s1", "b");
    expect(direct).toMatchObject({ exited: { zoneId: "a" }, entered: { zoneId: "b" } });
    expect(direct.transitions.at(-1)).toMatchObject({ mode: "meeting", zoneId: "b" });
    // Immediately turning back counts against the exit from "a" just now: exit now, re-enter later.
    now = 5050;
    const back = meetings.move("s1", "a");
    expect(back.exited?.zoneId).toBe("b");
    expect(back.entered).toBeUndefined();
    expect(back.transitions.at(-1)).toMatchObject({ mode: "floor", zoneId: "" });
  });
});

describe("meeting audio policy", () => {
  const person = (sessionId: string, x: number, zoneId = "a", extra: Partial<ProximityParticipant> = {}): ProximityParticipant => ({
    sessionId, mediaIdentity: `m-${sessionId}`, x, y: 3, connected: true, audioMode: zoneId ? "meeting" : "floor", zoneId, muted: false, deafened: false, ...extra,
  });
  it("hears every unmuted occupant at full gain and nothing across the wall", () => {
    const people = [person("l", 2), person("far", 4.9), person("muted", 3, "a", { muted: true }), person("gone", 3, "a", { connected: false }),
      person("other", 5.1, "b"), person("floor", 1.9, "")];
    expect(computeMeetingAudio(people[0], people)).toEqual([{ mediaIdentity: "m-far", distance: expect.closeTo(2.9), gain: 1 }]);
    expect(computeMeetingAudio({ ...people[0], deafened: true }, people)).toEqual([]);
    expect(computeMeetingAudio(people[5], people)).toEqual([]);
    expect(computeProximity(people[5], people)).toEqual([]);
  });
});
