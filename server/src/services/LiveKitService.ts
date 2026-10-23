import { randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver, type WebhookEvent } from "livekit-server-sdk";
import type { Config } from "../config.js";
import type { MediaCredentials } from "../../../shared/src/protocol.js";

export class MediaError extends Error {
  constructor(public readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "UNAVAILABLE" | "INVALID_INPUT") {
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
  readonly roomName: string;
  participantSid?: string;
  participantJoinedAt?: bigint;
}

export interface LiveKitBackend {
  issueToken(binding: Readonly<MediaBinding>): Promise<string>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  verifyWebhook(rawBody: string, authorization?: string): Promise<WebhookEvent>;
}

type MediaConfig = Pick<Config, "livekitApiKey" | "livekitApiSecret" | "livekitInternalUrl" | "livekitPublicUrl">;
const TOKEN_TTL_SECONDS = 60;
const EVENT_TTL_MS = 5 * 60_000;
const MAX_EVENTS = 2048;

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
  };
}

/** Colyseus connection bindings are the authority; media webhooks never grant access.
 * Public floor tokens may be replayed until expiry on self-hosted LiveKit. Removal
 * and webhook eviction are best effort; meeting privacy requires M3 epoch rotation.
 */
export class LiveKitService {
  private readonly bindings = new Map<string, MediaBinding>();
  private readonly identities = new Map<string, MediaBinding>();
  private readonly roomNames = new Map<string, string>();
  private readonly issuedIdentities = new Set<string>();
  private readonly issuedRooms = new Set<string>();
  private readonly events = new Map<string, number>();
  private readonly backend: LiveKitBackend;
  private readonly now: () => number;
  private disposed = false;

  constructor(private readonly config: MediaConfig, options: { backend?: LiveKitBackend; now?: () => number } = {}) {
    this.backend = options.backend ?? createBackend(config);
    this.now = options.now ?? Date.now;
  }

  register(roomId: string, userId: string, sessionId: string, displayName: string): string {
    if (this.disposed) throw new MediaError("UNAVAILABLE");
    if ([roomId, userId, sessionId, displayName].some((value) => typeof value !== "string" || !value || value.length > 256)) {
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
    const binding: MediaBinding = { roomId, userId, sessionId, displayName, mediaIdentity: `seat_${randomUUID()}`, roomName };
    this.bindings.set(sessionId, binding);
    this.identities.set(binding.mediaIdentity, binding);
    return binding.mediaIdentity;
  }

  getBinding(sessionId: string): Readonly<MediaBinding> | undefined {
    const binding = this.bindings.get(sessionId);
    return binding ? { ...binding } : undefined;
  }

  async issueToken(userId: string, sessionId: string): Promise<MediaCredentials> {
    if (this.disposed) throw new MediaError("UNAVAILABLE");
    const binding = this.bindings.get(sessionId);
    if (!binding) throw new MediaError("FORBIDDEN");
    if (binding.userId !== userId) throw new MediaError("FORBIDDEN");
    const expiresAt = new Date((Math.floor(this.now() / 1000) + TOKEN_TTL_SECONDS) * 1000).toISOString();
    let token: string;
    try { token = await this.backend.issueToken({ ...binding }); }
    catch { throw new MediaError("UNAVAILABLE"); }
    // Signing is asynchronous: a drop/reconnect can invalidate this seat meanwhile.
    if (this.disposed || this.bindings.get(sessionId) !== binding) throw new MediaError("FORBIDDEN");
    this.issuedIdentities.add(binding.mediaIdentity);
    this.issuedRooms.add(binding.roomName);
    return { url: this.config.livekitPublicUrl, token, mediaIdentity: binding.mediaIdentity, roomName: binding.roomName, expiresAt };
  }

  async unregister(sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId);
    if (!binding) return;
    this.bindings.delete(sessionId);
    this.identities.delete(binding.mediaIdentity);
    if (!this.issuedIdentities.delete(binding.mediaIdentity)) return;
    try { await this.backend.removeParticipant(binding.roomName, binding.mediaIdentity); }
    catch { throw new MediaError("UNAVAILABLE"); }
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
        if (!binding || binding.roomName !== roomName || this.disposed) {
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

  async cleanupRoom(roomId: string): Promise<void> {
    const roomName = this.roomNames.get(roomId);
    this.roomNames.delete(roomId);
    const removals = [...this.bindings.values()].filter((binding) => binding.roomId === roomId).map((binding) => this.unregister(binding.sessionId));
    const results = await Promise.allSettled(removals);
    if (roomName && this.issuedRooms.delete(roomName)) {
      try { await this.backend.deleteRoom(roomName); }
      catch { throw new MediaError("UNAVAILABLE"); }
    }
    if (results.some((result) => result.status === "rejected")) throw new MediaError("UNAVAILABLE");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const results = await Promise.allSettled([...this.roomNames.keys()].map((room) => this.cleanupRoom(room)));
    this.events.clear();
    if (results.some((result) => result.status === "rejected")) throw new MediaError("UNAVAILABLE");
  }
}
