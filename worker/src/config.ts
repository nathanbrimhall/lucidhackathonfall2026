import { z } from "zod";

const environment = z.object({
  AI_SERVER_URL: z.url().default("http://localhost:2567"),
  AI_WORKER_SECRET: z.string().min(32),
  OPENAI_API_KEY: z.string().min(1),
  AI_PROVIDER_BASE_URL: z.url().default("https://api.openai.com/v1"),
  AI_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-mini-transcribe"),
  AI_SUMMARY_MODEL: z.string().min(1).default("gpt-4o-mini"),
  AI_CHUNK_SECONDS: z.coerce.number().int().min(1).max(20).default(10),
  AI_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  AI_MAX_TRANSCRIPT_CHARS: z.coerce.number().int().min(1_000).max(1_000_000).default(100_000),
});
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = environment.parse(env);
  for (const url of [value.AI_SERVER_URL, value.AI_PROVIDER_BASE_URL]) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error("Invalid worker HTTP(S) URL");
  }
  return {
    serverUrl: value.AI_SERVER_URL.replace(/\/$/, ""), secret: value.AI_WORKER_SECRET,
    apiKey: value.OPENAI_API_KEY, providerBaseUrl: value.AI_PROVIDER_BASE_URL.replace(/\/$/, ""),
    transcriptionModel: value.AI_TRANSCRIPTION_MODEL, summaryModel: value.AI_SUMMARY_MODEL,
    chunkSeconds: value.AI_CHUNK_SECONDS, providerTimeoutMs: value.AI_PROVIDER_TIMEOUT_MS,
    maxTranscriptChars: value.AI_MAX_TRANSCRIPT_CHARS,
  };
}
export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
