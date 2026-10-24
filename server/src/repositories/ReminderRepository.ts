import { randomUUID } from "node:crypto";
import type { NoteRecord, ReminderDue, ReminderRecord } from "../../../shared/src/protocol.js";
import type { Storage } from "./Storage.js";

interface JsonRecord { record: string }
interface RequestRecord { fingerprint: string; response: string }
export interface ReminderNotification { state: "pending" | "acknowledged" | "invalidated"; revision: number; reminder: ReminderRecord }

/** All scheduler claims and mutations run on the application's single SQLite connection. */
export class ReminderRepository {
  constructor(private readonly storage: Storage) {}
  transaction<T>(fn: () => T): T { return this.storage.db.transaction(fn).immediate(); }
  hasMembership(userId: string, officeId: string): boolean { return this.storage.hasMembership(userId, officeId); }

  get(userId: string, officeId: string, id: string): ReminderRecord | undefined {
    const row = this.storage.db.prepare("SELECT record FROM reminders WHERE id=? AND user_id=? AND office_id=?").get(id, userId, officeId) as JsonRecord | undefined;
    return row && JSON.parse(row.record);
  }
  list(userId: string, officeId: string, before?: string): ReminderRecord[] {
    const cursor = before ? this.get(userId, officeId, before) : undefined;
    // Service validates/scopes cursors; retain the scope here for every direct repository read.
    if (before && !cursor) return [];
    const rows = cursor
      ? this.storage.db.prepare("SELECT record FROM reminders WHERE user_id=? AND office_id=? AND (due_at,id)<(?,?) ORDER BY due_at DESC,id DESC LIMIT 100").all(userId, officeId, Date.parse(cursor.dueAt), cursor.id)
      : this.storage.db.prepare("SELECT record FROM reminders WHERE user_id=? AND office_id=? ORDER BY due_at DESC,id DESC LIMIT 100").all(userId, officeId);
    return (rows as JsonRecord[]).map(row => JSON.parse(row.record));
  }
  save(userId: string, officeId: string, reminder: ReminderRecord): void {
    this.storage.db.prepare(`INSERT INTO reminders (id,user_id,office_id,due_at,status,revision,record) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET due_at=excluded.due_at,status=excluded.status,revision=excluded.revision,record=excluded.record`)
      .run(reminder.id, userId, officeId, Date.parse(reminder.dueAt), reminder.status, reminder.revision, JSON.stringify(reminder));
  }
  request(userId: string, officeId: string, requestId: string): RequestRecord | undefined {
    return this.storage.db.prepare("SELECT fingerprint,response FROM reminder_requests WHERE user_id=? AND office_id=? AND request_id=?").get(userId, officeId, requestId) as RequestRecord | undefined;
  }
  saveRequest(userId: string, officeId: string, requestId: string, fingerprint: string, response: ReminderRecord): void {
    this.storage.db.prepare("INSERT INTO reminder_requests (user_id,office_id,request_id,fingerprint,response) VALUES (?,?,?,?,?)").run(userId, officeId, requestId, fingerprint, JSON.stringify(response));
  }
  sourceNote(userId: string, officeId: string, id: string): NoteRecord | undefined {
    const row = this.storage.db.prepare(`SELECT notes.record FROM notes
      JOIN note_readers ON note_readers.note_id=notes.id
      JOIN ai_sessions ON ai_sessions.id=notes.ai_session_id
      WHERE notes.id=? AND note_readers.user_id=? AND ai_sessions.office_id=?`).get(id, userId, officeId) as JsonRecord | undefined;
    return row && JSON.parse(row.record);
  }
  invalidate(id: string): void {
    this.storage.db.prepare("UPDATE notification_outbox SET state='invalidated' WHERE reminder_id=? AND state='pending'").run(id);
  }

  /** No external work occurs in this transaction: process death rolls the entire claim back. */
  claimDue(now: number): void {
    this.transaction(() => {
      const rows = this.storage.db.prepare("SELECT id,user_id AS userId,office_id AS officeId,record FROM reminders WHERE status='scheduled' AND due_at<=? ORDER BY due_at,id LIMIT 100").all(now) as (JsonRecord & { id: string; userId: string; officeId: string })[];
      for (const row of rows) {
        const reminder: ReminderRecord = JSON.parse(row.record);
        reminder.status = "due"; reminder.revision++; reminder.updatedAt = new Date(now).toISOString();
        this.save(row.userId, row.officeId, reminder);
        this.storage.db.prepare("INSERT INTO notification_outbox (id,reminder_id,revision,state,created_at) VALUES (?,?,?,'pending',?)").run(randomUUID(), reminder.id, reminder.revision, now);
      }
    });
  }
  pending(userId: string, officeId: string): ReminderDue[] {
    return (this.storage.db.prepare(`SELECT notification_outbox.id AS notificationId,reminders.record FROM notification_outbox
      JOIN reminders ON reminders.id=notification_outbox.reminder_id
      WHERE reminders.user_id=? AND reminders.office_id=? AND reminders.status='due'
      AND notification_outbox.state='pending' AND notification_outbox.revision=reminders.revision
      ORDER BY notification_outbox.created_at,notification_outbox.id LIMIT 100`).all(userId, officeId) as (JsonRecord & { notificationId: string })[])
      .map(row => ({ notificationId: row.notificationId, reminder: JSON.parse(row.record) }));
  }
  notification(userId: string, officeId: string, id: string): ReminderNotification | undefined {
    const row = this.storage.db.prepare(`SELECT notification_outbox.state,notification_outbox.revision,reminders.record FROM notification_outbox
      JOIN reminders ON reminders.id=notification_outbox.reminder_id
      WHERE notification_outbox.id=? AND reminders.user_id=? AND reminders.office_id=?`).get(id, userId, officeId) as (JsonRecord & Omit<ReminderNotification, "reminder">) | undefined;
    return row && { state: row.state, revision: row.revision, reminder: JSON.parse(row.record) };
  }
  acknowledge(id: string): void { this.storage.db.prepare("UPDATE notification_outbox SET state='acknowledged' WHERE id=? AND state='pending'").run(id); }
}
