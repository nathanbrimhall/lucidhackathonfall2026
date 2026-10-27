import { z } from "zod";
const id=z.string().min(1).max(128),revision=z.number().int().positive();
export const prioritySchema=z.enum(["low","medium","high","critical"]);
export const taskCreateSchema=z.strictObject({requestId:id,title:z.string().trim().min(1).max(1000),ownerUserId:id,priority:prioritySchema.default("low"),dueAt:z.iso.datetime({offset:true}).nullable().default(null),source:z.strictObject({noteId:id,actionItemIndex:z.number().int().nonnegative()}).optional()});
export const taskPatchSchema=z.strictObject({revision,title:z.string().trim().min(1).max(1000).optional(),priority:prioritySchema.optional(),dueAt:z.iso.datetime({offset:true}).nullable().optional(),status:z.enum(["open","completed","proposed","declined"]).optional()});
export const dependencySchema=z.strictObject({revision,blockerTaskId:id});
export const overlapLinkSchema=z.strictObject({revision,existingTaskId:id});
export const deskMessageSchema=z.strictObject({requestId:id,recipientUserId:id,body:z.string().trim().min(1).max(2000),replyTo:id.optional()});
export const profilePatchSchema=z.strictObject({skills:z.string().trim().max(500).optional(),allowInterrupt:z.boolean().optional()});
export const draftCreateSchema=z.strictObject({noteId:id,recipientUserId:id.nullable(),body:z.string().trim().min(1).max(2000)});
export const draftPatchSchema=z.strictObject({revision,body:z.string().trim().min(1).max(2000).optional(),recipientUserId:id.nullable().optional(),status:z.enum(["draft","approved","discarded"]).optional()});
export interface SharedTask {id:string;officeId:string;ownerUserId:string;creatorUserId:string;title:string;status:"proposed"|"open"|"completed"|"linked"|"declined";priority:z.infer<typeof prioritySchema>;dueAt:string|null;linkedTo:string|null;source?:{noteId:string;actionItemIndex:number};revision:number;createdAt:string;updatedAt:string;dependsOn:string[];requesters:string[];coordination:{priority:z.infer<typeof prioritySchema>;count:number;people:string[]}}
