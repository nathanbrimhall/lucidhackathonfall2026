/** Internal authenticated application/worker contract. Never return these jobs to browsers. */
import { z } from "zod";

const id = z.string().min(1).max(128);
const millis = z.number().int().safe().nonnegative();
export const aiTranscriptSegmentSchema = z.strictObject({
  id, speakerUserId: id, startMs: millis, endMs: millis, text: z.string().trim().min(1).max(10_000),
}).refine((s) => s.endMs >= s.startMs, { message: "Invalid segment interval" });
export type AiTranscriptSegment = z.infer<typeof aiTranscriptSegmentSchema>;

const claim = z.strictObject({ text: z.string().trim().min(1).max(4_000), segmentIds: z.array(id).min(1).max(100) });
export const aiDraftNotesSchema = z.strictObject({
  summary: z.array(claim).max(50),
  decisions: z.array(claim).max(50),
  actionItems: z.array(z.strictObject({
    text: z.string().trim().min(1).max(4_000), segmentIds: z.array(id).min(1).max(100),
    ownerUserId: id.nullable(), dueAt: z.iso.datetime({ offset: true }).nullable(),
  })).max(50),
});
export type AiDraftNotes = z.infer<typeof aiDraftNotesSchema>;

const jobBase = { id, leaseToken: z.string().min(1).max(256), aiSessionId: id, revision: z.number().int().safe().nonnegative() };
export const aiWorkerJobSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...jobBase, kind: z.literal("capture"), roomName: id, url: z.url(), token: z.string().min(1).max(16_384),
    speakers: z.array(z.strictObject({ userId: id, mediaIdentity: id })).min(1).max(50),
    maxDurationSeconds: z.number().int().min(1).max(3_600),
  }),
  z.strictObject({ ...jobBase, kind: z.literal("summarize"), segments: z.array(aiTranscriptSegmentSchema).max(10_000), readers: z.array(id).min(1).max(50) }),
]);
export type AiWorkerJob = z.infer<typeof aiWorkerJobSchema>;
export type AiCaptureJob = Extract<AiWorkerJob, { kind: "capture" }>;
export type AiSummaryJob = Extract<AiWorkerJob, { kind: "summarize" }>;
export const aiWorkerClaimResponseSchema = z.strictObject({ job: aiWorkerJobSchema.nullable() });
/** Inactive is a hard cancellation. Finish closes capture normally and allows a draft. */
export const aiWorkerHeartbeatSchema = z.strictObject({ active: z.boolean(), finish: z.boolean() });
export type AiWorkerHeartbeat = z.infer<typeof aiWorkerHeartbeatSchema>;
export const aiWorkerClaimSchema = z.strictObject({ workerId: id });
export const aiWorkerLeaseSchema = z.strictObject({ leaseToken: jobBase.leaseToken });
export const aiWorkerSegmentsSchema = z.strictObject({ leaseToken: jobBase.leaseToken, segments: z.array(aiTranscriptSegmentSchema).min(1).max(20) });
export const aiWorkerCompleteSchema = z.strictObject({ leaseToken: jobBase.leaseToken, notes: aiDraftNotesSchema.optional() });
export const aiWorkerFailSchema = z.strictObject({ leaseToken: jobBase.leaseToken, code: z.enum(["WORKER_FAILED", "PROVIDER_FAILED", "CAPTURE_FAILED"]) });
