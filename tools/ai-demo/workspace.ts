import { z } from "zod";
import { randomUUID } from "node:crypto";
import { conversations } from "./discovery.js";
export const people=[{id:"nathan",name:"Nathan"},{id:"cameron",name:"Cameron"},{id:"maya",name:"Maya"},{id:"jordan",name:"Jordan"}];
export type Priority="low"|"medium"|"high"|"critical";
export interface DemoTask {id:string;title:string;ownerId:string;project:string;status:"open"|"proposed"|"completed"|"linked";basePriority:Priority;dueAt:string|null;dependsOn:string[];requesterIds:string[];linkedTo?:string}
const task=(id:string,title:string,ownerId:string,basePriority:Priority="low"):DemoTask=>({id,title,ownerId,project:"lucid",status:"open",basePriority,dueAt:null,dependsOn:[],requesterIds:[]});
export const seedTasks:DemoTask[]=[
 task("speaker-export","Export stable speaker IDs and timestamps","cameron"),
 task("draft-preview","Build the transcript draft preview","nathan"),
 task("attribution-tests","Run speaker attribution tests","maya"),
 task("transcript-integration","Finish transcript integration","jordan"),
 {...task("proposed-export","Export stable speaker IDs and timestamps for the Lucid demo","nathan"),status:"proposed"},
 {...task("urgent-fix","Fix the demo sign-in failure","jordan","critical"),dueAt:"2026-10-27T16:00:00Z"},
 {...task("old-export","Export last month's transcript sample","maya"),status:"completed"},
];
const ref=z.strictObject({conversationId:z.string().min(1),excerptId:z.string().min(1)});
const finding={reason:z.string().trim().min(1).max(600),sources:z.array(ref).min(1).max(6)};
export const coordinationOutput=z.strictObject({
 dependencies:z.array(z.strictObject({...finding,blockerTaskId:z.string(),blockedTaskId:z.string()})).max(20),
 overlaps:z.array(z.strictObject({...finding,proposedTaskId:z.string(),existingTaskId:z.string()})).max(10),
});
export type CoordinationOutput=z.infer<typeof coordinationOutput>;
export type CoordinationMode="dependencies"|"overlap";
export class WorkspaceError extends Error {constructor(readonly status:number,message:string){super(message);}}
export function urgency(tasks:DemoTask[],id:string){
 const target=tasks.find(t=>t.id===id);if(!target)throw new WorkspaceError(400,"Unknown task");
 const beneficiaries=new Set(target.status==="open"?target.requesterIds.filter(p=>p!==target.ownerId):[]);
 for(const t of tasks)if(target.status==="open"&&t.status==="open"&&t.ownerId!==target.ownerId&&t.dependsOn.includes(id))beneficiaries.add(t.ownerId);
 const rank:Priority[]=["low","medium","high","critical"];
 const suggested=beneficiaries.size>=2?"high":beneficiaries.size===1?"medium":"low";
 return {affectedPeople:[...beneficiaries].sort(),count:beneficiaries.size,priority:rank[Math.max(rank.indexOf(target.basePriority),rank.indexOf(suggested))],basePriority:target.basePriority,dueAt:target.dueAt};
}
function cycle(tasks:DemoTask[],blocker:string,blocked:string){
 const seen=new Set<string>();const visit=(id:string):boolean=>{if(id===blocked)return true;if(seen.has(id))return false;seen.add(id);return tasks.find(t=>t.id===id)?.dependsOn.some(visit)??false;};return visit(blocker);
}
export function validateCoordination(raw:unknown,tasks:DemoTask[],mode:CoordinationMode){
 const result=coordinationOutput.parse(raw);if((mode==="dependencies"&&result.overlaps.length)||(mode==="overlap"&&result.dependencies.length))throw new WorkspaceError(400,"Unexpected analysis type");
 const seen=new Set<string>();
 for(const item of [...result.dependencies,...result.overlaps]){
  const refs=new Set<string>();for(const source of item.sources){const key=source.conversationId+":"+source.excerptId;if(refs.has(key)||!conversations.some(c=>c.id===source.conversationId&&c.excerpts.some(e=>e.id===source.excerptId)))throw new WorkspaceError(400,"Invalid evidence");refs.add(key);}
 }
 for(const item of result.dependencies){
  const blocker=tasks.find(t=>t.id===item.blockerTaskId),blocked=tasks.find(t=>t.id===item.blockedTaskId);const key=item.blockerTaskId+":"+item.blockedTaskId;
  if(!blocker||!blocked||blocker.id===blocked.id||blocker.status!=="open"||blocked.status!=="open"||blocker.project!==blocked.project||blocked.dependsOn.includes(blocker.id)||seen.has(key)||cycle(tasks,blocker.id,blocked.id))throw new WorkspaceError(400,"Invalid dependency");seen.add(key);
  // Validate proposed links together, not only against the original graph.
  tasks=structuredClone(tasks);tasks.find(t=>t.id===blocked.id)!.dependsOn.push(blocker.id);
 }
 for(const item of result.overlaps){
  const proposed=tasks.find(t=>t.id===item.proposedTaskId),existing=tasks.find(t=>t.id===item.existingTaskId);
  if(!proposed||!existing||proposed.status!=="proposed"||existing.status!=="open"||proposed.project!==existing.project||proposed.id===existing.id||seen.has(proposed.id))throw new WorkspaceError(400,"Invalid overlap");seen.add(proposed.id);
 }
 return result;
}
export const reviewCoordination=z.strictObject({analysisId:z.string(),expectedRevision:z.number().int().nonnegative(),kind:z.enum(["dependency","dependency_all","overlap","keep_separate"]),index:z.number().int().nonnegative()});
type DemoNotification={id:string;recipientId:string;text:string;delivery:"quiet_demo_inbox"};
export class DemoWorkspace {
 private tasks:DemoTask[];private revision=0;
 private notifications:DemoNotification[]=[];
 private analyses=new Map<string,{revision:number;mode:CoordinationMode;result:CoordinationOutput}>();
 private history:{tasks:DemoTask[];notifications:DemoNotification[];description:string}[]=[];
 constructor(tasks=seedTasks){this.tasks=structuredClone(tasks);}
 snapshot(){return {fictional:true,revision:this.revision,people,tasks:this.tasks.map(t=>({...structuredClone(t),coordination:urgency(this.tasks,t.id)})),notifications:structuredClone(this.notifications),canUndo:this.history.length>0};}
 saveAnalysis(raw:unknown,mode:CoordinationMode,expectedRevision:number){
  if(expectedRevision!==this.revision)throw new WorkspaceError(409,"Workspace changed while analyzing. Run the analysis again.");
  const result=validateCoordination(raw,this.tasks,mode);const id=randomUUID();this.analyses.set(id,{revision:this.revision,mode,result:structuredClone(result)});if(this.analyses.size>20)this.analyses.delete(this.analyses.keys().next().value!);
  const previewTasks=structuredClone(this.tasks);for(const d of result.dependencies)previewTasks.find(t=>t.id===d.blockedTaskId)!.dependsOn.push(d.blockerTaskId);
  return {id,revision:this.revision,mode,...result,dependencyImpact:result.dependencies.map(d=>({taskId:d.blockerTaskId,current:urgency(this.tasks,d.blockerTaskId),suggested:urgency(previewTasks,d.blockerTaskId)}))};
 }
 apply(raw:unknown){
  const input=reviewCoordination.parse(raw);const analysis=this.analyses.get(input.analysisId);
  if(!analysis)throw new WorkspaceError(404,"Analysis expired. Run it again.");
  if(input.expectedRevision!==this.revision||analysis.revision!==this.revision)throw new WorkspaceError(409,"This review is stale. Refresh and run the analysis again.");
  const item=(input.kind==="dependency"||input.kind==="dependency_all")?analysis.result.dependencies[input.index]:analysis.result.overlaps[input.index];
  if(!item)throw new WorkspaceError(400,"Invalid finding");
  const tasks=structuredClone(this.tasks),notifications=structuredClone(this.notifications);
  let description:string;
  if(input.kind==="dependency_all"&&"blockerTaskId" in item){
   for(const dependency of analysis.result.dependencies)tasks.find(t=>t.id===dependency.blockedTaskId)!.dependsOn.push(dependency.blockerTaskId);description="Confirmed all reviewed dependencies";
  }else if(input.kind==="dependency"&&"blockerTaskId" in item){
   tasks.find(t=>t.id===item.blockedTaskId)!.dependsOn.push(item.blockerTaskId);description="Confirmed dependency";
  }else if("proposedTaskId" in item){
   const proposed=tasks.find(t=>t.id===item.proposedTaskId)!,existing=tasks.find(t=>t.id===item.existingTaskId)!;
   if(input.kind==="keep_separate"){proposed.status="open";description="Kept task separate";}
   else {proposed.status="linked";proposed.linkedTo=existing.id;if(proposed.ownerId!==existing.ownerId&&!existing.requesterIds.includes(proposed.ownerId))existing.requesterIds.push(proposed.ownerId);
    notifications.push({id:randomUUID(),recipientId:existing.ownerId,text:`${people.find(p=>p.id===proposed.ownerId)?.name??proposed.ownerId} linked their request to your task: ${existing.title}. Coordination urgency was recalculated. No ownership change.`,delivery:"quiet_demo_inbox"});description="Linked to existing task";}
  }else throw new WorkspaceError(400,"Invalid review action");
  this.history.push({tasks:this.tasks,notifications:this.notifications,description});if(this.history.length>30)this.history.shift();this.tasks=tasks;this.notifications=notifications;this.revision++;
  return {description,workspace:this.snapshot()};
 }
 undo(expectedRevision:number){
  if(expectedRevision!==this.revision)throw new WorkspaceError(409,"Workspace changed. Refresh before undo.");const previous=this.history.pop();if(!previous)throw new WorkspaceError(400,"Nothing to undo");this.tasks=previous.tasks;this.notifications=previous.notifications;this.revision++;return {description:`Undid: ${previous.description}`,workspace:this.snapshot()};
 }
}
