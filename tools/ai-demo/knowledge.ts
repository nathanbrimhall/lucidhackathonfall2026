import { z } from "zod";
import type { DemoTask } from "./workspace.js";
export const knowledgeFeatures=["decisions","daily_brief","catchup_brief","meeting_prep"] as const;
export type KnowledgeFeature=typeof knowledgeFeatures[number];
export const isKnowledgeFeature=(value:string):value is KnowledgeFeature=>(knowledgeFeatures as readonly string[]).includes(value);
const date=z.iso.date();
export const knowledgeOptionsSchema=z.strictObject({
 viewerId:z.enum(["nathan","cameron","maya","jordan"]).default("nathan"),
 role:z.enum(["contributor","lead"]).default("contributor"),
 includeProjectContext:z.boolean().default(false),
 fromDate:date.default("2026-10-23"),toDate:date.default("2026-10-26"),
 timeZone:z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}},"Use an IANA timezone").default("America/Denver"),
});
export type KnowledgeOptions=z.infer<typeof knowledgeOptionsSchema>;
export interface SourceRef {conversationId:string;excerptId:string}
const everyone=["nathan","cameron","maya","jordan"];
interface HistoricalConversation {id:string;title:string;time:string;readers:string[];excerpts:{id:string;text:string}[]}
export const historySources:HistoricalConversation[]=[
 {id:"scope-oct23",title:"Demo scope and tradeoffs",time:"2026-10-23T10:00:00-06:00",readers:everyone,excerpts:[
  {id:"e1",text:"Nathan and Cameron agreed that the hackathon demo will use audio only. Video is deferred until after the demo."},
  {id:"e2",text:"The recorded reason was to reduce camera and layout work so the team can finish consented audio, attribution and task review."},
  {id:"e3",text:"The team agreed to try Teams delivery only if the university approves the required app access; it is conditional, not a promise of integration."},
  {id:"e4",text:"How long should we retain conversation notes? No retention period has been agreed."}]},
 {id:"delivery-oct24",title:"Revised delivery plan",time:"2026-10-24T11:00:00-06:00",readers:everyone,excerpts:[
  {id:"e1",text:"The university account cannot register the required app. Nathan and Cameron agreed to replace the conditional Teams plan with Slack-oriented local draft previews for this demo."},
  {id:"e2",text:"The reason for the change is blocked tenant access. All drafts still require review; nothing is sent automatically."},
  {id:"e3",text:"The destination question is answered for the demo: Slack-oriented previews, with actual delivery still unconnected."}]},
 {id:"assumptions-oct26",title:"Assumption check before the demo",time:"2026-10-26T09:00:00-06:00",readers:everyone,excerpts:[
  {id:"e1",text:"Maya assumes video will be included because the audio service also supports it. The team has not approved a scope change; the audio-only decision still stands."},
  {id:"e2",text:"Nathan assumes a free model tier will not use inputs for training. Cameron says this has not been verified. This conversation does not establish the provider's policy."},
  {id:"e3",text:"The notes-retention question is still open. Bring it to the next design meeting rather than inventing a retention period."},
  {id:"e4",text:"Jordan wants a project-level risk view of the tenant access blocker; contributors prefer their own next steps with optional project context."}]},
 {id:"restricted-personnel",title:"Restricted fictional personnel planning",time:"2026-10-26T10:00:00-06:00",readers:["jordan"],excerpts:[{id:"e1",text:"Restricted fictional personnel budget discussion. This is not shared with the whole project."}]},
];
export interface KnowledgeRecord {
 id:string;kind:"decision"|"assumption"|"question";topic:string;text:string;createdAt:string;
 status:"confirmed"|"unverified"|"open"|"answered"|"superseded";readers:string[];detail:"team"|"project";
 sources:SourceRef[];reasoning?:{text:string;sources:SourceRef[]};supersededAt?:string;supersededBy?:string;
}
const source=(conversationId:string,excerptId:string):SourceRef=>({conversationId,excerptId});
export const knowledgeRecords:KnowledgeRecord[]=[
 {id:"audio-scope",kind:"decision",topic:"scope",text:"Audio only for the hackathon demo; video is deferred.",createdAt:historySources[0].time,status:"confirmed",readers:everyone,detail:"team",sources:[source("scope-oct23","e1")],reasoning:{text:"Reduce camera/layout work and finish consented audio, attribution and task review.",sources:[source("scope-oct23","e2")]}},
 {id:"teams-plan",kind:"decision",topic:"delivery",text:"Try Teams delivery only if university app access is approved.",createdAt:historySources[0].time,status:"confirmed",readers:everyone,detail:"team",sources:[source("scope-oct23","e3")],supersededAt:historySources[1].time,supersededBy:"slack-preview"},
 {id:"slack-preview",kind:"decision",topic:"delivery",text:"Replace the conditional Teams plan with Slack-oriented local draft previews; actual delivery remains unconnected.",createdAt:historySources[1].time,status:"confirmed",readers:everyone,detail:"team",sources:[source("delivery-oct24","e1")],reasoning:{text:"Tenant app access is blocked, and drafts must remain reviewed.",sources:[source("delivery-oct24","e2")]}},
 {id:"destination-question",kind:"question",topic:"delivery",text:"Which destination will the demo target? Answer: Slack-oriented previews, with delivery not connected.",createdAt:historySources[1].time,status:"answered",readers:everyone,detail:"team",sources:[source("delivery-oct24","e3") ]},
 {id:"video-assumption",kind:"assumption",topic:"scope",text:"Video will be included because the audio service supports it. This assumption conflicts with the confirmed audio-only scope.",createdAt:historySources[2].time,status:"unverified",readers:everyone,detail:"team",sources:[source("assumptions-oct26","e1")]},
 {id:"privacy-assumption",kind:"assumption",topic:"privacy",text:"Free model inputs are excluded from training. This has not been verified; no provider policy is established here.",createdAt:historySources[2].time,status:"unverified",readers:everyone,detail:"team",sources:[source("assumptions-oct26","e2")]},
 {id:"retention-question",kind:"question",topic:"privacy",text:"How long should conversation notes be retained? No answer has been agreed.",createdAt:historySources[2].time,status:"open",readers:everyone,detail:"team",sources:[source("assumptions-oct26","e3")]},
 {id:"project-risk",kind:"assumption",topic:"coordination",text:"Contributors prefer their own next steps; Jordan wants an expanded project risk view. This is a briefing preference, not a permission change.",createdAt:historySources[2].time,status:"unverified",readers:everyone,detail:"project",sources:[source("assumptions-oct26","e4")]},
 {id:"personnel-budget",kind:"question",topic:"personnel",text:"Restricted personnel budget planning.",createdAt:historySources[3].time,status:"open",readers:["jordan"],detail:"project",sources:[source("restricted-personnel","e1")]},
];
export function localDate(iso:string,timeZone:string){
 const parts=new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(iso));const part=(type:string)=>parts.find(p=>p.type===type)!.value;return `${part("year")}-${part("month")}-${part("day")}`;
}
export function validateWindow(options:KnowledgeOptions,feature:KnowledgeFeature){
 if(feature==="decisions"||feature==="meeting_prep")return;
 if(options.fromDate>options.toDate||Date.parse(options.toDate)-Date.parse(options.fromDate)>89*86400000)throw new Error("Choose an ordered date window of at most 90 calendar days.");
 if(feature==="daily_brief"&&options.fromDate!==options.toDate)throw new Error("A daily brief needs the same start and end date.");
}
export function buildKnowledgeContext(feature:KnowledgeFeature,options:KnowledgeOptions,tasks:DemoTask[]){
 validateWindow(options,feature);
 const briefing=feature==="daily_brief"||feature==="catchup_brief";
 const detailed=options.role==="lead"||options.includeProjectContext;
 const records=knowledgeRecords.filter(record=>record.readers.includes(options.viewerId)&&localDate(record.createdAt,options.timeZone)<=options.toDate&&(!briefing||localDate(record.createdAt,options.timeZone)>=options.fromDate)&&(!briefing||detailed||record.detail==="team")).map(record=>{
  const {readers,supersededAt,supersededBy,...visible}=structuredClone(record);
  const superseded=supersededAt&&localDate(supersededAt,options.timeZone)<=options.toDate;
  return {...visible,status:superseded?"superseded" as const:visible.status,...(superseded?{supersededAt,supersededBy}: {})};
 });
 const refs=records.flatMap(r=>[...r.sources,...(r.reasoning?.sources??[])]);
 const sources=historySources.filter(s=>s.readers.includes(options.viewerId)).map(({readers,...s})=>({...s,excerpts:s.excerpts.filter(e=>refs.some(r=>r.conversationId===s.id&&r.excerptId===e.id))})).filter(s=>s.excerpts.length);
 const myBlockers=new Set(tasks.filter(t=>t.status==="open"&&t.ownerId===options.viewerId).flatMap(t=>t.dependsOn));
 const currentTasks=feature==="decisions"?[]:tasks.filter(t=>t.project==="lucid"&&t.status==="open"&&(detailed||t.ownerId===options.viewerId||myBlockers.has(t.id))).map(t=>structuredClone(t));
 return {feature,window:{fromDate:options.fromDate,toDate:options.toDate,timeZone:options.timeZone},viewerId:options.viewerId,role:options.role,includeProjectContext:options.includeProjectContext,records,sources,currentTasks,taskSnapshotLabel:"Current fictional workspace, not a historical task-change log"};
}
export type KnowledgeContext=ReturnType<typeof buildKnowledgeContext>;
export const sourceSchema=z.strictObject({conversationId:z.string(),excerptId:z.string()});
const attribution={recordIds:z.array(z.string()).max(10),taskIds:z.array(z.string()).max(10),sources:z.array(sourceSchema).max(20)};
const claim=z.strictObject({kind:z.enum(["decision","historical_decision","assumption","reasoning","open_question","answered_question","task","dependency"]),text:z.string().trim().min(1).max(1200),...attribution});
export const decisionOutput=z.strictObject({status:z.enum(["supported","uncertain","not_found","conflicting"]),claims:z.array(claim).max(12),questions:z.array(z.string().trim().min(1).max(400)).max(5)});
export const briefOutput=z.strictObject({highlights:z.array(claim).max(15),followUpQuestions:z.array(z.string().trim().min(1).max(400)).max(6)});
export const meetingOutput=z.strictObject({agenda:z.array(z.strictObject({title:z.string().trim().min(1).max(180),question:z.string().trim().min(1).max(600),desiredOutcome:z.string().trim().min(1).max(600),...attribution})).max(8)});
export const outputSchema=(feature:KnowledgeFeature)=>feature==="decisions"?decisionOutput:feature==="meeting_prep"?meetingOutput:briefOutput;
export function validateKnowledge(raw:unknown,feature:KnowledgeFeature,context:KnowledgeContext){
 const result=outputSchema(feature).parse(raw);
 const entries="claims" in result?result.claims:"highlights" in result?result.highlights:result.agenda;
 const agendaEvidence=new Set<string>();
 for(const entry of entries){
  if(!entry.recordIds.length&&!entry.taskIds.length)throw new Error("Missing evidence");
  if(new Set(entry.recordIds).size!==entry.recordIds.length||new Set(entry.taskIds).size!==entry.taskIds.length)throw new Error("Repeated evidence");
  const records=entry.recordIds.map(id=>context.records.find(r=>r.id===id));
  if(records.some(r=>!r)||entry.taskIds.some(id=>!context.currentTasks.some(t=>t.id===id)))throw new Error("Unknown or inaccessible record/task");
  const allowed=records.flatMap(r=>[...r!.sources,...(r!.reasoning?.sources??[])]);
  const seen=new Set<string>();
  for(const ref of entry.sources){const key=ref.conversationId+":"+ref.excerptId;if(seen.has(key)||!allowed.some(a=>a.conversationId===ref.conversationId&&a.excerptId===ref.excerptId))throw new Error("Unknown or unrelated source");seen.add(key);}
  if(records.length&&!entry.sources.length)throw new Error("Missing discussion source");
  for(const record of records)if(!entry.sources.some(s=>[...record!.sources,...(record!.reasoning?.sources??[])].some(a=>a.conversationId===s.conversationId&&a.excerptId===s.excerptId)))throw new Error("Each record needs its own citation");
  if(!("kind" in entry)){
   const key=[...entry.recordIds].sort().join(",")+"|"+[...entry.taskIds].sort().join(",");
   if(agendaEvidence.has(key))throw new Error("Duplicate agenda topic");agendaEvidence.add(key);
   if(!entry.taskIds.length&&records.every(r=>r!.kind==="question"&&r!.status==="answered"))throw new Error("Already answered question is not an unresolved agenda item");
  }
  if("kind" in entry){
   if(entry.kind!=="task"&&entry.kind!=="dependency"&&entry.taskIds.length)throw new Error("Record claims cannot attach unrelated task IDs");
   const all=(predicate:(r:NonNullable<typeof records[number]>)=>boolean)=>records.length>0&&records.every(r=>predicate(r!));
   const valid=entry.kind==="decision"?all(r=>r.kind==="decision"&&r.status==="confirmed"):
    entry.kind==="historical_decision"?all(r=>r.kind==="decision"&&r.status==="superseded"):
    entry.kind==="assumption"?all(r=>r.kind==="assumption"&&r.status==="unverified"):
    entry.kind==="reasoning"?all(r=>!!r.reasoning&&entry.sources.some(s=>r.reasoning!.sources.some(a=>a.conversationId===s.conversationId&&a.excerptId===s.excerptId))):
    entry.kind==="open_question"?all(r=>r.kind==="question"&&r.status==="open"):
    entry.kind==="answered_question"?all(r=>r.kind==="question"&&r.status==="answered"):
    entry.kind==="task"?entry.taskIds.length>0&&records.length===0:
    entry.taskIds.length>=2&&entry.taskIds.some(id=>context.currentTasks.find(t=>t.id===id)!.dependsOn.some(blocker=>entry.taskIds.includes(blocker)));
   if(!valid)throw new Error("Claim classification does not match evidence state");
  }
 }
 if("status" in result){if(result.status==="not_found"&&result.claims.length)throw new Error("Not-found answer includes claims");if((result.status==="supported"||result.status==="conflicting")&&!result.claims.length)throw new Error("Answer needs evidence");if(result.status==="conflicting"&&new Set(result.claims.flatMap(c=>c.recordIds)).size<2)throw new Error("A conflict needs two supported positions");}
 return result;
}
