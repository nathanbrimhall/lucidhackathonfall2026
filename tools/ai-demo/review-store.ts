import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { followupBundleSchema, reviewMutationSchema, type FollowupBundle, type ReviewMutation } from "../../shared/src/followups.js";
export class ReviewError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT", message: string) { super(message); }
}
/** Single-user localhost demo storage. Only proposals and cited excerpts are retained. */
export class ReviewStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    if(path!==":memory:") mkdirSync(dirname(path),{recursive:true});
    this.db=new Database(path);
    this.db.pragma("busy_timeout = 5000"); this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS followup_reviews (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, record TEXT NOT NULL)");
  }
  create(bundle: FollowupBundle) {
    const value=followupBundleSchema.parse(bundle);
    this.db.transaction(()=>{
      this.db.prepare("INSERT INTO followup_reviews VALUES (?,?,?)").run(value.id,value.createdAt,JSON.stringify(value));
      // Bounded local history; all cards in a bundle remain together.
      this.db.exec("DELETE FROM followup_reviews WHERE id NOT IN (SELECT id FROM followup_reviews ORDER BY rowid DESC LIMIT 50)");
    }).immediate();
    return value;
  }
  get(id: string): FollowupBundle {
    const row=this.db.prepare("SELECT record FROM followup_reviews WHERE id=?").get(id) as {record:string}|undefined;
    if(!row) throw new ReviewError("NOT_FOUND","Review no longer exists in local history.");
    return followupBundleSchema.parse(JSON.parse(row.record));
  }
  list() {
    return (this.db.prepare("SELECT record FROM followup_reviews ORDER BY rowid DESC LIMIT 50").all() as {record:string}[]).map(row=>{
      const bundle=followupBundleSchema.parse(JSON.parse(row.record));
      return {id:bundle.id,createdAt:bundle.createdAt,reviewerUserId:bundle.reviewerUserId,proposals:bundle.proposals.length,approved:bundle.proposals.filter(p=>p.status==="approved").length};
    });
  }
  update(bundleId: string, proposalId: string, input: unknown) {
    const parsed=reviewMutationSchema.safeParse(input);
    if(!parsed.success) throw new ReviewError("INVALID_INPUT","Invalid edit. Check text, participant, and deadline fields.");
    return this.db.transaction(()=>this.mutate(bundleId,proposalId,parsed.data)).immediate();
  }
  private mutate(bundleId: string, proposalId: string, input: ReviewMutation) {
    const bundle=this.get(bundleId);
    const proposal=bundle.proposals.find(p=>p.id===proposalId);
    if(!proposal) throw new ReviewError("NOT_FOUND","Proposal not found.");
    if(proposal.revision!==input.expectedRevision) throw new ReviewError("CONFLICT","This proposal changed. Reload the saved review before editing again.");
    if(input.action==="restore") {
      if(proposal.status!=="discarded" || input.changes) throw new ReviewError("INVALID_INPUT","Only a discarded item can be restored.");
      proposal.status="draft";
    } else if(input.action==="discard") {
      if(input.changes) throw new ReviewError("INVALID_INPUT","Discard does not change proposal text.");
      proposal.status="discarded";
    } else {
      if(proposal.status==="discarded") throw new ReviewError("CONFLICT","Restore this item before editing or approving it.");
      const changes=input.changes;
      if(changes && changes.kind!==proposal.kind) throw new ReviewError("INVALID_INPUT","Proposal type cannot be changed.");
      const selected = changes?.kind==="message" ? changes.recipientUserId : changes?.kind==="task" ? changes.ownerUserId : proposal.kind==="message" ? proposal.recipientUserId : proposal.ownerUserId;
      if(selected!==null && !bundle.participants.some(p=>p.userId===selected)) throw new ReviewError("INVALID_INPUT","Select a participant from this conversation.");
      if(proposal.kind==="message" && selected===proposal.senderUserId) throw new ReviewError("INVALID_INPUT","A follow-up message must be addressed to another participant.");
      if(input.action==="approve" && selected===null) throw new ReviewError("INVALID_INPUT",proposal.kind==="message" ? "Choose a recipient before approving." : "Choose a task owner before approving.");
      if(proposal.kind==="message" && changes?.kind==="message") { proposal.body=changes.body;proposal.recipientUserId=changes.recipientUserId; }
      if(proposal.kind==="task" && changes?.kind==="task") { proposal.title=changes.title;proposal.ownerUserId=changes.ownerUserId;proposal.dueAt=changes.dueAt; }
      // Editing an approved item always requires a fresh approval.
      proposal.status=input.action==="approve"?"approved":"draft";
    }
    proposal.revision++;
    this.db.prepare("UPDATE followup_reviews SET record=? WHERE id=?").run(JSON.stringify(followupBundleSchema.parse(bundle)),bundleId);
    return bundle;
  }
  approvedExport(id: string) {
    const bundle=this.get(id);
    const proposals=bundle.proposals.filter(p=>p.status==="approved");
    const cited=new Set(proposals.flatMap(p=>p.sourceSegmentIds));
    return { ...bundle, proposals, sources:bundle.sources.filter(s=>cited.has(s.id)), exportedAt:new Date().toISOString(), deliveryStatus:"not_connected" as const };
  }
  close() { this.db.close(); }
}
