import { seedManualDemo } from "./domain/manual-demo.js";
import { z } from "zod";
import { CollaborationService, CollaborationError } from "./services/CollaborationService.js";
import { OfficeAssistant } from "./services/OfficeAssistant.js";
// Foundation adapted from create-colyseus-app 0.18.1's TypeScript minimal starter.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { defineServer, defineRoom, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express, { type ErrorRequestHandler } from "express";
import { OFFICE_ROOM, PROTOCOL_VERSION, type ErrorCode } from "../../shared/src/protocol.js";
import { joinOfficeSchema, mediaTokenSchema } from "../../shared/src/validation.js";
import { AuthError, AuthService } from "./auth/AuthService.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { openStorage } from "./repositories/Storage.js";
import { createOfficeRoom, type OfficeRoomOptions } from "./rooms/OfficeRoom.js";
import { OfficeRegistry, OfficeJoinError } from "./rooms/OfficeRegistry.js";
import { loadOfficeMap } from "./domain/map.js";
import { AIRepository } from "./repositories/AIRepository.js";
import { AISessionService, AIError } from "./services/AISessionService.js";
import { aiWorkerClaimSchema, aiWorkerLeaseSchema, aiWorkerSegmentsSchema, aiWorkerCompleteSchema, aiWorkerFailSchema } from "../../shared/src/ai-worker.js";
import { LiveKitService, MediaError } from "./services/LiveKitService.js";
import { ReminderRepository } from "./repositories/ReminderRepository.js";
import { ReminderService, ReminderError } from "./services/ReminderService.js";

export function createApplication(config: Config, roomOptions: OfficeRoomOptions = {}, media = new LiveKitService(config), integration: {assistantEnv?: NodeJS.ProcessEnv; assistantRequest?: typeof fetch; assistantCooldown?: number; manualDemo?: boolean} = {}) {
  if(integration.manualDemo&&config.databasePath!==":memory:")throw new Error("Manual demo requires an isolated in-memory database.");
  const map = loadOfficeMap(config.officeLayout);
  const storage = openStorage(config.databasePath);
  const auth = new AuthService(storage, config);
  const offices = new OfficeRegistry();
  const ai = new AISessionService(new AIRepository(storage), config, media);
  const collaboration = new CollaborationService(storage, ai.repo);
  const assistant = new OfficeAssistant(ai.repo,collaboration,integration.assistantEnv,integration.assistantRequest,integration.assistantCooldown);
  const reminders = new ReminderService(new ReminderRepository(storage));
  const demoUsers=integration.manualDemo?seedManualDemo(auth,ai.repo,collaboration,config):undefined;
  const httpServer = createServer();
  let stopping = false;
  let mediaStatus: "unknown" | "up" | "down" = "unknown";
  let mediaTimer: NodeJS.Timeout | undefined;
  let aiTimer: NodeJS.Timeout | undefined;
  let reminderTimer: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  const mediaAbort = new AbortController();
  const compiledHarness = fileURLToPath(new URL("../media-harness/", import.meta.url));
  const harnessPath = existsSync(compiledHarness) ? compiledHarness : fileURLToPath(new URL("../../dist/server/media-harness/", import.meta.url));
  const rateWindows = new Map<string, { count: number; expires: number }>();
  const errorBody = (code: ErrorCode, message: string) => ({ error: { code, message } });

  // Colyseus routes run before Express. Disable its public matchmaking methods
  // at the supported controller boundary; internal matchMaker calls still work.
  matchMaker.controller.exposedMethods = ["reconnect"];
  matchMaker.controller.getCorsHeaders = (headers) => ({
    "Access-Control-Allow-Origin": config.allowedOrigins.includes(headers.get("origin") ?? "") ? headers.get("origin")! : "null",
    "Access-Control-Allow-Credentials": "false",
    "Vary": "Origin",
  });

  const server = defineServer({
    greet: false,
    gracefullyShutdown: false,
    transport: new WebSocketTransport({
      server: httpServer,
      maxPayload: 4096,
      beforeUpgrade: (_request, context) => {
        const origin = context.headers.get("origin");
        if (stopping || (origin && !config.allowedOrigins.includes(origin))) return new Response(null, { status: 403 });
      },
    }),
    rooms: { [OFFICE_ROOM]: defineRoom(createOfficeRoom(auth, config.officeId, offices, map, roomOptions, media, ai, reminders)) },
    express: (app) => {
      app.disable("x-powered-by");
      // Verify the exact raw body. Service callbacks bypass browser-origin and
      // guest HTTP rate limits, but still have a bounded payload and signed auth.
      app.post("/api/livekit/webhook", express.text({ type: "application/webhook+json", limit: "64kb" }), async (req, res) => {
        if (stopping) { res.sendStatus(503); return; }
        if (!req.is("application/webhook+json") || typeof req.body !== "string") {
          res.status(400).json(errorBody("INVALID_INPUT", "Expected application/webhook+json")); return;
        }
        const event = await media.verifyWebhook(req.body, req.headers.authorization);
        await media.handleWebhook(event);
        res.sendStatus(204);
      });
      // Worker endpoints are authenticated separately and never use guest credentials.
      // They bypass browser CORS and the human request budget, but have strict bounded bodies.
      app.use("/internal/ai", (req, _res, next) => {
        if (stopping) throw new AIError("UNAVAILABLE");
        if (req.headers.origin) throw new AIError("FORBIDDEN");
        ai.authenticate(req.headers.authorization); next();
      }, express.json({limit:"2mb", strict:true}));
      app.post("/internal/ai/jobs/claim", async (req,res) => {
        if (!aiWorkerClaimSchema.safeParse(req.body).success) throw new AIError("INVALID_INPUT");
        res.json({job:await ai.claim()});
      });
      for (const operation of ["heartbeat","segments","complete","fail"] as const) {
        app.post(`/internal/ai/jobs/:id/${operation}`, (req,res) => {
          const schema = {heartbeat:aiWorkerLeaseSchema,segments:aiWorkerSegmentsSchema,complete:aiWorkerCompleteSchema,fail:aiWorkerFailSchema}[operation];
          const parsed = schema.safeParse(req.body);
          if (!parsed.success) throw new AIError("INVALID_INPUT","Invalid worker payload");
          const data = parsed.data;
          if (operation === "heartbeat") res.json(ai.heartbeat(req.params.id,data.leaseToken));
          else if (operation === "segments") { ai.segments(req.params.id,data.leaseToken,(data as import("zod").infer<typeof aiWorkerSegmentsSchema>).segments); res.json({accepted:true}); }
          else if (operation === "complete") res.json(ai.complete(req.params.id,data.leaseToken,(data as import("zod").infer<typeof aiWorkerCompleteSchema>).notes));
          else { ai.fail(req.params.id,data.leaseToken,(data as import("zod").infer<typeof aiWorkerFailSchema>).code); res.json({accepted:true}); }
        });
      }
      app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && !config.allowedOrigins.includes(origin)) { res.status(403).json(errorBody("FORBIDDEN", "Origin is not allowed")); return; }
        if (origin) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.vary("Origin");
          res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
        }
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "OPTIONS") { res.sendStatus(204); return; }
        next();
      });
      app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
      app.use("/media-harness", express.static(harnessPath, { index: "index.html" }));
      app.get("/readyz", (_req, res) => {
        let ready = false;
        try { ready = !stopping && storage.healthCheck(); } catch { /* storage unavailable */ }
        res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", dependencies: { storage: ready ? "up" : "down", livekit: mediaStatus, ai: ai.workerStatus() } });
      });
      // Fresh seats originate here; Colyseus reconnect accepts only its reserved secret token.
      app.use("/api", (req, res, next) => {
        if (stopping) { res.status(503).json(errorBody("UNAVAILABLE", "Server is shutting down")); return; }
        const now = Date.now();
        for (const [key, window] of rateWindows) if (window.expires <= now) rateWindows.delete(key);
        let key = "ip:"+(req.socket.remoteAddress ?? "unknown");
        if(req.headers.authorization){try{const identity=auth.authenticate(bearer(req.headers.authorization));key=`user:${identity.officeId}:${identity.userId}`;}catch{/* Invalid sessions stay in the anonymous IP budget. */}}
        const window = rateWindows.get(key) ?? { count: 0, expires: now + 60_000 };
        if (rateWindows.size >= 10_000 && !rateWindows.has(key)) { res.status(429).json(errorBody("RATE_LIMITED", "Retry later")); return; }
        rateWindows.set(key, window);
        if (++window.count > 60) {
          res.setHeader("Retry-After", Math.ceil((window.expires - now) / 1000));
          res.status(429).json(errorBody("RATE_LIMITED", "Retry later")); return;
        }
        next();
      });
      app.use(express.json({ limit: "4kb", strict: true }));
      app.get("/api/demo",(_req,res)=>res.json({enabled:!!demoUsers,users:demoUsers?.map(({userId,displayName})=>({userId,displayName}))??[]}));
      if(demoUsers)app.post("/api/demo/session",(req,res)=>{const input=z.strictObject({userId:z.string()}).parse(req.body);const user=demoUsers.find(p=>p.userId===input.userId);if(!user)throw new CollaborationError(404,"Demo identity not found.");res.json(user);});
      const who=(req:express.Request)=>auth.authenticate(bearer(req.headers.authorization));
      app.get("/api/collaboration",(req,res)=>{const identity=who(req);res.json({identity,directory:collaboration.directory(identity),profile:collaboration.profile(identity),tasks:collaboration.tasks(identity),messages:collaboration.messages(identity),notifications:collaboration.notices(identity),drafts:collaboration.drafts(identity),assistantConfigured:assistant.configured(),assistantUsage:assistant.usageStatus()});});
      app.patch("/api/collaboration/profile",(req,res)=>res.json(collaboration.updateProfile(who(req),req.body)));
      app.post("/api/collaboration/tasks",(req,res)=>res.status(201).json(collaboration.createTask(who(req),req.body)));
      app.patch("/api/collaboration/tasks/:id",(req,res)=>res.json(collaboration.updateTask(who(req),req.params.id,req.body)));
      app.post("/api/collaboration/tasks/:id/dependencies",(req,res)=>res.json(collaboration.dependency(who(req),req.params.id,req.body)));
      app.post("/api/collaboration/tasks/:id/link",(req,res)=>res.json(collaboration.link(who(req),req.params.id,req.body)));
      app.post("/api/collaboration/tasks/:id/dependencies/remove",(req,res)=>res.json(collaboration.removeDependency(who(req),req.params.id,req.body)));
      app.post("/api/collaboration/tasks/:id/unlink",(req,res)=>{const identity=who(req);const input=z.strictObject({revision:z.number().int().positive()}).parse(req.body);res.json(collaboration.unlink(identity,req.params.id,input.revision));});
      app.post("/api/collaboration/messages",(req,res)=>res.status(201).json(collaboration.send(who(req),req.body)));
      app.post("/api/collaboration/messages/:id/read",(req,res)=>res.json(collaboration.read(who(req),req.params.id,"message")));
      app.post("/api/collaboration/notifications/:id/read",(req,res)=>res.json(collaboration.read(who(req),req.params.id,"notice")));
      app.post("/api/collaboration/drafts",(req,res)=>res.status(201).json(collaboration.createDraft(who(req),req.body)));
      app.patch("/api/collaboration/drafts/:id",(req,res)=>res.json(collaboration.updateDraft(who(req),req.params.id,req.body)));
      app.post("/api/collaboration/drafts/:id/send",(req,res)=>{const identity=who(req);const input=z.strictObject({revision:z.number().int().positive()}).parse(req.body);res.json(collaboration.sendDraft(identity,req.params.id,input.revision));});
      app.post("/api/assistant",async(req,res)=>{const identity=who(req),controller=new AbortController();res.once("close",()=>{if(!res.writableEnded)controller.abort();});try{const result=await assistant.run(identity,req.body,controller.signal);who(req);res.json(result);}catch(error){if(error instanceof CollaborationError||error instanceof z.ZodError)throw error;const code=(error as {code?:string}).code;const quota=code?.includes("QUOTA")||code==="LOCAL_BUDGET_EXCEEDED";res.status(quota?429:503).json({error:{code:code??"UNAVAILABLE",message:quota?"The Gemini quota is used up for now. Ask again later; no changes were made.":code==="INVALID_OUTPUT"?"The assistant returned an answer that could not be checked against your sources. Try again; no changes were made.":"The AI provider is temporarily unavailable. Wait a moment and ask again; no changes were made."}});}});
      app.get("/api/reminders", (req, res) => {
        const identity = auth.authenticate(bearer(req.headers.authorization));
        if (req.query.before !== undefined && typeof req.query.before !== "string") throw new ReminderError("INVALID_INPUT", "Expected a reminder cursor");
        const page = reminders.list(identity.userId, identity.officeId, req.query.before);
        res.json({ reminders: page, nextCursor: page.length === 100 ? page.at(-1)!.id : null });
      });
      app.post("/api/reminders", (req, res) => {
        const identity = auth.authenticate(bearer(req.headers.authorization));
        res.status(201).json(reminders.create(identity.userId, identity.officeId, req.body));
      });
      app.patch("/api/reminders/:id", (req, res) => {
        const identity = auth.authenticate(bearer(req.headers.authorization));
        res.json(reminders.update(identity.userId, identity.officeId, req.params.id, req.body));
      });
      app.get("/api/notes", (req,res) => {
        const identity=auth.authenticate(bearer(req.headers.authorization));
        res.json({notes:ai.repo.notes(identity.userId,identity.officeId)});
      });
      app.get("/api/notes/:id", (req,res) => {
        const identity=auth.authenticate(bearer(req.headers.authorization));
        const note=ai.repo.note(req.params.id,identity.userId,identity.officeId);
        if(!note) throw new AIError("NOT_FOUND");
        res.json(note);
      });
      app.post("/api/sessions/guest", (req, res) => res.status(201).json(auth.createGuest(req.body)));
      app.post("/api/media/token", async (req, res) => {
        const identity = auth.authenticate(bearer(req.headers.authorization));
        const parsed = mediaTokenSchema.safeParse(req.body);
        if (!parsed.success) throw new AuthError("INVALID_INPUT", "Expected {sessionId, transitionRevision?}");
        res.json(await media.issueToken(identity.userId, parsed.data.sessionId, parsed.data.transitionRevision));
      });
      app.get("/api/sessions/current", (req, res) => res.json(auth.authenticate(bearer(req.headers.authorization))));
      app.get("/api/offices/:officeId/map", (req, res) => {
        const identity = auth.authenticate(bearer(req.headers.authorization));
        if (req.params.officeId !== identity.officeId) throw new AuthError("FORBIDDEN", "Office membership required");
        res.json(map);
      });
      app.post("/api/offices/:officeId/join", async (req, res) => {
        const token = bearer(req.headers.authorization);
        const identity = auth.authenticate(token);
        if (req.params.officeId !== identity.officeId) throw new AuthError("FORBIDDEN", "Office membership required");
        const parsed = joinOfficeSchema.safeParse(req.body);
        if (!parsed.success) throw new AuthError("INVALID_INPUT", `Expected protocolVersion ${PROTOCOL_VERSION}`);
        const seat = await offices.reserve(identity.userId, parsed.data, { token, headers: new Headers(), ip: req.socket.remoteAddress });
        res.json(seat);
      });
      const compiledFrontend=fileURLToPath(new URL("../frontend/",import.meta.url));
      const frontendPath=existsSync(compiledFrontend)?compiledFrontend:fileURLToPath(new URL("../../dist/server/frontend/",import.meta.url));
      app.use("/",express.static(frontendPath,{index:"index.html",setHeaders:res=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","same-origin");}}));
      const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
        if(error instanceof CollaborationError){res.status(error.status).json(errorBody(error.status===404?"NOT_FOUND":error.status===403?"FORBIDDEN":error.status===409?"CONFLICT":error.status===429?"RATE_LIMITED":"INVALID_INPUT",error.message));return;}
        if(error instanceof z.ZodError){res.status(400).json(errorBody("INVALID_INPUT","Invalid request fields."));return;}
        if (error instanceof ReminderError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 503;
          res.status(status).json(errorBody(error.code, error.message)); return;
        }
        if (error instanceof AIError) {
          const status = error.code === "INVALID_INPUT" ? 400 : error.code === "UNAUTHORIZED" ? 401 : error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : error.code === "STALE_CONSENT" ? 409 : 503;
          res.status(status).json(errorBody(error.code,error.message)); return;
        }
        if (error instanceof MediaError) {
          const status = { INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, UNAVAILABLE: 503, STALE_TRANSITION: 409, TRANSITION_PENDING: 409 }[error.code];
          res.status(status).json(errorBody(error.code, error.message)); return;
        }
        if (error instanceof OfficeJoinError) {
          res.status(409).json(errorBody(error.code, error.message)); return;
        }
        if (error instanceof AuthError) {
          const status = { INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403 }[error.code];
          res.status(status).json(errorBody(error.code, error.message)); return;
        }
        if (error?.type === "entity.too.large" || error?.type === "entity.parse.failed") {
          res.status(error.type === "entity.too.large" ? 413 : 400).json(errorBody("INVALID_INPUT", "Invalid JSON body or request exceeds the route's size limit")); return;
        }
        log("request.failed");
        res.status(500).json(errorBody("INTERNAL_ERROR", "Request failed"));
      };
      app.use(handleError);
    },
  });

  async function checkMedia() {
    try {
      const response = await fetch(config.livekitInternalUrl, { signal: AbortSignal.any([mediaAbort.signal, AbortSignal.timeout(1500)]) });
      mediaStatus = response.ok ? "up" : "down";
      await response.body?.cancel();
    } catch { mediaStatus = "down"; }
  }

  return {
    server,
    async start(port = config.port, host = "0.0.0.0") {
      if(integration.manualDemo&&host!=="127.0.0.1")throw new Error("Manual demo must bind only to loopback.");
      await server.listen(port, host);
      aiTimer = setInterval(() => { try { ai.tick(); } catch { log("ai.maintenance.failed"); } }, 1000);
      aiTimer.unref();
      const scheduleReminders = () => { try { reminders.tick(); } catch { log("reminders.maintenance.failed"); } };
      scheduleReminders();
      reminderTimer = setInterval(scheduleReminders, 1000);
      reminderTimer.unref();
      void checkMedia();
      mediaTimer = setInterval(() => void checkMedia(), 10_000);
      mediaTimer.unref();
      // Startup reconciliation removes orphaned media rooms from a previous process.
      const reconcile = () => void media.reconcile().catch(() => log("media.reconcile.failed"));
      reconcile();
      reconcileTimer = setInterval(reconcile, 30_000);
      reconcileTimer.unref();
      const address = httpServer.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      if (aiTimer) clearInterval(aiTimer);
      if (reminderTimer) clearInterval(reminderTimer);
      reminders.shutdown();
      ai.shutdown();
      if (mediaTimer) clearInterval(mediaTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      mediaAbort.abort();
      try { await server.gracefullyShutdown(false); }
      finally {
        try { await media.dispose(); } catch { log("media.cleanup.failed"); }
        storage.close();
      }
    },
  };
}

function bearer(header: string | undefined): string {
  if (!header?.startsWith("Bearer ") || header.length > 2055) throw new AuthError("UNAUTHORIZED", "Bearer session required");
  return header.slice(7);
}
