import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtures } from "../../tools/ai-eval/fixtures.js";
import { createFollowups } from "../src/followups.js";
import { ReviewStore } from "../../tools/ai-demo/review-store.js";
const commitment=fixtures.find(f=>f.id==="commitments")!;
const create=(reviewer="nathan")=>createFollowups(commitment.job,commitment.reference,reviewer);
describe("follow-up composition without provider calls",()=>{
  it("builds two task proposals and a message to the other owner, with evidence and no invented deadline",()=>{
    const bundle=create();
    expect(bundle.proposals.filter(p=>p.kind==="task")).toHaveLength(2);
    const messages=bundle.proposals.filter(p=>p.kind==="message");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({senderUserId:"nathan",recipientUserId:"cameron",status:"draft",revision:0,sourceSegmentIds:["s1","s2"]});
    expect(messages[0].body).toContain("speaker IDs and timestamps");
    expect(messages[0].body).not.toContain("deadline");
    expect(bundle.deliveryStatus).toBe("not_connected");
    expect(bundle.wordingSource).toBe("templates-from-extracted-actions");
  });
  it("changes sender and recipient when another authorized participant reviews",()=>{
    const messages=create("cameron").proposals.filter(p=>p.kind==="message");
    expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({senderUserId:"cameron",recipientUserId:"nathan"});
  });
  it("keeps uncertain owners/recipients null and stores only cited excerpts",()=>{
    const fixture=fixtures.find(f=>f.id==="irrelevant")!;
    const bundle=createFollowups(fixture.job,fixture.reference,"nathan");
    expect(bundle.proposals.find(p=>p.kind==="message")).toMatchObject({recipientUserId:null});
    expect(bundle.proposals.find(p=>p.kind==="task")).toMatchObject({ownerUserId:null});
    expect(bundle.sources.map(s=>s.id)).toEqual(["s2"]);
    expect(JSON.stringify(bundle)).not.toContain("pizza");
  });
  it("produces no proposals for tentative discussion and never mutates input",()=>{
    const fixture=fixtures.find(f=>f.id==="tentative")!;const before=JSON.stringify(fixture);
    expect(createFollowups(fixture.job,fixture.reference,"nathan").proposals).toEqual([]);
    expect(JSON.stringify(fixture)).toBe(before);
  });
  it("rejects unauthorized reviewers, unknown evidence, and unauthorized owners",()=>{
    expect(()=>create("outsider")).toThrow();
    expect(()=>createFollowups(commitment.job,{...commitment.reference,actionItems:[{...commitment.reference.actionItems[0],segmentIds:["unknown"]}]},"nathan")).toThrow();
    expect(()=>createFollowups(commitment.job,{...commitment.reference,actionItems:[{...commitment.reference.actionItems[0],ownerUserId:"outsider"}]},"nathan")).toThrow();
  });
  it("includes an explicit deadline in the conversation timezone",()=>{
    const fixture=fixtures.find(f=>f.id==="daylight-saving")!;
    const message=createFollowups(fixture.job,fixture.reference,"nathan").proposals.find(p=>p.kind==="message")!;
    expect(message.body).toContain("America/Denver");expect(message.body).toContain("2026");expect(message.body).toContain("9:00");
  });
});
describe("local follow-up review state",()=>{
  it("edits, approves, and exports only approved items and their evidence",()=>{
    const store=new ReviewStore(":memory:");
    try{
      const bundle=store.create(create());const message=bundle.proposals.find(p=>p.kind==="message")!;
      const edited=store.update(bundle.id,message.id,{expectedRevision:0,action:"save",changes:{kind:"message",recipientUserId:"cameron",body:"Hi Cameron, could you share an update on the transcript format?"}});
      expect(edited.proposals.find(p=>p.id===message.id)).toMatchObject({revision:1,status:"draft"});
      store.update(bundle.id,message.id,{expectedRevision:1,action:"approve"});
      const exported=store.approvedExport(bundle.id);
      expect(exported.proposals).toHaveLength(1);expect(exported.proposals[0]).toMatchObject({status:"approved",recipientUserId:"cameron"});
      expect(exported.sources.map(s=>s.id)).toEqual(["s1","s2"]);
      expect(exported.deliveryStatus).toBe("not_connected");
    }finally{store.close();}
  });
  it("invalidates approval after editing and rejects stale revisions",()=>{
    const store=new ReviewStore(":memory:");
    try{
      const bundle=store.create(create());const task=bundle.proposals.find(p=>p.kind==="task")!;
      store.update(bundle.id,task.id,{expectedRevision:0,action:"approve"});
      expect(()=>store.update(bundle.id,task.id,{expectedRevision:0,action:"discard"})).toThrow("changed");
      const result=store.update(bundle.id,task.id,{expectedRevision:1,action:"save",changes:{kind:"task",ownerUserId:"nathan",title:"Edited task title",dueAt:null}});
      expect(result.proposals.find(p=>p.id===task.id)).toMatchObject({status:"draft",revision:2,title:"Edited task title"});
      expect(store.approvedExport(bundle.id).proposals).toHaveLength(0);
    }finally{store.close();}
  });
  it("requires an owner/recipient for approval and rejects outsiders, self-messages, and source tampering",()=>{
    const store=new ReviewStore(":memory:");
    try{
      const fixture=fixtures.find(f=>f.id==="irrelevant")!;const bundle=store.create(createFollowups(fixture.job,fixture.reference,"nathan"));
      const message=bundle.proposals.find(p=>p.kind==="message")!;
      expect(()=>store.update(bundle.id,message.id,{expectedRevision:0,action:"approve"})).toThrow("recipient");
      for(const recipientUserId of ["outsider","nathan"])expect(()=>store.update(bundle.id,message.id,{expectedRevision:0,action:"save",changes:{kind:"message",recipientUserId,body:"Update please"}})).toThrow();
      expect(()=>store.update(bundle.id,message.id,{expectedRevision:0,action:"save",changes:{kind:"message",recipientUserId:"cameron",body:"Update please",sourceSegmentIds:["forged"]}})).toThrow();
      const task=bundle.proposals.find(p=>p.kind==="task")!;
      expect(()=>store.update(bundle.id,task.id,{expectedRevision:0,action:"approve"})).toThrow("owner");
      expect(()=>store.update(bundle.id,task.id,{expectedRevision:0,action:"save",changes:{kind:"task",ownerUserId:"nathan",title:"Valid",dueAt:"tomorrow"}})).toThrow();
    }finally{store.close();}
  });
  it("supports discard and explicit restore without exporting discarded items",()=>{
    const store=new ReviewStore(":memory:");
    try{
      const bundle=store.create(create());const proposal=bundle.proposals[0];
      store.update(bundle.id,proposal.id,{expectedRevision:0,action:"discard"});
      expect(()=>store.update(bundle.id,proposal.id,{expectedRevision:1,action:"approve"})).toThrow("Restore");
      const restored=store.update(bundle.id,proposal.id,{expectedRevision:1,action:"restore"});
      expect(restored.proposals[0]).toMatchObject({status:"draft",revision:2});
    }finally{store.close();}
  });
  it("persists edits and approvals across restart",()=>{
    const directory=mkdtempSync(join(tmpdir(),"lucid-reviews-"));const path=join(directory,"reviews.sqlite");
    let store=new ReviewStore(path);
    try{
      const bundle=store.create(create());store.update(bundle.id,bundle.proposals[0].id,{expectedRevision:0,action:"approve"});store.close();
      store=new ReviewStore(path);
      expect(store.get(bundle.id).proposals[0].status).toBe("approved");expect(store.list()[0].approved).toBe(1);
    }finally{
      store.close();
      if(!resolve(directory).startsWith(resolve(tmpdir(),"lucid-reviews-")))throw new Error("Unexpected temporary review path");
      rmSync(directory,{recursive:true,force:true});
    }
  });
});
