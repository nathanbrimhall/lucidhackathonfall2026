import { describe, expect, it } from "vitest";
import { mediaPreferencesSchema, mediaTokenSchema, mediaTransitionAckSchema, playerInputSchema, playerStatusSchema } from "../../shared/src/validation.js";

describe("runtime movement and status validation", () => {
  it("accepts bounded finite direction intent and a safe nonnegative sequence", () => {
    expect(playerInputSchema.parse({ seq: 0, dx: -1, dy: 1 })).toEqual({ seq: 0, dx: -1, dy: 1 });
    expect(playerInputSchema.safeParse({ seq: Number.MAX_SAFE_INTEGER, dx: 0.5, dy: 0 }).success).toBe(true);
  });

  it.each([
    { seq: -1, dx: 0, dy: 0 },
    { seq: 1.5, dx: 0, dy: 0 },
    { seq: Number.MAX_SAFE_INTEGER + 1, dx: 0, dy: 0 },
    { seq: 1, dx: 1.01, dy: 0 },
    { seq: 1, dx: 0, dy: -1.01 },
    { seq: 1, dx: Number.NaN, dy: 0 },
    { seq: 1, dx: 0, dy: Number.POSITIVE_INFINITY },
    { seq: 1, dx: 0, dy: 0, x: 999, y: 999 },
    { seq: 1, dx: 0, dy: 0, deltaTime: 999 },
  ])("rejects malformed or authority-claiming movement payloads %#", (payload) => {
    expect(playerInputSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts only the three public player statuses", () => {
    for (const status of ["available", "away", "busy"] as const) {
      expect(playerStatusSchema.safeParse({ status }).success).toBe(true);
    }
    expect(playerStatusSchema.safeParse({ status: "offline" }).success).toBe(false);
    expect(playerStatusSchema.safeParse({ status: "busy", userId: "forged" }).success).toBe(false);
  });
});

describe("media request validation", () => {
  it("accepts only a bounded session identifier for token requests", () => {
    expect(mediaTokenSchema.safeParse({ sessionId: "seat-session" }).success).toBe(true);
    for (const payload of [
      { sessionId: "seat-session", roomName: "forged-room" },
      { sessionId: "seat-session", mediaIdentity: "forged-identity" },
      { sessionId: "" },
      { sessionId: "x".repeat(129) },
      { sessionId: "seat-session", transitionRevision: -1 },
      { sessionId: "seat-session", transitionRevision: 1.5 },
      { sessionId: "seat-session", transitionRevision: "1" },
    ]) expect(mediaTokenSchema.safeParse(payload).success).toBe(false);
    expect(mediaTokenSchema.safeParse({ sessionId: "seat-session", transitionRevision: 0 }).success).toBe(true);
  });

  it("accepts only a bare non-negative revision as a transition acknowledgement", () => {
    expect(mediaTransitionAckSchema.safeParse({ revision: 3 }).success).toBe(true);
    for (const payload of [{ revision: -1 }, { revision: Infinity }, { revision: 2 ** 53 }, { revision: 1, zoneId: "forged" }, {}])
      expect(mediaTransitionAckSchema.safeParse(payload).success).toBe(false);
  });

  it("requires exactly boolean mute and deafen preferences", () => {
    expect(mediaPreferencesSchema.safeParse({ muted: true, deafened: false }).success).toBe(true);
    for (const payload of [
      { muted: "false", deafened: false },
      { muted: false, deafened: 0 },
      { muted: false, deafened: false, mediaIdentity: "forged" },
    ]) expect(mediaPreferencesSchema.safeParse(payload).success).toBe(false);
  });
});
