import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

export const testEnv = {
  PUBLIC_SERVER_URL: "http://localhost:2567",
  ALLOWED_ORIGINS: "http://localhost:2567,http://localhost:5173",
  SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
  DATABASE_URL: ":memory:", GUEST_INVITE_CODE: "test-invite-code", OFFICE_ID: "demo-office",
  LIVEKIT_INTERNAL_URL: "http://127.0.0.1:1", LIVEKIT_PUBLIC_URL: "ws://localhost:7880",
  LIVEKIT_API_KEY: "testkey", LIVEKIT_API_SECRET: "test-only-livekit-secret-at-least-32-characters",
};

describe("startup configuration", () => {
  it("validates URLs and parses port and origin lists", () => {
    const config = loadConfig({ ...testEnv, PORT: "3000" });
    expect(config.port).toBe(3000);
    expect(config.allowedOrigins).toEqual(["http://localhost:2567", "http://localhost:5173"]);
  });
  it.each([
    ["SESSION_SECRET", "short"], ["GUEST_INVITE_CODE", ""], ["PORT", "NaN"], ["PORT", "0"],
    ["ALLOWED_ORIGINS", "*"], ["ALLOWED_ORIGINS", "http://localhost:2567/path"],
    ["PUBLIC_SERVER_URL", "ftp://example.com"], ["LIVEKIT_PUBLIC_URL", "http://localhost:7880"],
    ["LIVEKIT_INTERNAL_URL", "http://user:secret@localhost:7880"], ["LIVEKIT_API_SECRET", "short"],
    ["DATABASE_URL", "postgres://localhost/db"], ["OFFICE_ID", "../other"],
  ])("rejects invalid %s without revealing its value", (key, value) => {
    expect(() => loadConfig({ ...testEnv, [key]: value })).toThrow(key);
  });
  it("does not echo secrets in configuration errors", () => {
    try { loadConfig({ ...testEnv, SESSION_SECRET: "sensitive-value" }); }
    catch (error) { expect(String(error)).not.toContain("sensitive-value"); return; }
    throw new Error("Expected configuration error");
  });
});
