import { z } from "zod";
const id = z.string().min(1).max(128);
const common = {
  id, revision: z.number().int().nonnegative(), status: z.enum(["draft", "approved", "discarded"]),
  sourceActionIndex: z.number().int().nonnegative(), sourceSegmentIds: z.array(id).min(1).max(100),
};
export const followupProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("message"), senderUserId: id, recipientUserId: id.nullable(), body: z.string().trim().min(1).max(6000) }),
  z.strictObject({ ...common, kind: z.literal("task"), ownerUserId: id.nullable(), title: z.string().trim().min(1).max(4000), dueAt: z.iso.datetime({ offset: true }).nullable() }),
]);
export const followupBundleSchema = z.strictObject({
  id, createdAt: z.iso.datetime(), reviewerUserId: id,
  sourceConversationId: id,
  participants: z.array(z.strictObject({ userId: id, displayName: z.string().min(1).max(100) })).min(1).max(50),
  sources: z.array(z.strictObject({ id, speakerUserId: id, text: z.string().min(1).max(10000) })).max(5000),
  proposals: z.array(followupProposalSchema).max(100),
  wordingSource: z.literal("templates-from-extracted-actions"),
  deliveryStatus: z.literal("not_connected"),
});
export type FollowupBundle = z.infer<typeof followupBundleSchema>;
export type FollowupProposal = z.infer<typeof followupProposalSchema>;
export const reviewChangesSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), recipientUserId: id.nullable(), body: z.string().trim().min(1).max(6000) }),
  z.strictObject({ kind: z.literal("task"), ownerUserId: id.nullable(), title: z.string().trim().min(1).max(4000), dueAt: z.iso.datetime({ offset: true }).nullable() }),
]);
export const reviewMutationSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  action: z.enum(["save", "approve", "discard", "restore"]),
  changes: reviewChangesSchema.optional(),
});
export type ReviewMutation = z.infer<typeof reviewMutationSchema>;
