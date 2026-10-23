/** Public, renderer-independent application contract. Never export server credentials here. */
export const PROTOCOL_VERSION = 1 as const;
export const OFFICE_ROOM = "office";
export const ERROR_CODES = ["INVALID_INPUT", "UNAUTHORIZED", "FORBIDDEN", "ROOM_FULL", "DUPLICATE_CONNECTION", "RATE_LIMITED", "INTERNAL_ERROR", "UNAVAILABLE"] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export interface RequestError { code: ErrorCode; message: string }
export interface GuestIdentity {
  userId: string;
  officeId: string;
  displayName: string;
  expiresAt: string;
}
export interface GuestSession extends GuestIdentity { token: string }
export interface CreateGuestRequest { inviteCode: string; displayName: string }
export interface JoinOfficeRequest { protocolVersion: typeof PROTOCOL_VERSION }
export interface SessionReady extends GuestIdentity { sessionId: string; protocolVersion: typeof PROTOCOL_VERSION }
