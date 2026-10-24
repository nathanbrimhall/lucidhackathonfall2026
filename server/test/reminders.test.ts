import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateReminderRequest, NoteRecord, ReminderDue } from "../../shared/src/protocol.js";
import { createReminderSchema, patchReminderSchema, reminderAckSchema } from "../../shared/src/validation.js";
import { AIRepository } from "../src/repositories/AIRepository.js";
import { ReminderRepository } from "../src/repositories/ReminderRepository.js";
import { openStorage, type Storage } from "../src/repositories/Storage.js";
import { ReminderError, ReminderService } from "../src/services/ReminderService.js";

let storage: Storage, repo: ReminderRepository, service: ReminderService;
let directory: string, databasePath: string, ada: string, grace: string;
const office = "demo-office";
const input = (overrides: Partial<CreateReminderRequest> = {}): CreateReminderRequest => ({
  requestId: randomUUID(), text: "Send the design", dueAt: "2026-10-24T08:00:00-06:00", timezone: "America/Denver", ...overrides,
});
const create = (overrides: Partial<CreateReminderRequest> = {}) => service.create(ada, office, input(overrides));
const due = () => create({ dueAt: "2026-10-24T11:00:00Z" });
function expectCode(action: () => unknown, code: string) {
  try { action(); throw new Error("Expected reminder error"); }
  catch (error) { expect(error).toBeInstanceOf(ReminderError); expect((error as ReminderError).code).toBe(code); }
}
function restart() {
  service.shutdown(); storage.close(); storage = openStorage(databasePath);
  repo = new ReminderRepository(storage); service = new ReminderService(repo);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "office-reminders-")); databasePath = join(directory, "office.sqlite");
  storage = openStorage(databasePath); repo = new ReminderRepository(storage); service = new ReminderService(repo);
  ada = storage.createGuest("Ada", office).userId; grace = storage.createGuest("Grace", office).userId;
});
afterEach(() => { service.shutdown(); storage.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

describe("M5 explicit and validated reminders", () => {
  it("normalizes an explicit offset to UTC, retains IANA timezone, and trims text", () => {
    expect(create({ text: "  Send the design  " })).toMatchObject({ text: "Send the design", dueAt: "2026-10-24T14:00:00.000Z", timezone: "America/Denver", status: "scheduled", revision: 1 });
    const dst = create({ dueAt: "2026-11-01T01:30:00-07:00" });
    expect(dst.dueAt).toBe("2026-11-01T08:30:00.000Z");
    expect(service.list(ada, office)).toHaveLength(2);
    expect(service.list(grace, office)).toEqual([]);
  });
  it("rejects ambiguous dates, invalid zones, forged ownership, invalid changes and malformed acks", () => {
    for (const bad of [
      input({ dueAt: "tomorrow" }), input({ dueAt: "2026-10-24T08:00:00" }), input({ dueAt: "2026-02-30T08:00:00Z" }),
      input({ timezone: "Mars/Olympus" }), input({ timezone: "+06:00" }), input({ text: " " }), input({ text: "x".repeat(1001) }),
      input({ requestId: "no" }), { ...input(), ownerUserId: grace }, input({ source: { noteId: randomUUID(), actionItemIndex: -1 } }),
    ]) {
      expect(createReminderSchema.safeParse(bad).success).toBe(false);
      expectCode(() => service.create(ada, office, bad), "INVALID_INPUT");
    }
    for (const bad of [
      { requestId: randomUUID(), revision: 1 }, { requestId: randomUUID(), revision: 0, status: "canceled" },
      { requestId: randomUUID(), revision: 1, status: "acknowledged" },
    ]) expect(patchReminderSchema.safeParse(bad).success).toBe(false);
    expect(reminderAckSchema.safeParse({ notificationId: randomUUID(), userId: ada }).success).toBe(false);
  });
  it("persists mutation idempotency, rejects request reuse and stale revisions, and rolls back failures", () => {
    const payload = input(); const first = service.create(ada, office, payload);
    expect(service.create(ada, office, payload)).toEqual(first);
    expectCode(() => service.create(ada, office, { ...payload, text: "Different" }), "CONFLICT");
    const patch = { requestId: randomUUID(), revision: first.revision, text: "Send the revised design" };
    const edited = service.update(ada, office, first.id, patch);
    expect(service.update(ada, office, first.id, patch)).toEqual(edited);
    expectCode(() => service.update(ada, office, first.id, { ...patch, text: "Different" }), "CONFLICT");
    expectCode(() => service.update(ada, office, first.id, { ...patch, requestId: payload.requestId }), "CONFLICT");
    expectCode(() => service.update(ada, office, first.id, { ...patch, requestId: randomUUID() }), "CONFLICT");
    expectCode(() => service.update(ada, office, first.id, { requestId: randomUUID(), revision: edited.revision, text: edited.text }), "INVALID_INPUT");
    restart();
    expect(service.create(ada, office, payload)).toEqual(first);
    expect(service.update(ada, office, first.id, patch)).toEqual(edited);
    expect(service.list(ada, office)).toEqual([edited]);
  });
  it("confirms readable proposals only through explicit self-owned creation", () => {
    const sessionId = randomUUID(), noteId = randomUUID();
    storage.db.prepare("INSERT INTO ai_sessions (id,meeting_session_id,office_id,request_key,status,revision,record,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(sessionId, randomUUID(), office, randomUUID(), "completed", 1, "{}", Date.now());
    const note: NoteRecord = { id: noteId, aiSessionId: sessionId, createdAt: new Date().toISOString(), partial: false, draft: {
      summary: [], decisions: [], actionItems: [
        { text: "Unassigned", segmentIds: ["s"], ownerUserId: null, dueAt: null },
        { text: "Ada", segmentIds: ["s"], ownerUserId: ada, dueAt: null },
        { text: "Grace", segmentIds: ["s"], ownerUserId: grace, dueAt: null },
      ],
    } };
    new AIRepository(storage).saveNote(note, [ada]);
    expect(service.list(ada, office)).toEqual([]);
    for (const actionItemIndex of [0, 1]) expect(create({ source: { noteId, actionItemIndex } })).toMatchObject({ source: { noteId, actionItemIndex }, text: "Send the design" });
    expectCode(() => create({ source: { noteId, actionItemIndex: 2 } }), "FORBIDDEN");
    expectCode(() => create({ source: { noteId, actionItemIndex: 3 } }), "INVALID_INPUT");
    expectCode(() => service.create(grace, office, input({ source: { noteId, actionItemIndex: 0 } })), "NOT_FOUND");
    expectCode(() => create({ source: { noteId: randomUUID(), actionItemIndex: 0 } }), "NOT_FOUND");
  });
});

describe("M5 durable scheduler and private at-least-once delivery", () => {
  it("survives restarts before due and after offline claim, redelivers stable IDs, then persists ack", () => {
    const reminder = create(); restart();
    vi.setSystemTime(new Date("2026-10-24T14:00:00Z")); service.tick();
    expect(service.list(ada, office)[0]).toMatchObject({ id: reminder.id, status: "due" });
    restart();
    const send = vi.fn<(payload: ReminderDue) => void>(); service.register("ada", ada, office, send);
    expect(send).toHaveBeenCalledTimes(1); const notification = send.mock.calls[0][0];
    service.tick(); expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5000); service.tick(); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual(notification);
    service.unregister("ada"); service.register("new-ada", ada, office, send);
    expect(send.mock.calls[2][0].notificationId).toBe(notification.notificationId);
    const acknowledged = service.acknowledge(ada, office, notification.notificationId);
    expect(acknowledged.status).toBe("acknowledged");
    expect(service.acknowledge(ada, office, notification.notificationId)).toEqual(acknowledged);
    restart(); service.register("ada", ada, office, send); service.tick();
    expect(send).toHaveBeenCalledTimes(3);
    expect(service.list(ada, office)[0]).toEqual(acknowledged);
  });
  it("invalidates old notifications on reschedule, edit, and cancellation", () => {
    const reminder = due(); const send = vi.fn<(payload: ReminderDue) => void>(); service.register("ada", ada, office, send);
    const old = send.mock.calls[0][0];
    const rescheduled = service.update(ada, office, reminder.id, { requestId: randomUUID(), revision: old.reminder.revision, dueAt: "2026-10-25T12:00:00Z" });
    expect(rescheduled.status).toBe("scheduled");
    expectCode(() => service.acknowledge(ada, office, old.notificationId), "NOT_FOUND");
    vi.setSystemTime(Date.now() + 5000); service.tick(); expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z")); service.tick();
    const next = send.mock.calls[1][0]; expect(next.notificationId).not.toBe(old.notificationId);
    const edited = service.update(ada, office, reminder.id, { requestId: randomUUID(), revision: next.reminder.revision, text: "Updated reminder" });
    expectCode(() => service.acknowledge(ada, office, next.notificationId), "NOT_FOUND");
    service.tick(); const final = send.mock.calls[2][0]; expect(final.reminder.text).toBe("Updated reminder");
    const canceled = service.update(ada, office, reminder.id, { requestId: randomUUID(), revision: final.reminder.revision, status: "canceled" });
    expect(canceled.revision).toBeGreaterThan(edited.revision);
    expectCode(() => service.acknowledge(ada, office, final.notificationId), "NOT_FOUND");
    vi.setSystemTime(Date.now() + 5000); service.tick(); expect(send).toHaveBeenCalledTimes(3);
    expectCode(() => service.update(ada, office, reminder.id, { requestId: randomUUID(), revision: canceled.revision, text: "Again" }), "CONFLICT");
  });
  it("enforces user and office isolation for lists, edits, source reads, delivery and ack", () => {
    const reminder = due(); const adaSend = vi.fn<(payload: ReminderDue) => void>(), graceSend = vi.fn();
    service.register("grace", grace, office, graceSend); service.register("ada", ada, office, adaSend);
    const notification = adaSend.mock.calls[0][0]; expect(graceSend).not.toHaveBeenCalled();
    expectCode(() => service.acknowledge(grace, office, notification.notificationId), "NOT_FOUND");
    expectCode(() => service.update(grace, office, reminder.id, { requestId: randomUUID(), revision: notification.reminder.revision, status: "canceled" }), "NOT_FOUND");
    storage.db.prepare("INSERT INTO office_memberships VALUES (?,?,?)").run(ada, "other-office", new Date().toISOString());
    expect(service.list(ada, "other-office")).toEqual([]);
    expectCode(() => service.acknowledge(ada, "other-office", notification.notificationId), "NOT_FOUND");
    expectCode(() => service.update(ada, "other-office", reminder.id, { requestId: randomUUID(), revision: notification.reminder.revision, status: "canceled" }), "NOT_FOUND");
    expectCode(() => service.list(grace, "other-office"), "FORBIDDEN");
    expectCode(() => service.acknowledge(grace, "other-office", notification.notificationId), "NOT_FOUND");
    expectCode(() => service.register("forged", grace, "other-office", graceSend), "FORBIDDEN");
  });
  it("isolates failed sends, retries unread notifications, and stops delivery after unregister/shutdown", () => {
    due(); service.create(grace, office, input({ dueAt: "2026-10-24T11:00:00Z" }));
    const broken = vi.fn(() => { throw new Error("Disconnected"); }), working = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    service.register("ada", ada, office, broken); service.register("grace", grace, office, working);
    vi.setSystemTime(Date.now() + 5000); service.tick();
    expect(broken).toHaveBeenCalledTimes(2); expect(working).toHaveBeenCalledTimes(2);
    expect(repo.pending(ada, office)).toHaveLength(1);
    service.unregister("ada"); service.shutdown(); vi.setSystemTime(Date.now() + 5000); service.tick();
    expect(broken).toHaveBeenCalledTimes(2); expect(working).toHaveBeenCalledTimes(2); log.mockRestore();
  });
  it("rolls the due claim back if the outbox write fails; a subsequent claim creates one notification", () => {
    const reminder = due();
    storage.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
    expect(() => service.tick()).toThrow("simulated crash");
    expect(service.list(ada, office)[0]).toEqual(reminder); expect(repo.pending(ada, office)).toEqual([]);
    storage.db.exec("DROP TRIGGER fail_outbox"); service.tick(); service.tick();
    expect(repo.pending(ada, office)).toHaveLength(1);
    expect(storage.db.prepare("SELECT count(*) AS count FROM notification_outbox").get()).toEqual({ count: 1 });
  });
  it("bounds due claims and private catch-up batches", () => {
    for (let i = 0; i < 105; i++) due();
    service.tick(); expect(service.list(ada, office)).toHaveLength(100); expect(repo.pending(ada, office)).toHaveLength(100);
    expect(storage.db.prepare("SELECT count(*) AS count FROM reminders WHERE status='scheduled'").get()).toEqual({ count: 5 });
    service.tick(); expect(repo.pending(ada, office)).toHaveLength(100);
    const firstBatch = repo.pending(ada, office); for (const notification of firstBatch) service.acknowledge(ada, office, notification.notificationId);
    expect(repo.pending(ada, office)).toHaveLength(5);
  });

  it("paginates older reminders with owner-scoped cursors so they remain editable", () => {
    const created = Array.from({ length: 105 }, (_, index) => create({
      dueAt: new Date(Date.UTC(2026, 10, 1, 12, index)).toISOString(),
    }));
    const first = service.list(ada, office);
    expect(first.map(reminder => reminder.id)).toEqual(created.slice(5).reverse().map(reminder => reminder.id));
    const second = service.list(ada, office, first.at(-1)!.id);
    expect(second.map(reminder => reminder.id)).toEqual(created.slice(0, 5).reverse().map(reminder => reminder.id));
    expect(service.list(ada, office, second.at(-1)!.id)).toEqual([]);
    const oldest = second.at(-1)!;
    expect(service.update(ada, office, oldest.id, { requestId: randomUUID(), revision: oldest.revision, text: "Older reminder remains editable" })).toMatchObject({ id: oldest.id, text: "Older reminder remains editable" });
    expectCode(() => service.list(ada, office, "invalid"), "INVALID_INPUT");
    expectCode(() => service.list(ada, office, randomUUID()), "NOT_FOUND");
    expectCode(() => service.list(grace, office, first.at(-1)!.id), "NOT_FOUND");
    storage.db.prepare("INSERT INTO office_memberships VALUES (?,?,?)").run(ada, "other-office", new Date().toISOString());
    expectCode(() => service.list(ada, "other-office", first.at(-1)!.id), "NOT_FOUND");
  });

  it("uses the ID tie-breaker to paginate reminders with equal due times without gaps", () => {
    const created = Array.from({ length: 105 }, () => create());
    const first = service.list(ada, office), second = service.list(ada, office, first.at(-1)!.id);
    expect([...first, ...second].map(reminder => reminder.id)).toEqual(created.map(reminder => reminder.id).sort().reverse());
  });
});
