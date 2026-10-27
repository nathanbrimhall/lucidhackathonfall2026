import { createFollowups } from "../../worker/src/followups.js";
import { createHash } from "node:crypto";
import { UsageTracker, UsageLimitError } from "../../worker/src/usage.js";
import { performance } from "node:perf_hooks";
import { aiWorkerJobSchema, type AiSummaryJob } from "../../shared/src/ai-worker.js";
import { createProviders, ProviderError, validateNotes, type ProviderUsage } from "../../worker/src/providers.js";
import { loadWorkerConfig } from "../../worker/src/config.js";
import { EXTRACTION_PROMPT_VERSION } from "../../worker/src/extraction-prompt.js";
import type { Fixture } from "./fixtures.js";
import { scoreActions, scoreNoteCoverage } from "./scoring.js";
export type RunMode = "replay" | "live";
export async function runFixture(fixture: Fixture, mode: RunMode, overrides: { reviewerUserId?: string; job?: AiSummaryJob; request?: typeof fetch; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  const started = performance.now();
  const usage: ProviderUsage[] = [];
  let tracker: UsageTracker | undefined;
  let model: string | null = null;
  let outputMode: string | null = null;
  const job = aiWorkerJobSchema.parse(overrides.job ?? fixture.job);
  if (job.kind !== "summarize" || !job.context) throw new Error("A summary job with participant/time context is required");
  const original = JSON.stringify(job) === JSON.stringify(fixture.job);
  if (mode === "replay" && !original) throw new Error("Replay only supports the original fixture; select live for an edited transcript");
  try {
    let notes;
    if (mode === "replay") notes = validateNotes(fixture.reference, job);
    else {
      const config = loadWorkerConfig(overrides.env);
      if (config.provider !== "gemini") throw new Error("This demo only permits Gemini. Set AI_PROVIDER=gemini.");
      model = config.summaryModel; outputMode = config.geminiOutputMode;
      if (!overrides.request) tracker = new UsageTracker(config.usageDatabase, config.apiKey, config.localDailyRequestLimit);
      notes = await createProviders(config, overrides.request ?? fetch, { usageTracker: tracker, onUsage: item => usage.push(item) }).summarize(job, overrides.signal ?? new AbortController().signal);
    }
    return { ...metadata(), status: "success" as const, notes, followups: createFollowups(job, notes, overrides.reviewerUserId ?? job.context.participants[0].userId), metrics: original ? scoreActions(notes, fixture.expected) : null, noteCoverage: original && fixture.noteFacts ? scoreNoteCoverage(notes, fixture.noteFacts) : null, error: null };
  } catch (error) {
    return { ...metadata(), status: "failed" as const, notes: null, followups: null, metrics: null, noteCoverage: null,
      error: error instanceof UsageLimitError ? { code: error.code, httpStatus: null, retryAfterSeconds: error.retryAfterSeconds ?? null } : error instanceof ProviderError ? { code: error.code, httpStatus: error.status ?? null, retryAfterSeconds: error.retryAfterSeconds ?? null } : { code: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? error.name : error instanceof SyntaxError || (error instanceof Error && error.name === "ZodError") ? "INVALID_OUTPUT" : "INVALID_OUTPUT_OR_REQUEST", httpStatus: null, retryAfterSeconds: null } };
  }
  finally { tracker?.close(); }
  function metadata() {
    return { fixtureId: fixture.id, mode, model, outputMode, promptVersion: EXTRACTION_PROMPT_VERSION, inputSha256: createHash("sha256").update(JSON.stringify(job)).digest("hex"), timestamp: new Date().toISOString(), latencyMs: Math.round(performance.now() - started),
      usage, cost: { estimatedUsd: 0, basis: mode === "replay" ? "offline-no-provider-call" : "user-reported-Gemini-free-tier", billingVerified: false },
      hasGroundTruth: original, scoringMethod: "fixture-terms-and-evidence-v1", replayIsModelEvaluation: false };
  }
}
export type FixtureResult = Awaited<ReturnType<typeof runFixture>>;
export function summarizeResults(results: FixtureResult[]) {
  const latencies = results.map(r => r.latencyMs).sort((a,b) => a-b);
  const evaluated = results.filter(r => r.status === "success" && r.metrics !== null);
  return { runs: results.length, failures: results.filter(r => r.status === "failed").length, evaluatedRuns: evaluated.length,
    missedActions: evaluated.reduce((n, r) => n + r.metrics!.missedActions.length, 0),
    inventedActions: evaluated.reduce((n, r) => n + r.metrics!.inventedActions.length, 0),
    ownershipErrors: evaluated.reduce((n, r) => n + r.metrics!.ownershipErrors, 0),
    deadlineErrors: evaluated.reduce((n, r) => n + r.metrics!.deadlineErrors, 0),
    missingNoteFacts: evaluated.reduce((n, r) => n + (r.noteCoverage?.missingFacts.length ?? 0), 0),
    averageLatencyMs: results.length ? Math.round(results.reduce((n, r) => n + r.latencyMs, 0) / results.length) : null,
    p95LatencyMs: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    inputTokens: results.reduce((n, r) => n + r.usage.reduce((total, u) => total + (u.inputTokens ?? 0), 0), 0),
    outputTokens: results.reduce((n, r) => n + r.usage.reduce((total, u) => total + (u.outputTokens ?? 0), 0), 0),
    totalTokens: results.reduce((n, r) => n + r.usage.reduce((total, u) => total + (u.totalTokens ?? 0), 0), 0),
    missingUsageRuns: results.filter(r => r.mode === "live" && (!r.usage.length || r.usage.some(u => u.totalTokens === null))).length,
    estimatedCostUsd: results.reduce((n, r) => n + r.cost.estimatedUsd, 0),
    liveModelEvaluated: evaluated.some(r => r.mode === "live"),
  };
}
