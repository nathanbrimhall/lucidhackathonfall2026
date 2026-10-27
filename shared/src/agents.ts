import { z } from 'zod';
const id=z.string().min(1).max(128),revision=z.number().int().positive();
export const agentRunCreateSchema=z.strictObject({requestId:id,goal:z.string().trim().min(1).max(4000),taskIds:z.array(id).max(100),contactUserIds:z.array(id).max(2),audience:z.literal('office').default('office'),maxModelCalls:z.number().int().min(1).max(6).default(6),mode:z.enum(['fixture','live']).default('fixture')});
export const agentEvidenceSchema=z.strictObject({type:z.enum(['task','answer']),id,revision});
export const agentRespondSchema=z.strictObject({requestId:id,revision,decision:z.enum(['answer','decline','later']),answer:z.string().trim().min(1).max(6000).optional(),allowPublication:z.boolean().default(false)});
export const agentReviseAnswerSchema=z.strictObject({requestId:id,revision,answer:z.string().trim().min(1).max(6000),allowPublication:z.boolean()});
export const agentCancelSchema=z.strictObject({revision});
export const agentEditArtifactSchema=z.strictObject({revision,content:z.string().trim().min(1).max(30000),evidence:z.array(agentEvidenceSchema).max(200)});
export const agentReviewSchema=z.strictObject({requestId:id,revision,decision:z.enum(['approve','reject','changes']),comment:z.string().trim().max(2000).optional()});
export const agentTurnResultSchema=z.strictObject({modelCalls:z.number().int().min(0).max(6),questions:z.array(z.strictObject({recipientUserId:id,question:z.string().trim().min(1).max(2000),reason:z.string().trim().min(1).max(1000)})).max(2).optional(),draft:z.strictObject({content:z.string().trim().min(1).max(30000),evidence:z.array(agentEvidenceSchema).max(200),partial:z.boolean()}).optional(),summary:z.string().max(2000).optional()});
export type AgentEvidence=z.infer<typeof agentEvidenceSchema>;
export type AgentTurnResult=z.infer<typeof agentTurnResultSchema>;
export type AgentRunState='queued'|'working'|'waiting_for_person'|'waiting_for_approval'|'ready_for_review'|'completed'|'partial'|'failed'|'canceled';
export interface AgentRun {id:string;officeId:string;requesterUserId:string;goal:string;taskIds:string[];contactUserIds:string[];audience:'office';mode:'fixture'|'live';state:AgentRunState;revision:number;maxModelCalls:number;modelCalls:number;createdAt:string;updatedAt:string;reason:string|null}
export interface AgentRequest {id:string;runId:string;recipientUserId:string;requesterUserId:string;requesterName:string;question:string;reason:string;answerAudience:string;revision:number;status:string;answer:string|null;allowPublication:boolean;expiresAt:string;createdAt:string}
export interface AgentArtifact {runId:string;revision:number;content:string;evidence:AgentEvidence[];partial:boolean;status:string;audience:'office';createdAt:string}
export interface AgentEvent {cursor:number;type:string;data:unknown;createdAt:string}
export interface AgentRunDetail {run:AgentRun;requests:AgentRequest[];artifact:AgentArtifact|null;events:AgentEvent[];cursor:number}
export interface AgentContext {run:AgentRun;tasks:{id:string;title:string;status:string;revision:number;ownerUserId:string}[];contacts:{userId:string;displayName:string}[];requests:AgentRequest[];artifact:AgentArtifact|null;reviewComments?:{comment:string;artifactRevision:number}[]}
export interface AgentPublicStatus {agentId:'office-agent';state:'working'|'waiting'|'ready'|'idle';sponsorUserId:string|null}
