import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CreateReminderRequest, ErrorCode, PatchReminderRequest, ReminderDue, ReminderRecord } from "../../../shared/src/protocol.js";
import { createReminderSchema, patchReminderSchema, reminderAckSchema } from "../../../shared/src/validation.js";
import { ReminderRepository } from "../repositories/ReminderRepository.js";
import { log } from "../log.js";

export class ReminderError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) { super(message); }
}
interface Connection { userId: string; officeId: string; send: (payload: ReminderDue) => void; delivered: Map<string, number> }

export class ReminderService {
  private readonly connections = new Map<string, Connection>();
  constructor(readonly repo: ReminderRepository) {}

  create(userId: string, officeId: string, payload: CreateReminderRequest): ReminderRecord {
    this.requireMembership(userId, officeId);
    const parsed = createReminderSchema.safeParse(payload);
    if (!parsed.success) throw new ReminderError("INVALID_INPUT", "Invalid reminder; supply text, explicit due time and IANA timezone");
    const data = parsed.data;
    return this.mutate(userId, officeId, data.requestId, ["create", data], () => {
      if (data.source) {
        const note = this.repo.sourceNote(userId, officeId, data.source.noteId);
        if (!note) throw new ReminderError("NOT_FOUND");
        const item = note.draft.actionItems[data.source.actionItemIndex];
        if (!item) throw new ReminderError("INVALID_INPUT", "Unknown action item");
        if (item.ownerUserId && item.ownerUserId !== userId) throw new ReminderError("FORBIDDEN", "Only confirm your own or unassigned action items");
      }
      const now = new Date().toISOString();
      const reminder: ReminderRecord = {
        id: randomUUID(), text: data.text, dueAt: data.dueAt, timezone: data.timezone,
        status: "scheduled", revision: 1, createdAt: now, updatedAt: now,
        ...(data.source ? { source: data.source } : {}),
      };
      this.repo.save(userId, officeId, reminder);
      return reminder;
    });
  }

  update(userId: string, officeId: string, id: string, payload: PatchReminderRequest): ReminderRecord {
    this.requireMembership(userId, officeId);
    const parsed = patchReminderSchema.safeParse(payload);
    if (!parsed.success) throw new ReminderError("INVALID_INPUT", "Invalid reminder change");
    const data = parsed.data;
    return this.mutate(userId, officeId, data.requestId, ["update", id, data], () => {
      const reminder = this.repo.get(userId, officeId, id);
      if (!reminder) throw new ReminderError("NOT_FOUND");
      if (reminder.revision !== data.revision) throw new ReminderError("CONFLICT", "Reminder changed; reload its current revision");
      if (reminder.status === "canceled" || reminder.status === "acknowledged") throw new ReminderError("CONFLICT", "Reminder is already finished");
      if (data.status !== "canceled" && !(["text", "dueAt", "timezone"] as const).some(key => data[key] !== undefined && data[key] !== reminder[key])) {
        throw new ReminderError("INVALID_INPUT", "Provide a meaningful reminder change");
      }
      for (const key of ["text", "dueAt", "timezone"] as const) if (data[key] !== undefined) reminder[key] = data[key];
      reminder.status = data.status ?? "scheduled";
      reminder.revision++; reminder.updatedAt = new Date().toISOString();
      this.repo.invalidate(id);
      this.repo.save(userId, officeId, reminder);
      return reminder;
    });
  }

  list(userId: string, officeId: string, before?: string): ReminderRecord[] {
    this.requireMembership(userId, officeId);
    if (before !== undefined) {
      if (!z.string().uuid().safeParse(before).success) throw new ReminderError("INVALID_INPUT", "Expected a reminder UUID cursor");
      if (!this.repo.get(userId, officeId, before)) throw new ReminderError("NOT_FOUND");
    }
    return this.repo.list(userId, officeId, before);
  }

  acknowledge(userId: string, officeId: string, notificationId: string): ReminderRecord {
    // An ack must not disclose whether a notification belongs to another office or owner.
    if (!this.repo.hasMembership(userId, officeId)) throw new ReminderError("NOT_FOUND");
    if (!reminderAckSchema.safeParse({ notificationId }).success) throw new ReminderError("INVALID_INPUT");
    return this.repo.transaction(() => {
      const notification = this.repo.notification(userId, officeId, notificationId);
      if (!notification || notification.state === "invalidated") throw new ReminderError("NOT_FOUND");
      if (notification.state === "acknowledged") return notification.reminder;
      const reminder = notification.reminder;
      if (reminder.status !== "due" || reminder.revision !== notification.revision) throw new ReminderError("NOT_FOUND");
      reminder.status = "acknowledged"; reminder.revision++; reminder.updatedAt = new Date().toISOString();
      this.repo.acknowledge(notificationId);
      this.repo.save(userId, officeId, reminder);
      return reminder;
    });
  }

  register(connectionId: string, userId: string, officeId: string, send: (payload: ReminderDue) => void): void {
    this.requireMembership(userId, officeId);
    const connection: Connection = { userId, officeId, send, delivered: new Map() };
    this.connections.set(connectionId, connection);
    // Catch up immediately even when the owner reconnects before the next scheduler tick.
    this.repo.claimDue(Date.now());
    this.deliver(connection, Date.now());
  }
  unregister(connectionId: string): void { this.connections.delete(connectionId); }
  tick(now = Date.now()): void {
    this.repo.claimDue(now);
    for (const [id, connection] of this.connections) {
      if (!this.repo.hasMembership(connection.userId, connection.officeId)) { this.unregister(id); continue; }
      this.deliver(connection, now);
    }
  }
  shutdown(): void { this.connections.clear(); }

  private deliver(connection: Connection, now: number): void {
    const pending = this.repo.pending(connection.userId, connection.officeId);
    const ids = new Set(pending.map(payload => payload.notificationId));
    for (const id of connection.delivered.keys()) if (!ids.has(id)) connection.delivered.delete(id);
    for (const payload of pending) {
      const previous = connection.delivered.get(payload.notificationId);
      if (previous !== undefined && now - previous < 5000) continue;
      connection.delivered.set(payload.notificationId, now);
      try { connection.send(payload); } catch { log("reminder.delivery.failed"); }
    }
  }
  private requireMembership(userId: string, officeId: string): void {
    if (!this.repo.hasMembership(userId, officeId)) throw new ReminderError("FORBIDDEN", "Office membership required");
  }
  private mutate(userId: string, officeId: string, requestId: string, input: unknown, operation: () => ReminderRecord): ReminderRecord {
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.repo.transaction(() => {
      const previous = this.repo.request(userId, officeId, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ReminderError("CONFLICT", "Request ID already used for a different mutation");
        return JSON.parse(previous.response) as ReminderRecord;
      }
      const reminder = operation();
      this.repo.saveRequest(userId, officeId, requestId, fingerprint, reminder);
      return reminder;
    });
  }
}
