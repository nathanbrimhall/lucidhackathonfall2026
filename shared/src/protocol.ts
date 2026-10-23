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

/** Cardinal movement direction used for the public avatar state. */
export type Facing = "up" | "down" | "left" | "right";
export type PlayerStatus = "available" | "away" | "busy";

/** Client intent only. Position and elapsed time are always derived by the server. */
export interface PlayerInput { seq: number; dx: number; dy: number }
export interface PlayerStatusRequest { status: PlayerStatus }

/** Renderer-independent public state synchronized by the office room. */
export interface PlayerState {
  userId: string;
  sessionId: string;
  displayName: string;
  avatarId: string;
  x: number;
  y: number;
  facing: Facing;
  status: PlayerStatus;
  connected: boolean;
  zoneId: string;
  audioMode: "floor" | "meeting";
  lastProcessedInputSeq: number;
}

/** JSON snapshot shape; live Colyseus clients expose players as a MapSchema. */
export interface OfficeState {
  officeId: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  mapId: string;
  mapVersion: number;
  serverTick: number;
  /** Colyseus connection session IDs are the synchronized map keys. */
  players: Record<string, PlayerState>;
}
