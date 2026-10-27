import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AIStatus, AIStatusName, ErrorCode, NoteRecord } from "../../../shared/src/protocol.js";
import { aiDraftNotesSchema, type AiTranscriptSegment, type AiWorkerJob } from "../../../shared/src/ai-worker.js";
import { AIRepository, type AIJobRecord, type AISessionRecord } from "../repositories/AIRepository.js";
import type { Config } from "../config.js";
import type { LiveKitService } from "./LiveKitService.js";
import { log } from "../log.js";

export class AIError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) { super(message); }
}
export interface AIMember { sessionId:string; userId:string; displayName:string; mediaIdentity:string }
export interface AIMeeting {
  meetingSessionId:string; roomName:string; members:AIMember[];
  send(userId:string,event:string,payload:unknown):void;
  indicator(status:AIStatusName|"none"):void;
  /** Retire the current epoch before any new audio may be received. */
  rotate():void;
}
const terminal = (s: AISessionRecord) => ["completed","canceled","failed"].includes(s.status);

/** All authorization decisions are synchronous on the application-owned SQLite connection. */
export class AISessionService {
  private lastWorkerSeen = 0;
  private readonly meetings = new Map<string,AIMeeting>();
  private readonly deliveries = new Map<string,AIMeeting["send"]>();
  private readonly assistants = new Map<string,{identity:string;roomName:string}>();
  constructor(readonly repo:AIRepository, private readonly config:Config, private readonly media:LiveKitService) {
    // A running media session cannot survive application restart. Durable notes remain readable.
    for (const s of repo.active()) this.cancel(s,"failed","SERVER_RESTARTED",false);
  }
  authenticate(header:string|undefined) {
    const expected = this.config.aiWorkerSecret;
    const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!this.config.aiEnabled || !expected || Buffer.byteLength(expected)!==Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected),Buffer.from(actual))) throw new AIError("UNAUTHORIZED");
    this.lastWorkerSeen = Date.now();
  }
  workerStatus(): "up"|"down"|"disabled" { return !this.config.aiEnabled ? "disabled" : this.lastWorkerSeen && Date.now()-this.lastWorkerSeen < 10000 ? "up" : "down"; }
  /** Called before media transitions. Returns whether entry must rotate the epoch. */
  syncMeeting(id:string, meeting?:AIMeeting):boolean {
    const old = this.meetings.get(id);
    if (meeting) this.meetings.set(id,meeting); else this.meetings.delete(id);
    const s = this.repo.active().find(s=>s.meetingSessionId===id);
    if (!s) return false;
    if (!meeting?.members.length) {
      if (s.status==="capturing") this.finalize(s,false,old); else if (s.status!=="processing") this.cancel(s,"canceled",undefined,false);
      return false;
    }
    if (s.status==="processing") return false; // A stopped draft's readership is already frozen.
    const members = new Map(meeting.members.map(m=>[m.userId,m]));
    if (s.roster.length===members.size && s.roster.every(r=>members.has(r.userId))) return false;
    const rotate = this.assistants.has(s.aiSessionId);
    this.revoke(s,false);
    s.revision++; s.status="paused"; s.partial=true; s.error=undefined;
    // Discard the previous roster's context, so a later entrant never inherits earlier speech.
    this.repo.clearSegments(s.aiSessionId); s.readers=[]; s.startedAt=undefined;
    s.roster=meeting.members.map(m=>({userId:m.userId,displayName:m.displayName,consented:false}));
    this.repo.save(s); this.emit(s);
    return rotate;
  }
  request(meetingId:string, sessionId:string, requestId:string) {
    if (!this.config.aiEnabled) throw new AIError("AI_UNAVAILABLE","AI notes are disabled; configure the worker and provider first");
    const meeting=this.requireMeeting(meetingId,sessionId);
    const user=meeting.members.find(m=>m.sessionId===sessionId)!;
    const existing=this.repo.request(`${user.userId}:${requestId}`) ?? this.repo.active().find(s=>s.meetingSessionId===meetingId);
    if (existing) { if (existing.meetingSessionId!==meetingId) throw new AIError("INVALID_INPUT"); this.emit(existing); return existing; }
    if (this.repo.active().length>=this.config.aiMaxConcurrentSessions) throw new AIError("AI_UNAVAILABLE","AI session limit reached");
    const s:AISessionRecord={aiSessionId:randomUUID(),meetingSessionId:meetingId,officeId:this.config.officeId,requestKey:`${user.userId}:${requestId}`,
      revision:1,status:"requesting_consent",roster:meeting.members.map(m=>({userId:m.userId,displayName:m.displayName,consented:false})),
      readers:[],partial:false,createdAt:Date.now()};
    this.deliveries.set(s.aiSessionId,meeting.send);
    this.repo.save(s); this.emit(s); return s;
  }
  consent(sessionId:string,id:string,revision:number,consent:boolean) {
    const s=this.requireSession(sessionId,id,revision);
    if (terminal(s)) { this.emit(s); return; }
    const meeting=this.meetings.get(s.meetingSessionId)!;
    if (!consent) { this.cancel(s,"canceled"); return; }
    if (!["requesting_consent","paused"].includes(s.status)) return;
    const user=meeting.members.find(m=>m.sessionId===sessionId)!;
    s.roster.find(r=>r.userId===user.userId)!.consented=true;
    if (s.roster.every(r=>r.consented)) {
      s.status="capturing"; s.startedAt=Date.now(); s.readers=s.roster.map(r=>r.userId);
      this.repo.enqueue(s,"capture");
    }
    this.repo.save(s); this.emit(s);
  }
  stop(sessionId:string,id:string,revision:number) {
    const s=this.requireSession(sessionId,id,revision);
    if (terminal(s)||s.status==="processing") return;
    if (s.status==="capturing") this.finalize(s); else this.cancel(s,"canceled");
  }
  statusFor(sessionId:string) {
    for (const m of this.meetings.values()) if (m.members.some(p=>p.sessionId===sessionId)) {
      const s=this.repo.active().find(s=>s.meetingSessionId===m.meetingSessionId); if(s) this.emit(s);
    }
  }
  private requireMeeting(id:string,sessionId:string) {
    const m=this.meetings.get(id); if(!m?.members.some(p=>p.sessionId===sessionId)) throw new AIError("FORBIDDEN","Current meeting membership required"); return m;
  }
  private requireSession(sessionId:string,id:string,revision:number) {
    const s=this.repo.get(id); if(!s) throw new AIError("NOT_FOUND");
    const meeting=this.requireMeeting(s.meetingSessionId,sessionId);
    const user=meeting.members.find(m=>m.sessionId===sessionId)!;
    if (!s.roster.some(r=>r.userId===user.userId)) throw new AIError("FORBIDDEN","AI session readership required");
    if(s.revision!==revision) throw new AIError("STALE_CONSENT"); return s;
  }
  private emit(s:AISessionRecord,host=this.meetings.get(s.meetingSessionId)) {
    const payload:AIStatus={aiSessionId:s.aiSessionId,meetingSessionId:s.meetingSessionId,revision:s.revision,status:s.status,roster:s.roster,committedSegments:this.repo.segments(s.aiSessionId).length,...(s.error?{error:s.error}:{})};
    const send=host?.send ?? this.deliveries.get(s.aiSessionId);
    for (const user of s.roster) send?.(user.userId,"ai.status",payload);
    host?.indicator(s.status);
  }
  private revoke(s:AISessionRecord,rotate=true,host=this.meetings.get(s.meetingSessionId)) {
    this.repo.cancelJobs(s.aiSessionId);
    const a=this.assistants.get(s.aiSessionId); this.assistants.delete(s.aiSessionId);
    if (a) {
      // Authorization is removed synchronously; remote cleanup is bounded by the media service.
      void this.media.removeAssistant(a.identity).catch(()=>log("ai.media.remove.failed"));
      if (rotate) host?.rotate();
    }
  }
  private cancel(s:AISessionRecord,status:"canceled"|"failed",error?:string,rotate=true) {
    // Save invalidation before invoking the room callback, which can resynchronize occupancy.
    s.revision++; s.status=status; s.error=error; this.repo.save(s);
    this.revoke(s,rotate); this.repo.clearSegments(s.aiSessionId); this.emit(s); this.deliveries.delete(s.aiSessionId);
  }
  private finalize(s:AISessionRecord,rotate=true,host=this.meetings.get(s.meetingSessionId)) {
    // The uncommitted PCM/provider tail is discarded on stop, so never claim completeness.
    s.partial=true; s.status="processing"; s.processingAt=Date.now(); this.repo.save(s); this.revoke(s,rotate,host);
    if (!this.repo.segments(s.aiSessionId).length) { this.cancel(s,"failed","NO_TRANSCRIPT",false); return; }
    this.repo.enqueue(s,"summarize"); this.emit(s,host);
  }
  tick(now=Date.now()) {
    for (const job of this.repo.expired(now)) {
      const s=this.repo.get(job.aiSessionId); if (!s||terminal(s)) { this.repo.finish(job.id,"canceled"); continue; }
      if (job.kind==="summarize"&&job.attempts<2) this.repo.finish(job.id,"pending"); else this.cancel(s,"failed","WORKER_LEASE_EXPIRED");
    }
    for(const s of this.repo.active()) {
      if (s.status==="processing" && now-(s.processingAt??now)>120000) { this.cancel(s,"failed","PROCESSING_TIMEOUT"); continue; }
      if (s.status==="capturing" && !this.assistants.has(s.aiSessionId) && now-(s.startedAt??now)>15000) { this.cancel(s,"failed","WORKER_DISPATCH_TIMEOUT"); continue; }
      if (s.status==="capturing" && now-s.createdAt>=this.config.aiMaxDurationSeconds*1000) { s.partial=true; this.finalize(s); }
      else if (["requesting_consent","paused"].includes(s.status)&&now-s.createdAt>this.config.aiMaxDurationSeconds*1000) this.cancel(s,"canceled","CONSENT_TIMEOUT");
    }
  }
  private authorizedJob(id:string,lease:string):{job:AIJobRecord;s:AISessionRecord}|undefined {
    const job=this.repo.job(id); const s=job&&this.repo.get(job.aiSessionId);
    if (!job||!s||job.state!=="running"||job.leaseToken!==lease||!job.leaseUntil||job.leaseUntil<=Date.now()||job.revision!==s.revision||terminal(s)||
      (job.kind==="capture"?s.status!=="capturing":s.status!=="processing")) return;
    return {job,s};
  }
  async claim():Promise<AiWorkerJob|null> {
    this.tick();
    const job=this.repo.transaction(()=>{const next=this.repo.pending();return next?this.repo.claim(next.id,Date.now()):undefined;});
    if (!job) return null;
    const s=this.repo.get(job.aiSessionId)!;
    const base={id:job.id,leaseToken:job.leaseToken!,aiSessionId:s.aiSessionId,revision:job.revision};
    if (job.kind==="summarize") return {...base,kind:"summarize",segments:this.repo.segments(s.aiSessionId),readers:s.readers,context:{participants:s.roster.filter(r=>s.readers.includes(r.userId)).map(r=>({userId:r.userId,displayName:r.displayName})),conversationStartedAt:new Date(s.startedAt??s.createdAt).toISOString(),timeZone:this.config.aiTimeZone}};
    const meeting=this.meetings.get(s.meetingSessionId);
    if (!meeting||s.status!=="capturing"||!s.roster.every(r=>r.consented)) { this.cancel(s,"failed","MEETING_ENDED"); return null; }
    const identity=`assistant_${randomUUID()}`,roomName=meeting.roomName;
    this.assistants.set(s.aiSessionId,{identity,roomName});
    try {
      const token=await this.media.issueAssistant(roomName,identity,this.config.aiMaxDurationSeconds);
      if (!this.authorizedJob(job.id,job.leaseToken!)||this.meetings.get(s.meetingSessionId)?.roomName!==roomName) {
        await this.media.removeAssistant(identity); return null;
      }
      return {...base,kind:"capture",roomName,url:this.config.livekitInternalUrl.replace(/^http/,"ws"),token,
        speakers:meeting.members.map(m=>({userId:m.userId,mediaIdentity:m.mediaIdentity})),maxDurationSeconds:Math.max(1,Math.floor((s.createdAt+this.config.aiMaxDurationSeconds*1000-Date.now())/1000))};
    } catch { this.cancel(s,"failed","MEDIA_UNAVAILABLE"); return null; }
  }
  heartbeat(id:string,lease:string) { const a=this.authorizedJob(id,lease); if(a)this.repo.heartbeat(id,Date.now());return {active:!!a,finish:false}; }
  segments(id:string,lease:string,segments:AiTranscriptSegment[]) {
    const a=this.authorizedJob(id,lease); if(!a||a.job.kind!=="capture") throw new AIError("FORBIDDEN","Inactive capture lease");
    this.repo.transaction(()=>{
      const existing=this.repo.segments(a.s.aiSessionId); const known=new Map(existing.map(s=>[s.id,s]));
      let size=existing.reduce((n,s)=>n+s.text.length,0);
      for(const segment of segments) {
        if(!a.s.readers.includes(segment.speakerUserId)||segment.endMs>this.config.aiMaxDurationSeconds*1000) throw new AIError("INVALID_INPUT","Invalid speaker or segment time");
        if(known.has(segment.id)) { if(!["speakerUserId","startMs","endMs","text"].every(key=>known.get(segment.id)![key as keyof AiTranscriptSegment]===segment[key as keyof AiTranscriptSegment])) throw new AIError("INVALID_INPUT","Segment ID conflict"); continue; }
        size+=segment.text.length;
        if(size>this.config.aiMaxTranscriptChars||known.size>=10000) throw new AIError("INVALID_INPUT","Transcript limit exceeded");
        this.repo.append(a.s.aiSessionId,segment); known.set(segment.id,segment);
      }
    });
    this.emit(a.s);
  }
  complete(id:string,lease:string,notes?:unknown) {
    const a=this.authorizedJob(id,lease); if(!a) return {accepted:false};
    if(a.job.kind==="capture") { this.finalize(a.s); return {accepted:true}; }
    const parsed=aiDraftNotesSchema.safeParse(notes); if(!parsed.success) throw new AIError("INVALID_INPUT","Invalid structured notes");
    const segments=this.repo.segments(a.s.aiSessionId); const ids=new Set(segments.map(s=>s.id));
    const draft=parsed.data;
    if ([...draft.summary,...draft.decisions,...draft.actionItems].some(c=>c.segmentIds.some(id=>!ids.has(id))) ||
      draft.actionItems.some(i=>i.ownerUserId!==null&&!a.s.readers.includes(i.ownerUserId))) throw new AIError("INVALID_INPUT","Notes reference unauthorized context");
    const note:NoteRecord={id:randomUUID(),aiSessionId:a.s.aiSessionId,createdAt:new Date().toISOString(),partial:a.s.partial,draft};
    this.repo.transaction(()=>{this.repo.saveNote(note,a.s.readers);a.s.status="completed";this.repo.save(a.s);this.repo.finish(id);this.repo.clearSegments(a.s.aiSessionId);});
    this.emit(a.s);
    const host=this.meetings.get(a.s.meetingSessionId);
    const send=host?.send ?? this.deliveries.get(a.s.aiSessionId);
    for(const reader of a.s.readers) send?.(reader,"notes.ready",{noteId:note.id,aiSessionId:a.s.aiSessionId});
    this.deliveries.delete(a.s.aiSessionId);
    return {accepted:true};
  }
  fail(id:string,lease:string,code:string) {
    const a=this.authorizedJob(id,lease); if(!a)return;
    if(!["QUOTA_EXCEEDED","QUOTA_PAUSED","LOCAL_BUDGET_EXCEEDED"].includes(code)&&a.job.kind==="summarize"&&a.job.attempts<2) this.repo.finish(id,"pending"); else this.cancel(a.s,"failed",code);
  }
  shutdown() { for(const s of this.repo.active()) this.cancel(s,"failed","SERVER_SHUTDOWN");this.meetings.clear(); this.deliveries.clear(); }
}
