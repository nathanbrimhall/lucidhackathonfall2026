import { describe, expect, it } from "vitest";
import { computeProximity, type ProximityParticipant } from "../src/domain/proximity.js";

const participant = (overrides: Partial<ProximityParticipant> = {}): ProximityParticipant => ({
  sessionId: "session", mediaIdentity: "media", x: 0, y: 0, connected: true,
  audioMode: "floor", zoneId: "floor", muted: false, deafened: false, ...overrides,
});
const listen = (listener: ProximityParticipant, others: ProximityParticipant[], previous?: ReadonlySet<string>) =>
  computeProximity(listener, others, previous);

describe("public-floor proximity", () => {
  it("uses full gain through 2 tiles, then fades linearly to zero at 6", () => {
    const listener = participant();
    const speakers = [2, 4, 6, 6.01].map((x, i) => participant({ sessionId: `s${i}`, mediaIdentity: `m${i}`, x }));
    expect(listen(listener, speakers)).toEqual([
      { mediaIdentity: "m0", distance: 2, gain: 1 },
      { mediaIdentity: "m1", distance: 4, gain: 0.5 },
      { mediaIdentity: "m2", distance: 6, gain: 0 },
    ]);
    expect(listen(listener, [participant({ sessionId: "near", mediaIdentity: "near", x: 1.5 })])[0]?.gain).toBe(1);
  });

  it("enters at exactly 6, retains an existing subscription through 7, and removes beyond 7", () => {
    const listener = participant();
    const speaker = participant({ sessionId: "other", mediaIdentity: "other", x: 6 });
    expect(listen(listener, [speaker]).map(p => p.mediaIdentity)).toEqual(["other"]);
    speaker.x = 7;
    expect(listen(listener, [speaker], new Set(["other"]))).toEqual([{ mediaIdentity: "other", distance: 7, gain: 0 }]);
    expect(listen(listener, [speaker]).map(p => p.mediaIdentity)).toEqual([]);
    speaker.x = 7.001;
    expect(listen(listener, [speaker], new Set(["other"]))).toEqual([]);
  });

  it("calculates each listener-speaker pair independently without transitive hearing", () => {
    const a = participant({ sessionId: "a", mediaIdentity: "a", x: 0 });
    const b = participant({ sessionId: "b", mediaIdentity: "b", x: 5 });
    const c = participant({ sessionId: "c", mediaIdentity: "c", x: 10 });
    expect(listen(a, [a, b, c]).map(p => p.mediaIdentity)).toEqual(["b"]);
    expect(listen(c, [a, b, c]).map(p => p.mediaIdentity)).toEqual(["b"]);
    expect(listen(b, [a, b, c]).map(p => p.mediaIdentity)).toEqual(["a", "c"]);
  });

  it("excludes self, other zones, meeting participants, muted speakers, and disconnected speakers", () => {
    const listener = participant();
    const self = participant({ x: 1 });
    const others = [
      participant({ sessionId: "session", mediaIdentity: "session-self", x: 1 }),
      participant({ sessionId: "same-media-session", mediaIdentity: "media", x: 1 }),
      participant({ sessionId: "zone", mediaIdentity: "zone", x: 1, zoneId: "meeting-a" }),
      participant({ sessionId: "meeting", mediaIdentity: "meeting", x: 1, audioMode: "meeting" }),
      participant({ sessionId: "muted", mediaIdentity: "muted", x: 1, muted: true }),
      participant({ sessionId: "gone", mediaIdentity: "gone", x: 1, connected: false }),
    ];
    expect(listen(listener, [self, ...others])).toEqual([]);
  });

  it("returns no speakers when the listener is deafened, disconnected, or in meeting mode", () => {
    const speaker = participant({ sessionId: "speaker", mediaIdentity: "speaker", x: 1 });
    for (const listener of [
      participant({ deafened: true }), participant({ connected: false }), participant({ audioMode: "meeting" }),
    ]) expect(listen(listener, [speaker])).toEqual([]);
  });

  it("returns unique identities in stable sorted order", () => {
    const listener = participant();
    const speakers = [
      participant({ sessionId: "z", mediaIdentity: "z", x: 3 }),
      participant({ sessionId: "a", mediaIdentity: "a", x: 2 }),
      participant({ sessionId: "a-duplicate", mediaIdentity: "a", x: 1 }),
    ];
    expect(listen(listener, speakers).map(p => p.mediaIdentity)).toEqual(["a", "z"]);
    expect(listen(listener, speakers)[0]?.distance).toBe(1);
  });
});
