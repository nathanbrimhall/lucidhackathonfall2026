import { expect, it } from "vitest";
import { buildKnowledgeContext, knowledgeOptionsSchema, localDate, validateKnowledge, validateWindow } from "../../tools/ai-demo/knowledge.js";
import { referenceKnowledge } from "../../tools/ai-demo/knowledge-runner.js";
import { seedTasks } from "../../tools/ai-demo/workspace.js";
const opts=(extra={})=>knowledgeOptionsSchema.parse(extra);
const current=()=>buildKnowledgeContext("decisions",opts(),seedTasks);
const claim=(id:string,kind="decision",conversationId="scope-oct23",excerptId="e1")=>({kind,text:"A claim with cited evidence",recordIds:[id],taskIds:[],sources:[{conversationId,excerptId}]});
it("keeps role tailoring separate from access and never sends restricted sources for Nathan",()=>{
 for(const options of [opts(),opts({role:"lead"}),opts({includeProjectContext:true})]){
  const context=buildKnowledgeContext("catchup_brief",options,seedTasks);expect(context.records.some(r=>r.id==="personnel-budget")).toBe(false);expect(JSON.stringify(context)).not.toContain("restricted-personnel");
 }
 const member=buildKnowledgeContext("catchup_brief",opts(),seedTasks),lead=buildKnowledgeContext("catchup_brief",opts({role:"lead"}),seedTasks);
 expect(member.records.some(r=>r.id==="project-risk")).toBe(false);expect(lead.records.some(r=>r.id==="project-risk")).toBe(true);
 expect(member.currentTasks.every(t=>t.ownerId==="nathan")).toBe(true);expect(lead.currentTasks.length).toBeGreaterThan(member.currentTasks.length);
});
it("reconstructs supersession as of the selected local day without leaking later sources",()=>{
 const before=buildKnowledgeContext("decisions",opts({fromDate:"2026-10-23",toDate:"2026-10-23"}),seedTasks);
 expect(before.records.find(r=>r.id==="teams-plan")).toMatchObject({status:"confirmed"});expect(JSON.stringify(before)).not.toContain("slack-preview");expect(before.sources.some(s=>s.id==="delivery-oct24")).toBe(false);
 const after=current();expect(after.records.find(r=>r.id==="teams-plan")!.status).toBe("superseded");expect(after.records.find(r=>r.id==="slack-preview")!.status).toBe("confirmed");
});
it("filters brief record windows by local date and returns empty history when appropriate",()=>{
 const daily=buildKnowledgeContext("daily_brief",opts({fromDate:"2026-10-26",toDate:"2026-10-26"}),seedTasks);expect(daily.records.every(r=>localDate(r.createdAt,"America/Denver")==="2026-10-26")).toBe(true);expect(daily.records.some(r=>r.id==="audio-scope")).toBe(false);
 const empty=buildKnowledgeContext("daily_brief",opts({fromDate:"2026-10-22",toDate:"2026-10-22"}),seedTasks);expect(empty.records).toEqual([]);expect(empty.taskSnapshotLabel).toContain("not a historical");
});
it("handles midnight and the repeated DST hour by local calendar dates",()=>{
 expect(localDate("2026-10-26T05:59:59Z","America/Denver")).toBe("2026-10-25");expect(localDate("2026-10-26T06:00:00Z","America/Denver")).toBe("2026-10-26");
 expect(localDate("2026-11-01T07:30:00Z","America/Denver")).toBe("2026-11-01");expect(localDate("2026-11-01T08:30:00Z","America/Denver")).toBe("2026-11-01");
});
it("rejects invalid or excessive date windows",()=>{
 expect(()=>knowledgeOptionsSchema.parse({fromDate:"2026-02-30"})).toThrow();expect(()=>knowledgeOptionsSchema.parse({timeZone:"unknown/timezone"})).toThrow();
 expect(()=>validateWindow(opts({fromDate:"2026-10-27",toDate:"2026-10-26"}),"catchup_brief")).toThrow();expect(()=>validateWindow(opts({fromDate:"2026-01-01",toDate:"2026-10-26"}),"catchup_brief")).toThrow();expect(()=>validateWindow(opts(),"daily_brief")).toThrow();
});
it("refuses to promote assumptions and superseded decisions into confirmed decisions",()=>{
 for(const item of [claim("video-assumption","decision","assumptions-oct26","e1"),claim("teams-plan","decision","scope-oct23","e3")])expect(()=>validateKnowledge({status:"supported",claims:[item],questions:[]},"decisions",current())).toThrow();
 expect(()=>validateKnowledge({status:"supported",claims:[claim("teams-plan","historical_decision","scope-oct23","e3")],questions:[]},"decisions",current())).not.toThrow();
});
it("requires recorded reasoning, authorized IDs and a source for every referenced record",()=>{
 for(const item of [claim("audio-scope","reasoning"),claim("personnel-budget"),{...claim("audio-scope"),recordIds:["audio-scope","slack-preview"]},claim("audio-scope","decision","restricted-personnel","e1")])expect(()=>validateKnowledge({status:"supported",claims:[item],questions:[]},"decisions",current())).toThrow();
 expect(()=>validateKnowledge({status:"supported",claims:[claim("audio-scope","reasoning","scope-oct23","e2")],questions:[]},"decisions",current())).not.toThrow();
});
it("enforces explicit unknowns and requires two positions for conflict answers",()=>{
 expect(()=>validateKnowledge({status:"not_found",claims:[],questions:["Which decision are you referring to?"]},"decisions",current())).not.toThrow();
 expect(()=>validateKnowledge({status:"not_found",claims:[claim("audio-scope")],questions:[]},"decisions",current())).toThrow();expect(()=>validateKnowledge({status:"conflicting",claims:[claim("audio-scope")],questions:[]},"decisions",current())).toThrow();
 const conflict={status:"conflicting",claims:[claim("audio-scope"),claim("video-assumption","assumption","assumptions-oct26","e1")],questions:["Should the team revisit scope?"]};expect(()=>validateKnowledge(conflict,"decisions",current())).not.toThrow();
});
it("rejects answered questions labeled open, invented tasks and extra executable fields",()=>{
 expect(()=>validateKnowledge({status:"supported",claims:[claim("destination-question","open_question","delivery-oct24","e3")],questions:[]},"decisions",current())).toThrow();
 const context=buildKnowledgeContext("daily_brief",opts({fromDate:"2026-10-26",toDate:"2026-10-26"}),seedTasks);expect(()=>validateKnowledge({highlights:[{kind:"task",text:"Do this",recordIds:[],taskIds:["private-task"],sources:[]}],followUpQuestions:[]},"daily_brief",context)).toThrow();
 expect(()=>validateKnowledge({status:"not_found",claims:[],questions:[],sendMessage:true},"decisions",current())).toThrow();
});
it("reference meeting prep includes unresolved issues and omits the answered destination question",()=>{
 const context=buildKnowledgeContext("meeting_prep",opts(),seedTasks);const result=validateKnowledge(referenceKnowledge("meeting_prep",context),"meeting_prep",context);
 expect("agenda" in result&&result.agenda.some(a=>a.recordIds.includes("retention-question"))).toBe(true);expect("agenda" in result&&result.agenda.some(a=>a.recordIds.includes("destination-question"))).toBe(false);
});
it("all reference features respect their context without changing tasks",()=>{
 const before=structuredClone(seedTasks);
 for(const feature of ["decisions","daily_brief","catchup_brief","meeting_prep"] as const){const context=buildKnowledgeContext(feature,opts(feature==="daily_brief"?{fromDate:"2026-10-26"}:{}),seedTasks);expect(()=>validateKnowledge(referenceKnowledge(feature,context),feature,context)).not.toThrow();}
 expect(seedTasks).toEqual(before);
});
