import { randomUUID } from "node:crypto";
import type { Storage } from "./Storage.js";
import type { AIStatus, NoteRecord } from "../../../shared/src/protocol.js";
import type { AiTranscriptSegment } from "../../../shared/src/ai-worker.js";

export interface AISessionRecord extends AIStatus {
  officeId: string; requestKey: string; createdAt: number; startedAt?: number; processingAt?:number;
  partial: boolean; readers: string[];
}
export interface AIJobRecord { id: string; aiSessionId: string; revision: number; kind: "capture" | "summarize"; state: string; attempts: number; leaseToken: string | null; leaseUntil: number | null }
const jobFields = "id, ai_session_id AS aiSessionId, revision, kind, state, attempts, lease_token AS leaseToken, lease_until AS leaseUntil";
export class AIRepository {
  constructor(private readonly storage: Storage) {}
  transaction<T>(fn: () => T): T { return this.storage.db.transaction(fn).immediate(); }
  save(s: AISessionRecord) {
    this.storage.db.prepare(`INSERT INTO ai_sessions (id,meeting_session_id,office_id,request_key,status,revision,record,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,record=excluded.record,updated_at=excluded.updated_at`)
      .run(s.aiSessionId,s.meetingSessionId,s.officeId,s.requestKey,s.status,s.revision,JSON.stringify(s),Date.now());
    for (const member of s.roster) this.storage.db.prepare("INSERT OR REPLACE INTO ai_consents VALUES (?,?,?,?)").run(s.aiSessionId,s.revision,member.userId,Number(member.consented));
  }
  get(id: string): AISessionRecord | undefined { const row = this.storage.db.prepare("SELECT record FROM ai_sessions WHERE id=?").get(id) as {record:string}|undefined; return row && JSON.parse(row.record); }
  request(key: string): AISessionRecord | undefined { const row = this.storage.db.prepare("SELECT record FROM ai_sessions WHERE request_key=?").get(key) as {record:string}|undefined; return row && JSON.parse(row.record); }
  active(): AISessionRecord[] { return (this.storage.db.prepare("SELECT record FROM ai_sessions WHERE status NOT IN ('completed','canceled','failed')").all() as {record:string}[]).map(r=>JSON.parse(r.record)); }
  segments(id: string): AiTranscriptSegment[] { return (this.storage.db.prepare("SELECT record FROM transcript_segments WHERE ai_session_id=? ORDER BY rowid").all(id) as {record:string}[]).map(r=>JSON.parse(r.record)); }
  append(id:string, segment:AiTranscriptSegment) { this.storage.db.prepare("INSERT OR IGNORE INTO transcript_segments VALUES (?,?,?)").run(id,segment.id,JSON.stringify(segment)); }
  clearSegments(id:string) { this.storage.db.prepare("DELETE FROM transcript_segments WHERE ai_session_id=?").run(id); }
  enqueue(s:AISessionRecord,kind:AIJobRecord["kind"]) { this.storage.db.prepare("INSERT OR IGNORE INTO jobs (id,ai_session_id,revision,kind,state,created_at) VALUES (?,?,?,?,'pending',?)").run(randomUUID(),s.aiSessionId,s.revision,kind,Date.now()); }
  cancelJobs(id:string) { this.storage.db.prepare("UPDATE jobs SET state='canceled',lease_token=NULL,lease_until=NULL WHERE ai_session_id=? AND state IN ('pending','running')").run(id); }
  pending(): AIJobRecord | undefined { return this.storage.db.prepare(`SELECT ${jobFields} FROM jobs WHERE state='pending' ORDER BY created_at,rowid LIMIT 1`).get() as AIJobRecord|undefined; }
  job(id:string): AIJobRecord|undefined { return this.storage.db.prepare(`SELECT ${jobFields} FROM jobs WHERE id=?`).get(id) as AIJobRecord|undefined; }
  expired(now:number): AIJobRecord[] { return this.storage.db.prepare(`SELECT ${jobFields} FROM jobs WHERE state='running' AND lease_until<=?`).all(now) as AIJobRecord[]; }
  claim(id:string, now:number): AIJobRecord { this.storage.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND state='pending'").run(randomUUID(),now+15000,id); return this.job(id)!; }
  heartbeat(id:string,now:number) { this.storage.db.prepare("UPDATE jobs SET lease_until=? WHERE id=?").run(now+15000,id); }
  finish(id:string,state="completed") { this.storage.db.prepare("UPDATE jobs SET state=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(state,id); }
  saveNote(note:NoteRecord,readers:string[]) {
    this.storage.db.prepare("INSERT INTO notes VALUES (?,?,?)").run(note.id,note.aiSessionId,JSON.stringify(note));
    for (const reader of readers) this.storage.db.prepare("INSERT INTO note_readers VALUES (?,?)").run(note.id,reader);
  }
  notes(userId:string,officeId?:string):NoteRecord[]{
    const query="SELECT notes.record AS record FROM notes JOIN note_readers ON notes.id=note_readers.note_id JOIN ai_sessions s ON s.id=notes.ai_session_id WHERE user_id=?"+(officeId?" AND s.office_id=?":"")+" ORDER BY notes.rowid DESC LIMIT 100";
    return (this.storage.db.prepare(query).all(...(officeId?[userId,officeId]:[userId])) as {record:string}[]).map(r=>JSON.parse(r.record));
  }
  note(id:string,userId:string,officeId?:string):NoteRecord|undefined{
    const query="SELECT notes.record AS record FROM notes JOIN note_readers ON notes.id=note_readers.note_id JOIN ai_sessions s ON s.id=notes.ai_session_id WHERE notes.id=? AND user_id=?"+(officeId?" AND s.office_id=?":"");
    const row=this.storage.db.prepare(query).get(...(officeId?[id,userId,officeId]:[id,userId])) as {record:string}|undefined;return row&&JSON.parse(row.record);
  }
}