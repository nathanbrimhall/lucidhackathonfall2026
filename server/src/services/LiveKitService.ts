import { randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver, type WebhookEvent } from "livekit-server-sdk";
import type { Config } from "../config.js";
import type { AudioMode, MediaCredentials } from "../../../shared/src/protocol.js";

export type MediaErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "UNAVAILABLE" | "INVALID_INPUT" | "STALE_TRANSITION" | "TRANSITION_PENDING";
export class MediaError extends Error {
  constructor(public readonly code: MediaErrorCode) {
    super(code);
    this.name = "MediaError";
  }
}

export interface MediaBinding {
  readonly roomId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly mediaIdentity: string;
  /** The only media room this seat may currently join: the floor or the current meeting epoch. */
  roomName: string;
  mode: AudioMode;
  zoneId: string;
  meetingSessionId?: string;
  transitionRevision: number;
  /** Set by a transition until destination credentials are issued. */
  pending: boolean;
  acked: boolean;
  participantSid?: string;
  participantJoinedAt?: bigint;
}

/** A server-derived destination; meeting rooms come from the meeting state machine. */
export interface MediaTarget { revision: number; mode: AudioMode; zoneId: string; meetingSessionId?: string; roomName?: string }

export interface LiveKitBackend {
  issueToken(binding: Readonly<MediaBinding>): Promise<string>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  verifyWebhook(rawBody: string, authorization?: string): Promise<WebhookEvent>;
  listRooms?(): Promise<string[]>;
  listParticipants?(roomName: string): Promise<string[]>;
}

/** Rooms with an issued token (needing removal) stay off the public binding copy. */
interface Seat extends MediaBinding { issued: Set<string>; stale: Set<string>; removals: Map<string, Promise<void>> }

type MediaConfig = Pick<Config, "livekitApiKey" | "livekitApiSecret" | "livekitInternalUrl" | "livekitPublicUrl">;
const TOKEN_TTL_SECONDS = 60;
const EVENT_TTL_MS = 5 * 60_000;
const MAX_EVENTS = 2048;
const MANAGED_ROOM = /^(floor|meet)_/;

function absent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "not_found";
}

function createBackend(config: MediaConfig): LiveKitBackend {
  const rooms = new RoomServiceClient(config.livekitInternalUrl, config.livekitApiKey, config.livekitApiSecret, { requestTimeout: 1.5, failover: false });
  const receiver = new WebhookReceiver(config.livekitApiKey, config.livekitApiSecret);
  return {
    async issueToken(binding) {
      const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
        identity: binding.mediaIdentity, name: binding.displayName, ttl: TOKEN_TTL_SECONDS,
      });
      token.addGrant({
        roomJoin: true, room: binding.roomName, canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true,
        canPublishData: false, canUpdateOwnMetadata: false,
      });
      return token.toJwt();
    },
    async removeParticipant(room, identity) {
      try { await rooms.removeParticipant(room, identity); }
      catch (error) { if (!absent(error)) throw error; }
    },
    async deleteRoom(room) {
      try { await rooms.deleteRoom(room); }
      catch (error) { if (!absent(error)) throw error; }
    },
    verifyWebhook: (body, authorization) => receiver.receive(body, authorization),
    listRooms: async () => (await rooms.listRooms()).map((room) => room.name),
    async listParticipants(room) {
      try { return (await rooms.listParticipants(room)).map((participant) => participant.identity); }
      catch (error) { if (absent(error)) return []; throw error; }
    },
  };
}

function project({ issued: _issued, stale: _stale, removals: _removals, ...binding }: Seat): MediaBinding {
  return binding;
}

/** Colyseus connection bindings are the authority; media webhooks never grant access.
 * Public floor tokens may be replayed until expiry on self-hosted LiveKit. Meeting
 * privacy relies on epoch rotation: a departure retires the meeting's media room,
 * so earlier tokens can only reach a room no current occupant is bound to.
 */
export class LiveKitService {
  private readonly bindings = new Map<string, Seat>();
  private readonly identities = new Map<string, Seat>();
  private readonly roomNames = new Map<string, string>();
  /** Current meeting epoch rooms by name, with their Colyseus room for cleanup. */
  private readonly meetingRooms = new Map<string, string>();
  /** Retired meeting rooms whose deletion has not yet succeeded; cleanup retries them. */
  private readonly retiredRooms = new Map<string, string>();
  private readonly issuedRooms = new Set<string>();
  private readonly events = new Map<string, number>();
  private readonly backend: LiveKitBackend;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly config: MediaConfig, options: { backend?: LiveKitBackend; now?: () => number } = {}) {
    this.backend = options.backend ?? createBackend(config);
    this.now = options.now ?? Date.now;
  }

  register(roomId: string, userId: string, sessionId: string, displayName: string, revision = 0): string {
    if (this.disposed) throw new MediaError("UNAVAILABLE");
    if ([roomId, userId, sessionId, displayName].some((value) => typeof value !== "string" || !value || value.length > 256)
      || !Number.isSafeInteger(revision) || revision < 0) {
      throw new MediaError("INVALID_INPUT");
    }
    const existing = this.bindings.get(sessionId);
    if (existing) {
      if (existing.userId !== userId || existing.roomId !== roomId) throw new MediaError("FORBIDDEN");
      return existing.mediaIdentity;
    }
    if ([...this.bindings.values()].some((binding) => binding.userId === userId)) throw new MediaError("FORBIDDEN");
    let roomName = this.roomNames.get(roomId);
    if (!roomName) { roomName = `floor_${randomUUID()}`; this.roomNames.set(roomId, roomName); }
    const seat: Seat = {
      roomId, userId, sessionId, displayName, mediaIdentity: `seat_${randomUUID()}`, roomName, mode: "floor", zoneId: "",
      transitionRevision: revision, pending: false, acked: false, issued: new Set(), stale: new Set(), removals: new Map(),
    };
    this.bindings.set(sessionId, seat);
    this.identities.set(seat.mediaIdentity, seat);
    return seat.mediaIdentity;
  }

  getBinding(sessionId: string): Readonly<MediaBinding> | undefined {
    const seat = this.bindings.get(sessionId);
    return seat ? project(seat) : undefined;
  }

  /**
   * Repoints the seat synchronously, so no credential for the previous room can be
   * minted after this returns, and starts removing the identity from any room it
   * holds a token for. Lower or equal revisions are ignored.
   */
  transition(sessionId: string, target: MediaTarget): void {
    const seat = this.bindings.get(sessionId);
    if (!seat || this.disposed || !Number.isSafeInteger(target.revision) || target.revision <= seat.transitionRevision) return;
    const roomName = target.mode === "meeting" ? target.roomName : this.roomNames.get(seat.roomId);
    if (!roomName || (target.mode === "meeting") !== roomName.startsWith("meet_")) throw new MediaError("INVALID_INPUT");
    if (target.mode === "meeting") this.meetingRooms.set(roomName, seat.roomId);
    for (const room of seat.issued) seat.stale.add(room);
    seat.issued.clear();
    Object.assign(seat, {
      roomName, mode: target.mode, zoneId: target.zoneId, meetingSessionId: target.meetingSessionId,
      transitionRevision: target.revision, pending: true, acked: false, participantSid: undefined,
    });
    void this.removeStale(seat);
  }

  /** Stale or future revisions are ignored. */
  acknowledge(sessionId: string, revision: number): boolean {
    const seat = this.bindings.get(sessionId);
    if (!seat?.pending || seat.transitionRevision !== revision) return false;
    seat.acked = true;
    return true;
  }

  async issueToken(userId: string, sessionId: string, transitionRevision?: number): Promise<MediaCredentials> {
    if (this.disposed) throw new MediaError("UNAVAILABLE");
    const seat = this.bindings.get(sessionId);
    if (!seat) throw new MediaError("FORBIDDEN");
    if (seat.userId !== userId) throw new MediaError("FORBIDDEN");
    const revision = seat.transitionRevision;
    if (transitionRevision !== undefined && transitionRevision !== revision) throw new MediaError("STALE_TRANSITION");
    if (seat.pending) {
      if (transitionRevision === undefined || !seat.acked) throw new MediaError("TRANSITION_PENDING");
      if (seat.stale.size) {
        await this.removeStale(seat);
        this.recheck(seat, revision);
        // Failed removal keeps the seat pending (and muted client-side); a later request retries.
        if (seat.stale.size) throw new MediaError("UNAVAILABLE");
      }
    }
    const expiresAt = new Date((Math.floor(this.now() / 1000) + TOKEN_TTL_SECONDS) * 1000).toISOString();
    let token: string;
    try { token = await this.backend.issueToken(project(seat)); }
    catch { throw new MediaError("UNAVAILABLE"); }
    // Signing is asynchronous: a drop/reconnect or transition can invalidate this seat meanwhile.
    this.recheck(seat, revision);
    seat.pending = false;
    seat.issued.add(seat.roomName);
    this.issuedRooms.add(seat.roomName);
    return {
      url: this.config.livekitPublicUrl, token, mediaIdentity: seat.mediaIdentity, roomName: seat.roomName, expiresAt,
      transitionRevision: revision, mode: seat.mode, zoneId: seat.zoneId,
      ...(seat.meetingSessionId ? { meetingSessionId: seat.meetingSessionId } : {}),
    };
  }

  async unregister(sessionId: string): Promise<void> {
    const seat = this.bindings.get(sessionId);
    if (!seat) return;
    this.bindings.delete(sessionId);
    this.identities.delete(seat.mediaIdentity);
    const rooms = new Set([...seat.issued, ...seat.stale]);
    seat.issued.clear(); seat.stale.clear();
    const results = await Promise.allSettled([...rooms].map((room) => this.backend.removeParticipant(room, seat.mediaIdentity)));
    if (results.some((result) => result.status === "rejected")) throw new MediaError("UNAVAILABLE");
  }

  /** Deletes a retired epoch or ended meeting room; LiveKit disconnects anyone still in it. */
  async retireRoom(roomName: string): Promise<void> {
    if (!roomName.startsWith("meet_")) throw new MediaError("INVALID_INPUT");
    const owner = this.meetingRooms.get(roomName) ?? this.retiredRooms.get(roomName) ?? "";
    this.meetingRooms.delete(roomName);
    this.retiredRooms.set(roomName, owner);
    try { await this.backend.deleteRoom(roomName); }
    catch { throw new MediaError("UNAVAILABLE"); }
    this.retiredRooms.delete(roomName);
    this.issuedRooms.delete(roomName);
  }

  async verifyWebhook(rawBody: string, authorization?: string): Promise<WebhookEvent> {
    if (!authorization) throw new MediaError("UNAUTHORIZED");
    try { return await this.backend.verifyWebhook(rawBody, authorization); }
    catch { throw new MediaError("UNAUTHORIZED"); }
  }

  async handleWebhook(event: WebhookEvent): Promise<void> {
    const now = this.now();
    for (const [id, expires] of this.events) if (expires <= now) this.events.delete(id);
    if (event.id && this.events.has(event.id)) return;
    const participant = event.participant;
    const roomName = event.room?.name;
    if (participant && roomName) {
      const binding = this.identities.get(participant.identity);
      if (event.event === "participant_joined" || event.event === "track_published") {
        // Retired epochs are never a binding's room, so replayed tokens are evicted here too.
        if (binding && binding.roomName !== roomName && !this.disposed) {
          // Track the eviction as a pending removal so the seat cannot be issued (and
          // legitimately rejoin) this room until the identity-based removal has landed.
          binding.stale.add(roomName);
          await this.removeStale(binding);
          if (binding.stale.has(roomName)) throw new MediaError("UNAVAILABLE");
        } else if (!binding || binding.roomName !== roomName || this.disposed) {
          try { await this.backend.removeParticipant(roomName, participant.identity); }
          catch { throw new MediaError("UNAVAILABLE"); }
        } else if (event.event === "participant_joined" && participant.sid) {
          // Joined-at timestamps prevent out-of-order joins from replacing a newer SID.
          const joinedAt = participant.joinedAtMs || participant.joinedAt * 1000n;
          if (binding.participantJoinedAt === undefined || joinedAt >= binding.participantJoinedAt) {
            binding.participantSid = participant.sid;
            binding.participantJoinedAt = joinedAt;
          }
        }
      } else if ((event.event === "participant_left" || event.event === "participant_connection_aborted") &&
        binding?.roomName === roomName && binding.participantSid === participant.sid) {
        binding.participantSid = undefined;
        // Keep joined-at ordering and the Colyseus binding: media disconnect is not office exit.
      }
    }
    if (event.id) {
      this.events.set(event.id, now + EVENT_TTL_MS);
      while (this.events.size > MAX_EVENTS) this.events.delete(this.events.keys().next().value!);
    }
  }

  /**
   * Best-effort repair against missed webhooks or failed removals: deletes managed
   * rooms that are not a current floor or meeting epoch and removes participants
   * not bound to the room they are in. Rechecks state after every await.
   */
  async reconcile(): Promise<void> {
    if (this.disposed || !this.backend.listRooms || !this.backend.listParticipants) return;
    const rooms = await this.backend.listRooms();
    const results = await Promise.allSettled(rooms.filter((room) => MANAGED_ROOM.test(room)).map(async (room) => {
      if (!this.isCurrent(room)) {
        if (this.disposed) return;
        await this.backend.deleteRoom(room);
        this.retiredRooms.delete(room);
        return;
      }
      for (const identity of await this.backend.listParticipants!(room)) {
        if (this.disposed) return;
        if (this.identities.get(identity)?.roomName !== room) await this.backend.removeParticipant(room, identity);
      }
    }));
    if (results.some((result) => result.status === "rejected")) throw new MediaError("UNAVAILABLE");
  }

  async cleanupRoom(roomId: string): Promise<void> {
    const roomName = this.roomNames.get(roomId);
    this.roomNames.delete(roomId);
    const meetings = [...this.meetingRooms, ...this.retiredRooms].filter(([, owner]) => owner === roomId).map(([name]) => name);
    const removals = [...this.bindings.values()].filter((binding) => binding.roomId === roomId).map((binding) => this.unregister(binding.sessionId));
    const results = await Promise.allSettled(removals);
    const deletions = await Promise.allSettled([
      ...(roomName && this.issuedRooms.delete(roomName) ? [this.backend.deleteRoom(roomName)] : []),
      ...meetings.map((name) => this.retireRoom(name)),
    ]);
    if ([...results, ...deletions].some((result) => result.status === "rejected")) throw new MediaError("UNAVAILABLE");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const roomIds = new Set([...this.roomNames.keys(), ...this.meetingRooms.values(), ...this.retiredRooms.values()]);
    const results = await Promise.allSettled([...roomIds].map((room) => this.cleanupRoom(room)));
    this.events.clear();
    if (results.some((result) => result.status === "rejected")) throw new MediaError("UNAVAILABLE");
  }

  private isCurrent(room: string): boolean {
    return this.meetingRooms.has(room) || [...this.roomNames.values()].includes(room);
  }

  private recheck(seat: Seat, revision: number) {
    if (this.disposed || this.bindings.get(seat.sessionId) !== seat) throw new MediaError("FORBIDDEN");
    if (seat.transitionRevision !== revision) throw new MediaError("STALE_TRANSITION");
  }

  private removeStale(seat: Seat): Promise<unknown> {
    for (const room of seat.stale) {
      if (seat.removals.has(room)) continue;
      const removal = this.backend.removeParticipant(room, seat.mediaIdentity)
        .then(() => { seat.stale.delete(room); }, () => {})
        .finally(() => seat.removals.delete(room));
      seat.removals.set(room, removal);
    }
    return Promise.all(seat.removals.values());
  }
}
