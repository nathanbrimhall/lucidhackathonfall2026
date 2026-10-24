import { describe, expect, it } from "vitest";
import { toLocalInput, wallTimeToIso } from "../../tools/media-harness/reminder-time.js";

describe("reminder time-zone conversion", () => {
  it("rejects Denver's spring-forward gap", () => {
    expect(() => wallTimeToIso("2026-03-08T02:30", "America/Denver")).toThrow(/does not exist/);
  });

  it("rejects Denver's fall-back overlap", () => {
    expect(() => wallTimeToIso("2026-11-01T01:30", "America/Denver")).toThrow(/ambiguous/);
  });

  it("converts an ordinary Denver wall time to UTC independently of the browser zone", () => {
    expect(wallTimeToIso("2026-01-15T10:30", "America/Denver")).toBe("2026-01-15T17:30:00.000Z");
    expect(toLocalInput("2026-01-15T17:30:00.000Z", "America/Denver")).toBe("2026-01-15T10:30");
  });

  it("supports IANA zones with quarter-hour offsets", () => {
    expect(wallTimeToIso("2026-01-15T10:30", "Asia/Kathmandu")).toBe("2026-01-15T04:45:00.000Z");
    expect(toLocalInput("2026-01-15T04:45:00.000Z", "Asia/Kathmandu")).toBe("2026-01-15T10:30");
  });

  it("rejects invalid dates and time zones", () => {
    expect(() => wallTimeToIso("2026-02-30T10:30", "UTC")).toThrow(/calendar date/);
    expect(() => wallTimeToIso("2026-01-15T10:30", "Mars/Olympus")).toThrow(/IANA time zone/);
  });
});
