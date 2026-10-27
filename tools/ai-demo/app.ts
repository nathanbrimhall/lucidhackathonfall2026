import { buildKnowledgeContext, isKnowledgeFeature, validateWindow } from "./knowledge.js";
import { answerKnowledge } from "./knowledge-runner.js";
import { DemoWorkspace, WorkspaceError } from "./workspace.js";
import { analyzeCoordination, panelRequest } from "./coordination.js";
import { z } from "zod";
import { discover, discoveryRequest, conversations } from "./discovery.js";
import express from "express";
import { ReviewStore, ReviewError } from "./review-store.js";
import { UsageTracker } from "../../worker/src/usage.js";
import { loadWorkerConfig } from "../../worker/src/config.js";
import { fileURLToPath } from "node:url";
import { aiWorkerJobSchema } from "../../shared/src/ai-worker.js";
import { fixtures } from "../ai-eval/fixtures.js";
import { runFixture } from "../ai-eval/runner.js";
export function createDemoApp(options: { env?: NodeJS.ProcessEnv; request?: typeof fetch; cooldownMs?: number; maxLiveCalls?: number; reviewDatabase?: string } = {}) {
  const app = express();
  const workspace = new DemoWorkspace();
  app.disable("x-powered-by");
  let reviewStore: ReviewStore | undefined;
  const reviews = () => reviewStore ??= new ReviewStore(options.reviewDatabase ?? options.env?.AI_REVIEW_DATABASE ?? process.env.AI_REVIEW_DATABASE ?? "./data/ai-followups.sqlite");
  app.locals.close = () => reviewStore?.close();
  let busy = false, nextLiveAt = 0, liveCalls = 0;
  const cooldownMs = options.cooldownMs ?? 15000;
  const maxLiveCalls = options.maxLiveCalls ?? 10;
  app.use((req, res, next) => {
    const localPort = req.socket.localPort;
    const allowedHosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) { res.sendStatus(403); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    if (req.method === "POST" && (!req.headers.origin || !allowedHosts.some(host => req.headers.origin === `http://${host}`))) { res.sendStatus(403); return; }
    next();
  });
  app.get("/", (_req, res) => res.sendFile(fileURLToPath(new URL("./index.html", import.meta.url))));
  app.get("/review.js", (_req,res) => res.sendFile(fileURLToPath(new URL("./review.js",import.meta.url))));
  app.get("/interruptions.js", (_req,res) => res.sendFile(fileURLToPath(new URL("./interruptions.js",import.meta.url))));
  app.get("/discovery.js", (_req,res) => res.sendFile(fileURLToPath(new URL("./discovery-ui.js",import.meta.url))));
  app.get("/ai-panel.js", (_req,res) => res.sendFile(fileURLToPath(new URL("./ai-panel.js",import.meta.url))));
  app.get("/main.js", (_req, res) => res.sendFile(fileURLToPath(new URL("./main.js", import.meta.url))));
  app.get("/api/fixtures", (_req, res) => res.json({ fixtures: fixtures.map(({ id, description, job }) => ({ id, description, job })),
    liveCallsRemaining: Math.max(0, maxLiveCalls - liveCalls), nextLiveAt }));
  function withUsage<T>(fn: (tracker: UsageTracker) => T): T {
    const config = loadWorkerConfig(options.env);
    const tracker = new UsageTracker(config.usageDatabase, config.apiKey, config.localDailyRequestLimit);
    try { return fn(tracker); } finally { tracker.close(); }
  }
  app.get("/api/usage", (_req, res) => {
    try { res.json({ configured: true, ...withUsage(tracker => tracker.status()) }); }
    catch { res.json({ configured: false, message: "Configure Gemini credentials to enable usage tracking. Offline replay makes no API calls." }); }
  });
  app.use(express.json({ limit: "128kb", strict: true }));
  app.post("/api/usage/retry", (_req, res) => {
    try { withUsage(tracker => tracker.allowManualRetry()); res.json({ ok: true, message: "Local quota pause cleared. Google quota is unchanged; no provider call was made." }); }
    catch { res.status(503).json({ error: "Cannot access the local usage tracker." }); }
  });
  app.get("/api/reviews", (_req,res) => res.json({reviews:reviews().list()}));
  app.get("/api/reviews/:id", (req,res) => res.json(reviews().get(req.params.id)));
  app.get("/api/reviews/:id/export", (req,res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="approved-followups.json"');
    res.json(reviews().approvedExport(req.params.id));
  });
  app.post("/api/reviews/:id/proposals/:proposalId", (req,res) => res.json(reviews().update(req.params.id,req.params.proposalId,req.body)));
  app.get("/api/discovery/conversations", (_req,res) => res.json({conversations, fictional:true}));
  app.post("/api/discovery", async (req,res) => {
    const input=discoveryRequest.safeParse(req.body);
    if(!input.success){res.status(400).json({error:"Describe your work in 10–1000 characters."});return;}
    if(busy || Date.now()<nextLiveAt || liveCalls>=maxLiveCalls){res.status(429).json({error:"A request is active, cooling down, or the demo request budget is reached."});return;}
    busy=true;liveCalls++;nextLiveAt=Date.now()+cooldownMs;
    const controller=new AbortController();
    res.once("close",()=>{if(!res.writableEnded)controller.abort();});
    try {res.json(await discover(input.data.interest,{env:options.env,request:options.request,signal:controller.signal,mode:input.data.mode}));}
    catch(error){const code=(error as {code?:string}).code ?? (error instanceof Error && error.name==="TimeoutError"?"TIMEOUT":"INVALID_OUTPUT");res.status(503).json({error:code});}
    finally {busy=false;}
  });
  app.get("/api/workspace", (_req,res) => res.json({...workspace.snapshot(),conversations}));
  app.post("/api/workspace/review", (req,res) => res.json(workspace.apply(req.body)));
  app.post("/api/workspace/undo", (req,res) => {const input=z.strictObject({expectedRevision:z.number().int().nonnegative()}).parse(req.body);res.json(workspace.undo(input.expectedRevision));});
  app.post("/api/ai-panel", async(req,res)=>{
    const input=panelRequest.safeParse(req.body);
    if(!input.success){res.status(400).json({error:"Choose an implemented feature and describe your question in 10–1000 characters."});return;}
    const {prompt,feature,mode}=input.data;
    if(mode==="replay"&&(feature==="conversations"||feature==="helpers")){res.status(400).json({error:"Conversation and helper search require live Gemini. Dependency and overlap reference scenarios work offline."});return;}
    if(isKnowledgeFeature(feature)){try{validateWindow(input.data,feature);}catch(error){res.status(400).json({error:(error as Error).message});return;}}
    if(mode==="live"&&(busy||Date.now()<nextLiveAt||liveCalls>=maxLiveCalls)){res.status(429).json({error:"A request is active, cooling down, or the demo request budget is reached."});return;}
    if(mode==="live"){busy=true;liveCalls++;nextLiveAt=Date.now()+cooldownMs;}
    const controller=new AbortController();res.once("close",()=>{if(!res.writableEnded)controller.abort();});
    try{
      if(feature==="conversations"||feature==="helpers"){
        const result=await discover(prompt,{env:options.env,request:options.request,signal:controller.signal,mode:feature});res.json({feature,mode,result});return;
      }
      if(isKnowledgeFeature(feature)){
        const context=buildKnowledgeContext(feature,input.data,workspace.snapshot().tasks);
        const result=await answerKnowledge(prompt,feature,context,{mode,env:options.env,request:options.request,signal:controller.signal});
        res.json({feature,mode,...result,context,readOnly:true,fictional:true});return;
      }
      const snapshot=workspace.snapshot();
      const result=await analyzeCoordination(prompt,feature,snapshot.tasks,{mode,env:options.env,request:options.request,signal:controller.signal});
      const analysis=workspace.saveAnalysis(result.raw,feature,snapshot.revision);
      res.json({feature,...result,raw:undefined,analysis,workspace:workspace.snapshot()});
    }catch(error){
      if(error instanceof WorkspaceError){res.status(error.status).json({error:error.message});return;}
      const code=(error as {code?:string}).code??(error instanceof Error&&error.name==="TimeoutError"?"TIMEOUT":"INVALID_OUTPUT");res.status(503).json({error:code});
    }finally{if(mode==="live")busy=false;}
  });
  app.post("/api/run", async (req, res) => {
    const fixture = fixtures.find(f => f.id === req.body?.fixtureId);
    const mode = req.body?.mode;
    if (!fixture || !["replay", "live"].includes(mode)) { res.status(400).json({ error: "Choose a fixture and replay or live mode." }); return; }
    const parsed = aiWorkerJobSchema.safeParse(req.body.job ?? fixture.job);
    if (!parsed.success || parsed.data.kind !== "summarize" || !parsed.data.context) { res.status(400).json({ error: "Invalid summary job. Include participants, conversationStartedAt, timeZone, and segments." }); return; }
    const reviewerUserId = req.body.reviewerUserId ?? parsed.data.context.participants[0].userId;
    if(typeof reviewerUserId!=="string" || !parsed.data.readers.includes(reviewerUserId)) { res.status(400).json({error:"Choose a reviewer from the conversation participants."}); return; }
    if (mode === "live" && (busy || Date.now() < nextLiveAt || liveCalls >= maxLiveCalls)) {
      res.status(429).json({ error: liveCalls >= maxLiveCalls ? "Demo session request budget reached." : "A request is active or cooling down. Wait before running again.", nextLiveAt }); return;
    }
    if (mode === "live") { busy = true; liveCalls++; nextLiveAt = Date.now() + cooldownMs; }
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      const result = await runFixture(fixture, mode, { reviewerUserId, job: parsed.data, env: options.env, request: options.request, signal: controller.signal });
      if (result.error?.code === "QUOTA_EXCEEDED") nextLiveAt = Date.now() + Math.max(60000, (result.error.retryAfterSeconds ?? 0) * 1000);
      if(result.status==="success") reviews().create(result.followups);
      res.json({ ...result, liveCallsRemaining: Math.max(0, maxLiveCalls - liveCalls), nextLiveAt });
    } catch {
      res.status(400).json({ error: "Cannot run this job. Offline replay requires the original fixture; edited jobs require live mode." });
    } finally { if (mode === "live") busy = false; }
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if(error instanceof WorkspaceError){res.status(error.status).json({error:error.message});return;}
    if(error instanceof z.ZodError){res.status(400).json({error:"Invalid review request."});return;}
    if(error instanceof ReviewError) { res.status(error.code==="NOT_FOUND"?404:error.code==="CONFLICT"?409:400).json({error:error.message});return; }
    res.status(400).json({ error: "Invalid JSON or request exceeds 128 KB." });
  });
  return app;
}
