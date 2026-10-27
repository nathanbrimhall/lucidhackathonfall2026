import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export interface UsageTokens { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
export class UsageLimitError extends Error {
  constructor(readonly code: "QUOTA_PAUSED" | "LOCAL_BUDGET_EXCEEDED", readonly retryAfterSeconds?: number) { super(code); }
}
/** Local request accounting only: no keys, transcripts, prompts, or provider bodies are stored. */
export class UsageTracker {
  private readonly db: Database.Database;
  private readonly credential: string;
  constructor(path: string, apiKey: string, readonly dailyRequestLimit = 20, private readonly now = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.credential = createHash("sha256").update(apiKey).digest("hex");
    this.db = new Database(path);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS usage_requests (
      id TEXT PRIMARY KEY, credential TEXT NOT NULL, started_at INTEGER NOT NULL, model TEXT NOT NULL,
      operation TEXT NOT NULL, outcome TEXT NOT NULL, code TEXT, http_status INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER
    ); CREATE INDEX IF NOT EXISTS usage_credential_time ON usage_requests(credential, started_at);
    CREATE TABLE IF NOT EXISTS usage_blocks (credential TEXT PRIMARY KEY, model TEXT NOT NULL, observed_at INTEGER NOT NULL, blocked_until INTEGER);`);
  }
  reserve(model: string, operation: string): string {
    return this.db.transaction(() => {
      const state = this.status();
      if (state.quotaPaused) throw new UsageLimitError("QUOTA_PAUSED", state.blockedUntil ? Math.max(0, Math.ceil((state.blockedUntil-this.now())/1000)) : undefined);
      if (state.today.attempts >= this.dailyRequestLimit) throw new UsageLimitError("LOCAL_BUDGET_EXCEEDED");
      const id = randomUUID();
      this.db.prepare("INSERT INTO usage_requests(id,credential,started_at,model,operation,outcome) VALUES (?,?,?,?,?,'started')").run(id,this.credential,this.now(),model,operation);
      return id;
    }).immediate();
  }
  finish(id: string, result: { code?: string; httpStatus?: number; retryAfterSeconds?: number; usage?: UsageTokens }) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE usage_requests SET outcome=?,code=?,http_status=?,input_tokens=?,output_tokens=?,total_tokens=? WHERE id=? AND credential=?")
        .run(result.code ? "error" : "response_received", result.code ?? null, result.httpStatus ?? null,
          result.usage?.inputTokens ?? null, result.usage?.outputTokens ?? null, result.usage?.totalTokens ?? null, id, this.credential);
      if (result.code === "QUOTA_EXCEEDED") {
        const retry = result.retryAfterSeconds;
        const until = retry !== undefined && Number.isFinite(retry) && retry > 0 ? this.now()+Math.ceil(retry*1000) : null;
        this.db.prepare("INSERT OR REPLACE INTO usage_blocks VALUES (?,?,?,?)").run(this.credential,this.modelFor(id),this.now(),until);
      }
    }).immediate();
  }
  private modelFor(id: string): string { return (this.db.prepare("SELECT model FROM usage_requests WHERE id=?").get(id) as { model: string }).model; }
  status() {
    const day = new Date(this.now()).toISOString().slice(0,10);
    const midnight = Date.parse(day+"T00:00:00Z");
    const block = this.db.prepare("SELECT model,observed_at AS observedAt,blocked_until AS blockedUntil FROM usage_blocks WHERE credential=?").get(this.credential) as { model: string; observedAt: number; blockedUntil: number | null } | undefined;
    const tally = (since: number) => this.db.prepare(`SELECT count(*) AS attempts,
      coalesce(sum(outcome='response_received'),0) AS responsesReceived,
      coalesce(sum(outcome='error'),0) AS requestErrors, coalesce(sum(outcome='started'),0) AS unfinishedRequests,
      coalesce(sum(code='QUOTA_EXCEEDED'),0) AS quotaErrors,
      coalesce(sum(input_tokens),0) AS inputTokens,coalesce(sum(output_tokens),0) AS outputTokens,coalesce(sum(total_tokens),0) AS totalTokens,
      coalesce(sum(total_tokens IS NULL),0) AS requestsWithUnknownTokens FROM usage_requests WHERE credential=? AND started_at>=?`).get(this.credential,since) as { attempts: number; responsesReceived: number; requestErrors: number; unfinishedRequests: number; quotaErrors: number; inputTokens: number; outputTokens: number; totalTokens: number; requestsWithUnknownTokens: number };
    const today = tally(midnight);
    const lastError = this.db.prepare("SELECT code,http_status AS httpStatus,started_at AS timestamp,model FROM usage_requests WHERE credential=? AND outcome='error' ORDER BY started_at DESC,rowid DESC LIMIT 1").get(this.credential) ?? null;
    return { scope: "requests tracked by this project for the current credential; other apps and earlier untracked calls are excluded", localDayUtc: day,
      today, lifetime: tally(0), localDailyRequestLimit: this.dailyRequestLimit,
      localRequestsRemaining: Math.max(0,this.dailyRequestLimit-today.attempts), providerRequestsRemaining: null,
      quotaPaused: Boolean(block && (block.blockedUntil === null || block.blockedUntil > this.now())),
      quotaObservedAt: block?.observedAt ?? null, quotaModel: block?.model ?? null, blockedUntil: block?.blockedUntil ?? null,
      providerRetryAfterKnown: Boolean(block?.blockedUntil), lastError, quotaDashboard: "https://aistudio.google.com/usage" };
  }
  /** Clears only our circuit breaker. It cannot reset or increase Google's quota. */
  allowManualRetry() { this.db.prepare("DELETE FROM usage_blocks WHERE credential=?").run(this.credential); }
  close() { this.db.close(); }
}
