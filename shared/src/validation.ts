import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol.js";

export const joinOfficeSchema = z.strictObject({ protocolVersion: z.literal(PROTOCOL_VERSION) });

/** Strict intent-only payload; clients cannot submit coordinates or timing. */
export const playerInputSchema = z.strictObject({
  seq: z.number().int().safe().nonnegative(),
  dx: z.number().finite().min(-1).max(1),
  dy: z.number().finite().min(-1).max(1),
});

export const playerStatusSchema = z.strictObject({
  status: z.enum(["available", "away", "busy"]),
});

const revision = z.number().int().safe().nonnegative();
export const mediaTokenSchema = z.strictObject({ sessionId: z.string().min(1).max(128), transitionRevision: revision.optional() });
export const mediaTransitionAckSchema = z.strictObject({ revision });
export const mediaPreferencesSchema = z.strictObject({ muted: z.boolean(), deafened: z.boolean() });

export const aiRequestSchema = z.strictObject({ requestId: z.string().uuid() });
export const aiStopSchema = z.strictObject({ aiSessionId: z.string().uuid(), revision });
export const aiConsentSchema = aiStopSchema.extend({ consent: z.boolean() });

/** Explicit offsets avoid relying on the application host's timezone or ambiguous wall times. */
const reminderDueAt = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const reminderTimezone = z.string().min(1).max(100).refine(value => {
  // Intl also accepts raw UTC offsets in newer runtimes; require an IANA name here.
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Expected an IANA timezone");
const reminderText = z.string().trim().min(1).max(1000);
export const createReminderSchema = z.strictObject({
  requestId: z.string().uuid(), text: reminderText, dueAt: reminderDueAt, timezone: reminderTimezone,
  source: z.strictObject({ noteId: z.string().uuid(), actionItemIndex: z.number().int().safe().nonnegative() }).optional(),
});
export const patchReminderSchema = z.strictObject({
  requestId: z.string().uuid(), revision: z.number().int().safe().positive(),
  text: reminderText.optional(), dueAt: reminderDueAt.optional(), timezone: reminderTimezone.optional(),
  status: z.literal("canceled").optional(),
}).refine(value => [value.text, value.dueAt, value.timezone, value.status].some(field => field !== undefined), "Provide a reminder change");
export const reminderAckSchema = z.strictObject({ notificationId: z.string().uuid() });
