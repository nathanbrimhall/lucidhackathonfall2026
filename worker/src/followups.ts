import { randomUUID } from "node:crypto";
import type { AiDraftNotes, AiSummaryJob } from "../../shared/src/ai-worker.js";
import { followupBundleSchema, type FollowupBundle, type FollowupProposal } from "../../shared/src/followups.js";
import { validateNotes } from "./providers.js";
/** Deterministic composition over already-extracted actions. Makes no model calls and never sends anything. */
export function createFollowups(job: AiSummaryJob, value: AiDraftNotes, reviewerUserId: string): FollowupBundle {
  const notes = validateNotes(value, job);
  if (!job.context || !job.readers.includes(reviewerUserId)) throw new Error("A named, authorized reviewer is required");
  const participants = job.context.participants;
  const proposals: FollowupProposal[] = [];
  for (const [index, action] of notes.actionItems.entries()) {
    const common = { revision: 0, status: "draft" as const, sourceActionIndex: index, sourceSegmentIds: [...new Set(action.segmentIds)] };
    proposals.push({ ...common, id: randomUUID(), kind: "task", ownerUserId: action.ownerUserId, title: action.text, dueAt: action.dueAt });
    // A task assigned to the reviewer needs no self-addressed message.
    if (action.ownerUserId === reviewerUserId) continue;
    const recipient = participants.find(p => p.userId === action.ownerUserId);
    const greeting = recipient ? `Hi ${recipient.displayName},` : "Hi,";
    const deadline = action.dueAt ? `\n\nThe agreed deadline is ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: job.context.timeZone }).format(new Date(action.dueAt))} (${job.context.timeZone}).` : "";
    const body = recipient
      ? `${greeting}\n\nFollowing up on our conversation about this action:\n${action.text}${deadline}\n\nCould you share an update when you have a chance?`
      : `${greeting}\n\nWe identified this action in our conversation:\n${action.text}${deadline}\n\nCould you confirm who should own it?`;
    proposals.push({ ...common, id: randomUUID(), kind: "message", senderUserId: reviewerUserId, recipientUserId: action.ownerUserId, body });
  }
  const cited = new Set(proposals.flatMap(p => p.sourceSegmentIds));
  return followupBundleSchema.parse({ id: randomUUID(), createdAt: new Date().toISOString(), reviewerUserId,
    sourceConversationId: job.aiSessionId, participants,
    sources: job.segments.filter(segment => cited.has(segment.id)).map(({ id, speakerUserId, text }) => ({ id, speakerUserId, text })),
    proposals, wordingSource: "templates-from-extracted-actions", deliveryStatus: "not_connected" });
}
