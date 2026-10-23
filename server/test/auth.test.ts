import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, AuthService } from "../src/auth/AuthService.js";
import { migrateDatabase, openStorage, type Storage } from "../src/repositories/Storage.js";

const options = { sessionSecret: "test-session-secret-with-at-least-32-characters", inviteCode: "office-invite", officeId: "main", sessionTtlSeconds: 60 };
let directory: string;
let databasePath: string;
let storage: Storage;
let auth: AuthService;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "office-auth-"));
  databasePath = join(directory, "nested", "office.sqlite");
  storage = openStorage(databasePath);
  auth = new AuthService(storage, options);
});
afterEach(() => {
  vi.useRealTimers();
  storage.close();
  rmSync(directory, { recursive: true, force: true });
});

function expectCode(action: () => unknown, code: string): void {
  try { action(); throw new Error("Expected authentication to fail"); }
  catch (error) { expect(error).toBeInstanceOf(AuthError); expect((error as AuthError).code).toBe(code); }
}

describe("guest sessions", () => {
  it("redeems an invite, trims the display name, and resumes a durable identity", () => {
    const guest = auth.createGuest({ inviteCode: options.inviteCode, displayName: "  Ada  " });
    expect(guest.displayName).toBe("Ada");
    expect(storage.hasMembership(guest.userId, "main")).toBe(true);
    expect(storage.healthCheck()).toBe(true);
    storage.close();
    migrateDatabase(databasePath);
    migrateDatabase(databasePath);
    storage = openStorage(databasePath);
    auth = new AuthService(storage, options);
    expect(auth.authenticate(guest.token)).toEqual({ userId: guest.userId, officeId: "main", displayName: "Ada", expiresAt: guest.expiresAt });
  });

  it("rejects a wrong invite without creating an identity", () => {
    expectCode(() => auth.createGuest({ inviteCode: "wrong", displayName: "Ada" }), "UNAUTHORIZED");
    const db = new Database(databasePath);
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  });

  it.each([
    { inviteCode: options.inviteCode, displayName: "   " },
    { inviteCode: options.inviteCode, displayName: "A".repeat(49) },
    { inviteCode: options.inviteCode, displayName: "Ada\u0000" },
    { inviteCode: options.inviteCode, displayName: "Ada", officeId: "other" },
    { inviteCode: options.inviteCode, displayName: 123 },
    null,
  ])("rejects malformed guest payload %#", (payload) => {
    expectCode(() => auth.createGuest(payload), "INVALID_INPUT");
  });

  it("expires at the exact signed expiry and rejects a modified signature or payload", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const guest = auth.createGuest({ inviteCode: options.inviteCode, displayName: "Ada" });
    expectCode(() => auth.authenticate(`${guest.token.slice(0, -2)}aa`), "UNAUTHORIZED");
    const [payload, signature] = guest.token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.officeId = "admin";
    const modified = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expectCode(() => auth.authenticate(`${modified}.${signature}`), "UNAUTHORIZED");
    vi.setSystemTime(new Date("2026-10-23T12:00:59.999Z"));
    expect(auth.authenticate(guest.token).userId).toBe(guest.userId);
    vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
    expectCode(() => auth.authenticate(guest.token), "UNAUTHORIZED");
  });

  it("rechecks membership instead of trusting the signed office claim", () => {
    const guest = auth.createGuest({ inviteCode: options.inviteCode, displayName: "Ada" });
    const db = new Database(databasePath);
    try { db.prepare("DELETE FROM office_memberships WHERE user_id = ?").run(guest.userId); }
    finally { db.close(); }
    expectCode(() => auth.authenticate(guest.token), "FORBIDDEN");
  });

  it("rejects a removed user, a different office, and malformed bearer tokens", () => {
    const guest = auth.createGuest({ inviteCode: options.inviteCode, displayName: "Ada" });
    const otherOfficeAuth = new AuthService(storage, { ...options, officeId: "other" });
    expectCode(() => otherOfficeAuth.authenticate(guest.token), "FORBIDDEN");
    for (const token of ["", "x.y.z", "x.y", "a".repeat(2049)]) expectCode(() => auth.authenticate(token), "UNAUTHORIZED");
    const db = new Database(databasePath);
    try { db.pragma("foreign_keys = ON"); db.prepare("DELETE FROM users WHERE user_id = ?").run(guest.userId); }
    finally { db.close(); }
    expectCode(() => auth.authenticate(guest.token), "UNAUTHORIZED");
  });
});
