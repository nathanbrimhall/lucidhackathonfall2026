import { randomUUID } from "node:crypto";
import type { AudioMode, TransitionReason } from "../../../shared/src/protocol.js";

/** Re-entry after a walking exit waits this long; exits are never delayed. */
export const MEETING_REENTRY_COOLDOWN_MS = 1000;

export interface MeetingSession {
  readonly zoneId: string;
  readonly meetingSessionId: string;
  epoch: number;
  roomName: string;
  readonly occupants: Set<string>;
}

export interface MeetingTransition {
  sessionId: string;
  revision: number;
  mode: AudioMode;
  zoneId: string;
  meetingSessionId?: string;
  /** Opaque media room for a meeting destination; floor rooms belong to the media service. */
  roomName?: string;
  reason: TransitionReason;
}

export interface MeetingRef { zoneId: string; meetingSessionId: string }

export interface MeetingChange {
  /** The connection whose membership changed; it receives entered/exited. */
  sessionId: string;
  exited?: MeetingRef;
  entered?: MeetingRef;
  transitions: MeetingTransition[];
  /** Media rooms that no current binding may use; delete them. */
  retiredRooms: string[];
  /** Zones whose public indicator changed. */
  zones: string[];
}

/**
 * In-memory meeting sessions for one office. Entry joins the current epoch;
 * any departure that leaves occupants behind retires the epoch room so earlier
 * tokens can never reach the continuing meeting. Revisions are per connection
 * and strictly increasing. Doorway flapping is bounded by deferring re-entry
 * (never exit) for a cooldown after the previous walking exit.
 */
export class Meetings {
  private readonly sessions = new Map<string, MeetingSession>();
  private readonly members = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly exits = new Map<string, number>();

  constructor(private readonly id: () => string = randomUUID, private readonly now: () => number = () => performance.now()) {}

  session(zoneId: string): Readonly<MeetingSession> | undefined { return this.sessions.get(zoneId); }
  active(): IterableIterator<Readonly<MeetingSession>> { return this.sessions.values(); }
  zoneOf(sessionId: string): string { return this.members.get(sessionId) ?? ""; }
  revision(sessionId: string): number { return this.revisions.get(sessionId) ?? 0; }

  /**
   * "" is the floor. Unchanged zone-change moves are deduplicated; reconnect always
   * transitions. A deferred entry leaves the player on the floor; callers retry each tick.
   */
  move(sessionId: string, zoneId: string, reason: "zone_change" | "reconnect" = "zone_change"): MeetingChange {
    const change: MeetingChange = { sessionId, transitions: [], retiredRooms: [], zones: [] };
    const from = this.zoneOf(sessionId);
    if (from === zoneId && reason === "zone_change") return change;
    // Compare with the exit before this move, so a long stay still allows a direct room-to-room move.
    const now = this.now(), lastExit = this.exits.get(sessionId);
    const deferred = !!zoneId && reason === "zone_change" && lastExit !== undefined && now - lastExit < MEETING_REENTRY_COOLDOWN_MS;
    if (deferred && !from) return change;
    if (from) { this.depart(sessionId, from, change); this.exits.set(sessionId, now); }
    let session: MeetingSession | undefined;
    if (zoneId && !deferred) {
      session = this.sessions.get(zoneId);
      if (!session) { session = { zoneId, meetingSessionId: this.id(), epoch: 0, roomName: `meet_${this.id()}`, occupants: new Set() }; this.sessions.set(zoneId, session); }
      session.occupants.add(sessionId);
      this.members.set(sessionId, zoneId);
      change.entered = { zoneId, meetingSessionId: session.meetingSessionId };
      change.zones.push(zoneId);
    }
    change.transitions.push(session
      ? { sessionId, revision: this.bump(sessionId), mode: "meeting", zoneId, meetingSessionId: session.meetingSessionId, roomName: session.roomName, reason }
      : { sessionId, revision: this.bump(sessionId), mode: "floor", zoneId: "", reason });
    return change;
  }

  /** Removes occupancy without a transition for the departing connection (its media is already gone). */
  leave(sessionId: string): MeetingChange {
    const change: MeetingChange = { sessionId, transitions: [], retiredRooms: [], zones: [] };
    const from = this.zoneOf(sessionId);
    if (from) this.depart(sessionId, from, change);
    return change;
  }

  forget(sessionId: string): MeetingChange {
    const change = this.leave(sessionId);
    this.revisions.delete(sessionId);
    this.exits.delete(sessionId);
    return change;
  }

  private depart(sessionId: string, zoneId: string, change: MeetingChange) {
    const session = this.sessions.get(zoneId)!;
    session.occupants.delete(sessionId);
    this.members.delete(sessionId);
    change.exited = { zoneId, meetingSessionId: session.meetingSessionId };
    change.zones.push(zoneId);
    change.retiredRooms.push(session.roomName);
    if (!session.occupants.size) { this.sessions.delete(zoneId); return; }
    session.epoch++;
    session.roomName = `meet_${this.id()}`;
    for (const occupant of session.occupants) change.transitions.push({
      sessionId: occupant, revision: this.bump(occupant), mode: "meeting", zoneId,
      meetingSessionId: session.meetingSessionId, roomName: session.roomName, reason: "epoch_rotation",
    });
  }

  private bump(sessionId: string) {
    const revision = this.revision(sessionId) + 1;
    this.revisions.set(sessionId, revision);
    return revision;
  }
}
