import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixtures } from "./fixtures.js";
import { runFixture, summarizeResults, type FixtureResult } from "./runner.js";
const args = process.argv.slice(2);
const mode = args.includes("--live") ? "live" : "replay";
const caseId = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
if (caseId && !fixtures.some(f => f.id === caseId)) throw new Error("Unknown fixture. Choose: " + fixtures.map(f => f.id).join(", "));
const selected = caseId ? fixtures.filter(f => f.id === caseId) : mode === "live" && !args.includes("--all") ? fixtures.slice(0, 1) : fixtures;
const repeat = args.includes("--repeat") ? Number(args[args.indexOf("--repeat") + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("--repeat must be 1, 2, or 3");
const queue = Array.from({ length: repeat }, () => selected).flat();
if (mode === "live" && queue.length > 10) throw new Error("This free-tier runner permits at most 10 live calls per invocation. Select a case when repeating.");
const results: FixtureResult[] = [];
for (const fixture of queue) {
  if (mode === "live" && results.length) await new Promise(resolve => setTimeout(resolve, 15000));
  const result = await runFixture(fixture, mode);
  results.push(result);
  console.log(JSON.stringify({ fixture: fixture.id, status: result.status, latencyMs: result.latencyMs, metrics: result.metrics, noteCoverage: result.noteCoverage, error: result.error }));
  if (mode === "live" && result.status === "failed") break; // Fail fast; never spend quota on a broken provider configuration.
}
const directory = resolve("data/ai-eval");
await mkdir(directory, { recursive: true });
const path = resolve(directory, `${mode}-${Date.now()}.json`);
const summary = summarizeResults(results);
const report = { plannedRuns: queue.length, skippedRuns: queue.length-results.length, summary, results };
await writeFile(path, JSON.stringify(report, null, 2));
await writeFile(resolve(directory, `latest-${mode}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: path, summary }, null, 2));
if (summary.failures || summary.missedActions || summary.inventedActions || summary.ownershipErrors || summary.deadlineErrors || summary.missingNoteFacts) process.exitCode = 1;
