import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Storage } from "../repositories/Storage.js";

export type AuthErrorCode = "INVALID_INPUT" | "UNAUTHORIZED" | "FORBIDDEN";
export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string) { super(message); this.name = "AuthError"; }
}

export interface AuthOptions {
  sessionSecret: string;
  inviteCode: string;
  officeId: string;
  sessionTtlSeconds?: number;
}
export interface GuestIdentity {
  userId: string;
  officeId: string;
  displayName: string;
  expiresAt: string;
}
export interface GuestSession extends GuestIdentity { token: string }

const guestSchema = z.strictObject({
  inviteCode: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(48).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Display name contains control characters"),
});
const claimsSchema = z.strictObject({
  v: z.literal(1),
  userId: z.uuid(),
  officeId: z.string().min(1).max(128),
  iat: z.number().int().nonnegative().safe(),
  exp: z.number().int().positive().safe(),
});

function equalSecret(left: string, right: string): boolean {
  // Fixed-size digests make comparison timing independent of input length.
  const key = "guest-invite-comparison";
  return timingSafeEqual(createHmac("sha256", key).update(left).digest(), createHmac("sha256", key).update(right).digest());
}

/** Signed, versioned bearer tokens. Identity and membership are rechecked on every use. */
export class AuthService {
  private readonly ttl: number;
  constructor(private readonly storage: Storage, private readonly options: AuthOptions) {
    this.ttl = options.sessionTtlSeconds ?? 60 * 60 * 24 * 7;
    if (options.sessionSecret.length < 32 || !options.inviteCode || options.inviteCode.length > 256 || !options.officeId || options.officeId.length > 128 || !Number.isSafeInteger(this.ttl) || this.ttl <= 0 || this.ttl > 60 * 60 * 24 * 365) {
      throw new Error("Invalid authentication configuration");
    }
  }

  createGuest(payload: unknown): GuestSession {
    const parsed = guestSchema.safeParse(payload);
    if (!parsed.success) throw new AuthError("INVALID_INPUT", "Expected an invite code and a display name of 1–48 characters");
    if (!equalSecret(parsed.data.inviteCode, this.options.inviteCode)) throw new AuthError("UNAUTHORIZED", "Invalid invite code");
    const user = this.storage.createGuest(parsed.data.displayName, this.options.officeId);
    const now = Math.floor(Date.now() / 1000);
    const claims = { v: 1, userId: user.userId, officeId: this.options.officeId, iat: now, exp: now + this.ttl };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return { token: `${encoded}.${this.sign(encoded)}`, userId: user.userId, officeId: this.options.officeId, displayName: user.displayName, expiresAt: new Date(claims.exp * 1000).toISOString() };
  }

  authenticate(token: string): GuestIdentity {
    const unauthorized = () => new AuthError("UNAUTHORIZED", "Invalid or expired session");
    if (typeof token !== "string" || token.length > 2048) throw unauthorized();
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1])) throw unauthorized();
    const encoded = parts[0];
    const actualSignature = Buffer.from(parts[1], "base64url");
    const expectedSignature = Buffer.from(this.sign(encoded), "base64url");
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) throw unauthorized();
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw unauthorized(); }
    const parsed = claimsSchema.safeParse(decoded);
    const now = Math.floor(Date.now() / 1000);
    if (!parsed.success || parsed.data.exp <= now || parsed.data.iat > now || parsed.data.exp <= parsed.data.iat) throw unauthorized();
    const claims = parsed.data;
    const user = this.storage.getUser(claims.userId);
    if (!user) throw unauthorized();
    if (claims.officeId !== this.options.officeId || !this.storage.hasMembership(user.userId, claims.officeId)) throw new AuthError("FORBIDDEN", "Office membership required");
    return { userId: user.userId, officeId: claims.officeId, displayName: user.displayName, expiresAt: new Date(claims.exp * 1000).toISOString() };
  }

  private sign(encoded: string): string {
    return createHmac("sha256", this.options.sessionSecret).update(encoded).digest("base64url");
  }
}
