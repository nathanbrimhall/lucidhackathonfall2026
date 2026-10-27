import { z } from "zod";
const environment = z.object({
  AI_USAGE_DATABASE: z.string().min(1).default("./data/ai-usage.sqlite"),
  AI_LOCAL_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).max(10000).default(20),
  AI_GEMINI_OUTPUT_MODE: z.enum(["schema", "json"]).default("json"),
  AI_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
  AI_SERVER_URL: z.url().default("http://localhost:2567"),
  AI_WORKER_SECRET: z.string().min(32),
  OPENAI_API_KEY: z.string().optional(), GEMINI_API_KEY: z.string().optional(),
  AI_PROVIDER_BASE_URL: z.url().optional(),
  AI_TRANSCRIPTION_MODEL: z.string().min(1).optional(),
  AI_SUMMARY_MODEL: z.string().min(1).optional(),
  AI_CHUNK_SECONDS: z.coerce.number().int().min(1).max(20).default(10),
  AI_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  AI_MAX_TRANSCRIPT_CHARS: z.coerce.number().int().min(1_000).max(1_000_000).default(100_000),
});
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = environment.parse(Object.fromEntries(Object.entries(env).filter(([key, val]) => !(key.startsWith("AI_") && val === ""))));
  const gemini = value.AI_PROVIDER === "gemini";
  const apiKey = (gemini ? value.GEMINI_API_KEY : value.OPENAI_API_KEY)?.trim();
  if (!apiKey) throw new Error(gemini ? "GEMINI_API_KEY is required" : "OPENAI_API_KEY is required");
  const baseUrl = value.AI_PROVIDER_BASE_URL ?? (gemini ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1");
  for (const url of [value.AI_SERVER_URL, baseUrl]) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error("Invalid worker HTTP(S) URL");
  }
  if (gemini && baseUrl.replace(/\/$/, "") !== "https://generativelanguage.googleapis.com/v1beta") throw new Error("Gemini requires the Google API endpoint");
  return {
    usageDatabase: value.AI_USAGE_DATABASE, localDailyRequestLimit: value.AI_LOCAL_DAILY_REQUEST_LIMIT,
    provider: value.AI_PROVIDER, geminiOutputMode: value.AI_GEMINI_OUTPUT_MODE,
    serverUrl: value.AI_SERVER_URL.replace(/\/$/, ""), secret: value.AI_WORKER_SECRET,
    apiKey, providerBaseUrl: baseUrl.replace(/\/$/, ""),
    transcriptionModel: value.AI_TRANSCRIPTION_MODEL ?? (gemini ? "gemini-3.5-flash-lite" : "gpt-4o-mini-transcribe"),
    summaryModel: value.AI_SUMMARY_MODEL ?? (gemini ? "gemini-3.6-flash" : "gpt-4o-mini"),
    chunkSeconds: value.AI_CHUNK_SECONDS, providerTimeoutMs: value.AI_PROVIDER_TIMEOUT_MS,
    maxTranscriptChars: value.AI_MAX_TRANSCRIPT_CHARS,
  };
}
export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
