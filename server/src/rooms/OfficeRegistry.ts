import { matchMaker, type AuthContext } from "@colyseus/core";
import { OFFICE_ROOM, type JoinOfficeRequest } from "../../../shared/src/protocol.js";

export const SEAT_RESERVATION_SECONDS = 15;
export class OfficeJoinError extends Error {
  constructor(public readonly code: "DUPLICATE_CONNECTION" | "ROOM_FULL", message: string) { super(message); }
}

/** One process owns one canonical office, including pending and reconnecting seats. */
export class OfficeRegistry {
  private roomId?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly claims = new Map<string, { sessionId: string; expires: number; joined: boolean }>();

  reserve(userId: string, options: JoinOfficeRequest, context: AuthContext) {
    const result = this.queue.then(async () => {
      for (const [id, pending] of this.claims) {
        if (!pending.joined && pending.expires <= Date.now()) this.claims.delete(id);
      }
      const claim = this.claims.get(userId);
      if (claim && (claim.joined || claim.expires > Date.now())) {
        throw new OfficeJoinError("DUPLICATE_CONNECTION", "This guest already has a seat; reconnect or leave the other connection");
      }
      this.claims.delete(userId);
      if (!this.roomId) this.roomId = (await matchMaker.createRoom(OFFICE_ROOM, {})).roomId;
      const listing = (await matchMaker.findRoomsByIds([this.roomId])).get(this.roomId);
      if (!listing || listing.locked || listing.clients >= listing.maxClients) {
        throw new OfficeJoinError("ROOM_FULL", "The office is full; try again after someone leaves");
      }
      // joinById never creates an overflow room when the canonical office fills.
      const seat = await matchMaker.joinById(this.roomId, options, context);
      this.claims.set(userId, { sessionId: seat.sessionId, expires: Date.now() + SEAT_RESERVATION_SECONDS * 1000, joined: false });
      return seat;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  activate(userId: string, sessionId: string) {
    const claim = this.claims.get(userId);
    if (!claim || claim.sessionId !== sessionId || (!claim.joined && claim.expires <= Date.now())) {
      throw new OfficeJoinError("DUPLICATE_CONNECTION", "The guest seat is no longer valid");
    }
    claim.joined = true;
  }

  release(userId: string, sessionId: string) {
    if (this.claims.get(userId)?.sessionId === sessionId) this.claims.delete(userId);
  }
  clear() { this.claims.clear(); this.roomId = undefined; }
}
