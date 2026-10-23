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
import { LiveKitService, MediaError } from "./services/LiveKitService.js";

export function createApplication(config: Config, roomOptions: OfficeRoomOptions = {}, media = new LiveKitService(config)) {
  const map = loadOfficeMap();
  const storage = openStorage(config.databasePath);
  const auth = new AuthService(storage, config);
  const offices = new OfficeRegistry();
  const httpServer = createServer();
  let stopping = false;
  let mediaStatus: "unknown" | "up" | "down" = "unknown";
  let mediaTimer: NodeJS.Timeout | undefined;
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
    rooms: { [OFFICE_ROOM]: defineRoom(createOfficeRoom(auth, config.officeId, offices, map, roomOptions, media)) },
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
      app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && !config.allowedOrigins.includes(origin)) { res.status(403).json(errorBody("FORBIDDEN", "Origin is not allowed")); return; }
        if (origin) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.vary("Origin");
          res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
        res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", dependencies: { storage: ready ? "up" : "down", livekit: mediaStatus } });
      });
      // Fresh seats originate here; Colyseus reconnect accepts only its reserved secret token.
      app.use("/api", (req, res, next) => {
        if (stopping) { res.status(503).json(errorBody("UNAVAILABLE", "Server is shutting down")); return; }
        const now = Date.now();
        for (const [key, window] of rateWindows) if (window.expires <= now) rateWindows.delete(key);
        const key = req.socket.remoteAddress ?? "unknown";
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
      app.post("/api/sessions/guest", (req, res) => res.status(201).json(auth.createGuest(req.body)));
      app.post("/api/media/token", async (req, res) => {
        const identity = auth.authenticate(bearer(req.headers.authorization));
        const parsed = mediaTokenSchema.safeParse(req.body);
        if (!parsed.success) throw new AuthError("INVALID_INPUT", "Expected {sessionId}");
        res.json(await media.issueToken(identity.userId, parsed.data.sessionId));
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
      const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
        if (error instanceof MediaError) {
          const status = { INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, UNAVAILABLE: 503 }[error.code];
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
    async start(port = config.port) {
      await server.listen(port, "0.0.0.0");
      void checkMedia();
      mediaTimer = setInterval(() => void checkMedia(), 10_000);
      mediaTimer.unref();
      const address = httpServer.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      if (mediaTimer) clearInterval(mediaTimer);
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
