import { expect, it } from "vitest";
import { DemoWorkspace, seedTasks, urgency, validateCoordination } from "../../tools/ai-demo/workspace.js";
import { referenceDependencies, referenceOverlap, analyzeCoordination } from "../../tools/ai-demo/coordination.js";
const dep=(blockerTaskId:string,blockedTaskId:string)=>({blockerTaskId,blockedTaskId,reason:"A supported dependency",sources:[{conversationId:"speaker-mapping",excerptId:"e3"}]});
it("previews the distinct-person impact without changing tasks",()=>{
 const store=new DemoWorkspace();const before=store.snapshot();const analysis=store.saveAnalysis(referenceDependencies,"dependencies",0);
 expect(analysis.dependencyImpact[0].current.priority).toBe("low");expect(analysis.dependencyImpact[0].suggested.count).toBe(3);expect(analysis.dependencyImpact[0].suggested.priority).toBe("high");expect(store.snapshot()).toEqual(before);
});
it("confirms reviewed dependencies and preserves base priorities, deadlines and owners",()=>{
 const store=new DemoWorkspace();const before=store.snapshot();const analysis=store.saveAnalysis(referenceDependencies,"dependencies",0);
 const result=store.apply({analysisId:analysis.id,expectedRevision:0,kind:"dependency_all",index:0});
 const exportTask=result.workspace.tasks.find(t=>t.id==="speaker-export")!;expect(exportTask.basePriority).toBe("low");expect(exportTask.coordination).toMatchObject({priority:"high",count:3,affectedPeople:["jordan","maya","nathan"]});
 expect(result.workspace.tasks.map(t=>[t.id,t.ownerId,t.dueAt])).toEqual(before.tasks.map(t=>[t.id,t.ownerId,t.dueAt]));expect(result.workspace.tasks.find(t=>t.id==="urgent-fix")!.coordination.priority).toBe("critical");
 expect(()=>store.apply({analysisId:analysis.id,expectedRevision:0,kind:"dependency_all",index:0})).toThrow(/stale/);
 const undone=store.undo(1);expect(undone.workspace.tasks).toEqual(before.tasks);expect(undone.workspace.revision).toBe(2);expect(()=>store.apply({analysisId:analysis.id,expectedRevision:2,kind:"dependency",index:0})).toThrow(/stale/);
});
it("counts distinct people once and excludes completed and self-owned work",()=>{
 const tasks=structuredClone(seedTasks);const target=tasks.find(t=>t.id==="speaker-export")!;target.requesterIds=["nathan","nathan","cameron"];
 tasks.find(t=>t.id==="draft-preview")!.dependsOn=[target.id];
 tasks.push({...structuredClone(tasks.find(t=>t.id==="draft-preview")!),id:"second-nathan-task"});
 tasks.find(t=>t.id==="old-export")!.dependsOn=[target.id];
 tasks.push({...structuredClone(target),id:"self-task",dependsOn:[target.id],requesterIds:[]});
 expect(urgency(tasks,target.id)).toMatchObject({count:1,priority:"medium",affectedPeople:["nathan"]});
 target.status="completed";expect(urgency(tasks,target.id).count).toBe(0);
});
it("rejects self-links, cycles across suggestions, completed work, unknown tasks and untrusted fields",()=>{
 const tasks=structuredClone(seedTasks);
 for(const dependencies of [[dep("speaker-export","speaker-export")],[dep("old-export","draft-preview")],[dep("missing","draft-preview")],[dep("speaker-export","draft-preview"),dep("draft-preview","speaker-export")]])expect(()=>validateCoordination({dependencies,overlaps:[]},tasks,"dependencies")).toThrow();
 expect(()=>validateCoordination({...referenceDependencies,execute:"send"},tasks,"dependencies")).toThrow();
 const changed=structuredClone(tasks);changed.find(t=>t.id==="draft-preview")!.project="other";expect(()=>validateCoordination({dependencies:[dep("speaker-export","draft-preview")],overlaps:[]},changed,"dependencies")).toThrow();
});
it("rejects invented or repeated citations and finding types outside the requested action",()=>{
 const finding=dep("speaker-export","draft-preview");finding.sources[0].excerptId="missing";expect(()=>validateCoordination({dependencies:[finding],overlaps:[]},seedTasks,"dependencies")).toThrow();
 finding.sources[0].excerptId="e3";finding.sources.push(finding.sources[0]);expect(()=>validateCoordination({dependencies:[finding],overlaps:[]},seedTasks,"dependencies")).toThrow();expect(()=>validateCoordination(referenceOverlap,seedTasks,"dependencies")).toThrow();
});
it("links a confirmed duplicate without reassigning ownership or adding another active task",()=>{
 const store=new DemoWorkspace();const analysis=store.saveAnalysis(referenceOverlap,"overlap",0);expect(store.snapshot().tasks.find(t=>t.id==="proposed-export")!.status).toBe("proposed");
 const {workspace}=store.apply({analysisId:analysis.id,expectedRevision:0,kind:"overlap",index:0});
 expect(workspace.tasks.find(t=>t.id==="proposed-export")).toMatchObject({status:"linked",linkedTo:"speaker-export",ownerId:"nathan"});expect(workspace.tasks.find(t=>t.id==="speaker-export")).toMatchObject({ownerId:"cameron",coordination:{count:1,priority:"medium"}});
 expect(workspace.notifications).toHaveLength(1);expect(workspace.notifications[0]).toMatchObject({recipientId:"cameron",delivery:"quiet_demo_inbox"});
 expect(()=>store.apply({analysisId:analysis.id,expectedRevision:1,kind:"overlap",index:0})).toThrow(/stale/);expect(store.snapshot().notifications).toHaveLength(1);
 expect(store.undo(1).workspace.notifications).toHaveLength(0);
});
it("keeps a similar task separate when the reviewer chooses and rejects forged changes",()=>{
 const store=new DemoWorkspace();const analysis=store.saveAnalysis(referenceOverlap,"overlap",0);
 expect(()=>store.apply({analysisId:analysis.id,expectedRevision:0,kind:"overlap",index:99})).toThrow();
 expect(()=>store.apply({analysisId:analysis.id,expectedRevision:0,kind:"overlap",index:0,ownerId:"jordan"})).toThrow();
 const {workspace}=store.apply({analysisId:analysis.id,expectedRevision:0,kind:"keep_separate",index:0});expect(workspace.tasks.find(t=>t.id==="proposed-export")!.status).toBe("open");expect(workspace.notifications).toEqual([]);
});
it("does not count a linked requester again when their task already depends on the existing task",()=>{
 const store=new DemoWorkspace();const dependencies=store.saveAnalysis(referenceDependencies,"dependencies",0);store.apply({analysisId:dependencies.id,expectedRevision:0,kind:"dependency_all",index:0});
 const overlap=store.saveAnalysis(referenceOverlap,"overlap",1);const {workspace}=store.apply({analysisId:overlap.id,expectedRevision:1,kind:"overlap",index:0});expect(workspace.tasks.find(t=>t.id==="speaker-export")!.coordination.count).toBe(3);
 expect(()=>store.saveAnalysis(referenceOverlap,"overlap",0)).toThrow(/changed/);
});
it("reference mode makes no provider calls and omits already confirmed links",async()=>{
 const store=new DemoWorkspace();const analysis=store.saveAnalysis(referenceDependencies,"dependencies",0);store.apply({analysisId:analysis.id,expectedRevision:0,kind:"dependency_all",index:0});
 const result=await analyzeCoordination("Uninterpreted reference prompt","dependencies",store.snapshot().tasks,{mode:"replay",signal:new AbortController().signal,env:{},request:()=>{throw new Error("Must not call");}});
 expect(result.raw).toEqual({dependencies:[],overlaps:[]});expect(result.promptInterpreted).toBe(false);
});
