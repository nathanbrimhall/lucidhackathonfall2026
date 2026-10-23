import { Room, ServerError, type Client } from "@colyseus/core";
import { PROTOCOL_VERSION, type PlayerInput, type ErrorCode, type MediaPreferences } from "../../../shared/src/protocol.js";
import type { OfficeMap } from "../../../shared/src/map-contract.js";
import { joinOfficeSchema, playerInputSchema, playerStatusSchema, mediaPreferencesSchema } from "../../../shared/src/validation.js";
import { AuthError, type AuthService } from "../auth/AuthService.js";
import { movePlayer, SIMULATION_INTERVAL_MS } from "../domain/movement.js";
import { OfficeRegistry, SEAT_RESERVATION_SECONDS } from "./OfficeRegistry.js";
import { OfficeState, Player } from "./schema/OfficeState.js";
import { computeProximity, type ProximityParticipant } from "../domain/proximity.js";
import type { LiveKitService } from "../services/LiveKitService.js";
import { log } from "../log.js";

export const INPUT_TIMEOUT_MS = 250;
export const RECONNECTION_SECONDS = 30;
interface InputState { input?: PlayerInput; receivedAt: number; lastSeq: number; windowStart: number; count: number; rateErrorSent: boolean }
export interface OfficeRoomOptions { reconnectionSeconds?: number; maxClients?: number }

export function createOfficeRoom(auth: AuthService, officeId: string, registry: OfficeRegistry, map: OfficeMap, options: OfficeRoomOptions = {}, media?: LiveKitService) {
  return class OfficeRoom extends Room<{ state: InstanceType<typeof OfficeState> }> {
    maxClients = options.maxClients ?? 20;
    autoDispose = false;
    state = new OfficeState({ officeId, mapId: map.mapId, mapVersion: map.version });
    private readonly pendingInputs = new Map<string, InputState>();
    private stopping = false;
    private readonly preferences = new Map<string, MediaPreferences>();
    private readonly eligible = new Map<string, Set<string>>();
    private policyRevision = 0;
    private readonly mediaRemovals = new Set<Promise<void>>();

    static async onAuth(token: string, payload: unknown) {
      if (!joinOfficeSchema.safeParse(payload).success) throw new ServerError(400, "INVALID_INPUT");
      try { return { identity: auth.authenticate(token), token }; }
      catch (error) {
        throw new ServerError(error instanceof AuthError && error.code === "FORBIDDEN" ? 403 : 401, error instanceof AuthError ? error.code : "UNAUTHORIZED");
      }
    }

    onCreate() {
      this.setPrivate(true);
      this.seatReservationTimeout = SEAT_RESERVATION_SECONDS;
      this.setPatchRate(50);
      this.setSimulationInterval((elapsedMs) => this.simulate(elapsedMs), SIMULATION_INTERVAL_MS);
      this.clock.setInterval(() => this.sendAudioPolicies(), 200);
      this.onMessage("media.preferences", (client, payload) => {
        if (!this.consumeMessage(client)) return;
        const parsed = mediaPreferencesSchema.safeParse(payload);
        if (!parsed.success) { this.error(client, "INVALID_INPUT", "Expected boolean muted and deafened preferences"); return; }
        this.preferences.set(client.sessionId, parsed.data);
      });
      this.onMessage("player.input", (client, payload) => {
        if (!this.consumeMessage(client)) return;
        const parsed = playerInputSchema.safeParse(payload);
        if (!parsed.success) { this.error(client, "INVALID_INPUT", "Expected {seq, dx, dy} with bounded direction and an increasing sequence"); return; }
        const state = this.pendingInputs.get(client.sessionId)!;
        if (parsed.data.seq <= state.lastSeq) return;
        state.lastSeq = parsed.data.seq;
        state.input = parsed.data;
        state.receivedAt = performance.now();
      });
      this.onMessage("player.status", (client, payload) => {
        if (!this.consumeMessage(client)) return;
        const parsed = playerStatusSchema.safeParse(payload);
        if (!parsed.success) { this.error(client, "INVALID_INPUT", "Expected an available, away, or busy status"); return; }
        this.state.players.get(client.sessionId)!.status = parsed.data.status;
      });
      this.onMessage("*", (client) => {
        if (this.consumeMessage(client)) this.error(client, "INVALID_INPUT", "Unknown application message");
      });
    }

    onJoin(client: Client) {
      const identity = this.authorize(client);
      registry.activate(identity.userId, client.sessionId);
      const spawn = map.spawnPoints[this.state.players.size % map.spawnPoints.length];
      this.state.players.set(client.sessionId, new Player({ userId: identity.userId, displayName: identity.displayName, sessionId: client.sessionId, x: spawn.x, y: spawn.y }));
      this.resetInput(client.sessionId);
      this.preferences.set(client.sessionId, { muted: true, deafened: false });
      media?.register(this.roomId, identity.userId, client.sessionId, identity.displayName);
      this.ready(client);
    }

    onDrop(client: Client) {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.connected = false;
      this.pendingInputs.delete(client.sessionId);
      this.removeMedia(client.sessionId);
      if (!this.stopping) this.allowReconnection(client, options.reconnectionSeconds ?? RECONNECTION_SECONDS);
    }

    onReconnect(client: Client) {
      this.authorize(client);
      const player = this.state.players.get(client.sessionId);
      if (!player || this.stopping) throw new ServerError(401, "UNAUTHORIZED");
      registry.activate(player.userId, client.sessionId);
      player.connected = true;
      this.resetInput(client.sessionId, player.lastProcessedInputSeq);
      media?.register(this.roomId, player.userId, client.sessionId, player.displayName);
      this.ready(client);
    }

    onLeave(client: Client) {
      this.removeMedia(client.sessionId);
      this.preferences.delete(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      if (player) registry.release(player.userId, client.sessionId);
      else if (client.auth?.identity) registry.release(client.auth.identity.userId, client.sessionId);
      this.state.players.delete(client.sessionId);
      this.pendingInputs.delete(client.sessionId);
    }

    onBeforeShutdown() {
      this.stopping = true;
      for (const sessionId of this.state.players.keys()) this.removeMedia(sessionId);
      this.pendingInputs.clear(); super.onBeforeShutdown();
    }
    async onDispose() {
      this.pendingInputs.clear(); this.preferences.clear(); this.eligible.clear(); registry.clear();
      await Promise.allSettled(this.mediaRemovals);
      try { await media?.cleanupRoom(this.roomId); } catch { log("media.cleanup.failed"); }
    }

    private removeMedia(sessionId: string) {
      this.eligible.delete(sessionId);
      // unregister invalidates the binding before making the remote API call.
      if (media) {
        const removal = media.unregister(sessionId).catch(() => log("media.remove.failed"));
        this.mediaRemovals.add(removal);
        void removal.finally(() => this.mediaRemovals.delete(removal));
      }
      this.sendAudioPolicies();
    }

    private sendAudioPolicies() {
      if (this.stopping || !media) return;
      const participants: ProximityParticipant[] = [];
      for (const [sessionId, player] of this.state.players) {
        const binding = media.getBinding(sessionId);
        if (!binding) continue;
        participants.push({ sessionId, mediaIdentity: binding.mediaIdentity, x: player.x, y: player.y,
          connected: player.connected, audioMode: player.audioMode === "meeting" ? "meeting" : "floor",
          zoneId: player.zoneId, ...(this.preferences.get(sessionId) ?? { muted: true, deafened: false }) });
      }
      const revision = ++this.policyRevision;
      for (const client of this.clients) {
        const listener = participants.find(p => p.sessionId === client.sessionId);
        if (!listener?.connected) continue;
        const speakers = computeProximity(listener, participants, this.eligible.get(client.sessionId));
        this.eligible.set(client.sessionId, new Set(speakers.map(s => s.mediaIdentity)));
        client.send("audio.policy", { revision, speakers });
      }
    }

    private authorize(client: Client) {
      let identity;
      try { identity = auth.authenticate(client.auth?.token); }
      catch { throw new ServerError(401, "UNAUTHORIZED"); }
      if (identity.officeId !== officeId) throw new ServerError(403, "FORBIDDEN");
      client.auth = { identity, token: client.auth.token };
      return identity;
    }

    private ready(client: Client) {
      client.send("session.ready", { ...client.auth.identity, sessionId: client.sessionId, protocolVersion: PROTOCOL_VERSION });
    }
    private resetInput(sessionId: string, lastSeq = -1) {
      this.pendingInputs.set(sessionId, { receivedAt: 0, lastSeq, windowStart: performance.now(), count: 0, rateErrorSent: false });
    }
    private consumeMessage(client: Client) {
      const state = this.pendingInputs.get(client.sessionId);
      if (this.stopping || !state || !this.state.players.get(client.sessionId)?.connected) return false;
      const now = performance.now();
      if (now - state.windowStart >= 1000) { state.windowStart = now; state.count = 0; state.rateErrorSent = false; }
      if (++state.count <= 60) return true;
      if (!state.rateErrorSent) { this.error(client, "RATE_LIMITED", "At most 60 application messages per second"); state.rateErrorSent = true; }
      return false;
    }
    private simulate(elapsedMs: number) {
      this.state.serverTick++;
      const now = performance.now();
      for (const [sessionId, state] of this.pendingInputs) {
        const player = this.state.players.get(sessionId);
        if (!player?.connected || !state.input) continue;
        if (now - state.receivedAt >= INPUT_TIMEOUT_MS) { state.input = undefined; continue; }
        const input = state.input;
        const next = movePlayer(map, player, input, elapsedMs);
        player.x = next.x; player.y = next.y;
        if (input.dx || input.dy) player.facing = Math.abs(input.dx) > Math.abs(input.dy) ? (input.dx > 0 ? "right" : "left") : (input.dy > 0 ? "down" : "up");
        player.lastProcessedInputSeq = input.seq;
      }
    }
    private error(client: Client, code: ErrorCode, message: string) { client.send("request.error", { code, message }); }
  };
}
