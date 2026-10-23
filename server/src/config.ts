import { resolve } from "node:path";
import { z } from "zod";

const url = (protocols: string[]) => z.string().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash && !parsed.search;
  } catch { return false; }
});
const httpUrl = url(["http:", "https:"]);
const envSchema = z.object({
  AI_ENABLED: z.enum(["true", "false"]).default("false"),
  AI_WORKER_SECRET: z.string().min(32).max(1024).optional(),
  AI_MAX_DURATION_SECONDS: z.coerce.number().int().min(10).max(3600).default(600),
  AI_MAX_TRANSCRIPT_CHARS: z.coerce.number().int().min(1000).max(500000).default(100000),
  AI_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(10).default(2),
  PORT: z.coerce.number().int().min(1).max(65535).default(2567),
  PUBLIC_SERVER_URL: httpUrl,
  ALLOWED_ORIGINS: z.string().min(1).transform((value) => value.split(",").map((origin) => origin.trim())).pipe(z.array(httpUrl.refine((origin) => { try { return new URL(origin).origin === origin; } catch { return false; } })).min(1)),
  SESSION_SECRET: z.string().min(32).max(1024),
  DATABASE_URL: z.string().min(1).default("./data/office.sqlite"),
  GUEST_INVITE_CODE: z.string().min(8).max(256),
  OFFICE_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default("demo-office"),
  LIVEKIT_INTERNAL_URL: httpUrl,
  LIVEKIT_PUBLIC_URL: url(["ws:", "wss:"]),
  LIVEKIT_API_KEY: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
  LIVEKIT_API_SECRET: z.string().min(32).max(1024),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Only field names: never include secret values or the full environment.
    throw new Error(`Invalid configuration: ${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`);
  }
  const e = result.data;
  if (e.AI_ENABLED === "true" && !e.AI_WORKER_SECRET) throw new Error("Invalid configuration: AI_WORKER_SECRET required when AI_ENABLED=true");
  if (e.AI_WORKER_SECRET && [e.SESSION_SECRET, e.LIVEKIT_API_SECRET].includes(e.AI_WORKER_SECRET)) throw new Error("Invalid configuration: AI_WORKER_SECRET must be distinct");
  if (e.DATABASE_URL.includes("://")) throw new Error("Invalid configuration: DATABASE_URL must be a SQLite file path");
  return {
    aiEnabled: e.AI_ENABLED === "true", aiWorkerSecret: e.AI_WORKER_SECRET,
    aiMaxDurationSeconds: e.AI_MAX_DURATION_SECONDS, aiMaxTranscriptChars: e.AI_MAX_TRANSCRIPT_CHARS,
    aiMaxConcurrentSessions: e.AI_MAX_CONCURRENT_SESSIONS,
    port: e.PORT, publicServerUrl: e.PUBLIC_SERVER_URL, allowedOrigins: e.ALLOWED_ORIGINS,
    sessionSecret: e.SESSION_SECRET, databasePath: e.DATABASE_URL === ":memory:" ? ":memory:" : resolve(e.DATABASE_URL),
    inviteCode: e.GUEST_INVITE_CODE, officeId: e.OFFICE_ID,
    livekitInternalUrl: e.LIVEKIT_INTERNAL_URL, livekitPublicUrl: e.LIVEKIT_PUBLIC_URL,
    livekitApiKey: e.LIVEKIT_API_KEY, livekitApiSecret: e.LIVEKIT_API_SECRET,
  };
}
export type Config = ReturnType<typeof loadConfig>;
