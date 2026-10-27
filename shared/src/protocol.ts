/** Public, renderer-independent application contract. Never export server credentials here. */
export const PROTOCOL_VERSION = 1 as const;
export const OFFICE_ROOM = "office";
export const ERROR_CODES = ["INVALID_INPUT", "UNAUTHORIZED", "FORBIDDEN", "ROOM_FULL", "DUPLICATE_CONNECTION", "RATE_LIMITED", "INTERNAL_ERROR", "UNAVAILABLE", "STALE_TRANSITION", "TRANSITION_PENDING", "AI_UNAVAILABLE", "STALE_CONSENT", "NOT_FOUND", "CONFLICT"] as const;
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

/** Private audio messages; media identities are never authorization claims. */
export type AudioMode = "floor" | "meeting";
export interface MediaPreferences { muted: boolean; deafened: boolean }
/** Omit transitionRevision only while no transition is pending (floor-only M2 clients). */
export interface MediaTokenRequest { sessionId: string; transitionRevision?: number }
export interface MediaCredentials {
  url: string;
  token: string;
  mediaIdentity: string;
  roomName: string;
  expiresAt: string;
  transitionRevision: number;
  mode: AudioMode;
  /** Empty on the public floor. */
  zoneId: string;
  meetingSessionId?: string;
}
export interface AudioSpeaker { mediaIdentity: string; distance: number; gain: number }
export interface AudioPolicy { revision: number; mode: AudioMode; zoneId: string; speakers: AudioSpeaker[] }

/** Meeting-zone lifecycle, sent privately to the affected connection. */
export type TransitionReason = "zone_change" | "epoch_rotation" | "reconnect";
/** Disconnect current media, ack this revision, then request credentials with it. */
export interface MediaTransition { revision: number; mode: AudioMode; zoneId: string; meetingSessionId?: string; reason: TransitionReason }
export interface MediaTransitionAck { revision: number }
export interface MeetingEntered { zoneId: string; meetingSessionId: string; name: string; videoAvailable: boolean; revision: number }
export interface MeetingExited { zoneId: string; meetingSessionId: string; revision: number }

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
  audioMode: AudioMode;
  lastProcessedInputSeq: number;
}

/** Public indicator for an occupied meeting zone; media room names stay server-side. */
export interface MeetingIndicator {
  zoneId: string;
  meetingSessionId: string;
  occupancy: number;
  videoAvailable: boolean;
  videoCallActive: boolean;
  assistantStatus: "none" | AIStatusName;
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
  /** Keyed by zoneId, present only while occupied. */
  meetings: Record<string, MeetingIndicator>;
  /** Separate service principal; never included in players or audio rosters. */
  agents: Record<string, AgentAvatarState>;
}

export interface AgentAvatarState {
  agentId: string; x: number; y: number;
  state: string; badge: string; sponsorUserId: string;
}
/** Private availability-gated notification; retrieve the authorized request over HTTP. */
export interface AgentRequestNotice { requestId: string }


export type AIStatusName = "requesting_consent" | "capturing" | "paused" | "processing" | "completed" | "canceled" | "failed";
export interface AIStatus {
  aiSessionId: string; meetingSessionId: string; revision: number; status: AIStatusName;
  roster: { userId: string; displayName: string; consented: boolean }[];
  error?: string;
  /** Finalized speech excerpts available to the summary worker. */
  committedSegments?: number;
}
export interface AIRequest { requestId: string }
export interface AIConsent { aiSessionId: string; revision: number; consent: boolean }
export interface AIStop { aiSessionId: string; revision: number }
export interface NotesReady { noteId: string; aiSessionId: string }
export interface DraftClaim { text: string; segmentIds: string[] }
export interface DraftNotes {
  summary: DraftClaim[]; decisions: DraftClaim[];
  actionItems: (DraftClaim & { ownerUserId: string | null; dueAt: string | null })[];
}
export interface NoteRecord { id: string; aiSessionId: string; createdAt: string; partial: boolean; draft: DraftNotes }

/** Reminders are always owned by the authenticated caller, including confirmed AI proposals. */
export interface ReminderSource { noteId: string; actionItemIndex: number }
export interface CreateReminderRequest {
  requestId: string; text: string; dueAt: string; timezone: string; source?: ReminderSource;
}
export interface PatchReminderRequest {
  requestId: string; revision: number; text?: string; dueAt?: string; timezone?: string; status?: "canceled";
}
export interface ReminderRecord {
  id: string; text: string; dueAt: string; timezone: string;
  status: "scheduled" | "due" | "acknowledged" | "canceled";
  revision: number; createdAt: string; updatedAt: string; source?: ReminderSource;
}
/** Retry delivery with this stable ID until the owner acknowledges it. */
export interface ReminderDue { notificationId: string; reminder: ReminderRecord }
export interface ReminderAck { notificationId: string }
