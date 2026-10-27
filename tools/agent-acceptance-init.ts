/**
 * Fill ONLY machine-observable fields of an M5/M6 acceptance record. Never writes human attestations
 * (participants, scenarios, goal/question/answer/brief, joinInstructions, mode/provider/model, performedAt).
 *   init  <out.json> --office-url <https> --livekit-url <wss> --scope lan|public [--usage-db <path>]
 *   usage <out.json> [--usage-db <path>]
 */
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { expectedUrl } from './agent-acceptance-check.js';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Same pin as agent-worker/src/hermes.ts HERMES_COMMIT (the adapter refuses any other checkout). Duplicated to avoid importing the worker stack.
export const HERMES_PIN = '74885f997bece88c1393bd174b25b32338336cb6';

export type MachineFacts = {
  gitRevision: string | null; serverVersion: string | null;
  runtimeName: string | null; runtimeRevision: string | null;
};
export type InitOptions = { officeUrl: string; livekitUrl: string; scope: 'lan' | 'public' };

/** Runtime identity only when AGENT_RUNTIME is explicitly configured; no defaults are assumed. */
export function runtimeFromEnv(env: Record<string, string | undefined>): { name: string | null; revision: string | null } {
  const name = env.AGENT_RUNTIME?.trim();
  if (name === 'hermes') return { name, revision: HERMES_PIN };
  if (name === 'gemini' || name === 'fixture') return { name, revision: null };
  return { name: null, revision: null };
}

/** Pure: copy the template and set only the allowed machine-observable fields. */
export function buildInitialRecord(template: unknown, options: InitOptions, facts: MachineFacts): unknown {
  const record = structuredClone(template) as { deployment: Record<string, unknown>; rehearsal: Record<string, unknown> & { runtime: Record<string, unknown> } };
  if (options.scope !== 'lan' && options.scope !== 'public') throw new Error('--scope must be lan or public.');
  if (!expectedUrl(options.officeUrl, 'https:', options.scope)) throw new Error(`--office-url must be an https ${options.scope} origin without credentials, path, query or fragment.`);
  if (!expectedUrl(options.livekitUrl, 'wss:', options.scope)) throw new Error(`--livekit-url must be a wss ${options.scope} origin without credentials, path, query or fragment.`);
  record.deployment.networkScope = options.scope;
  record.deployment.officeUrl = options.officeUrl;
  record.deployment.livekitUrl = options.livekitUrl;
  record.rehearsal.gitRevision = facts.gitRevision;
  record.rehearsal.serverVersion = facts.serverVersion;
  record.rehearsal.runtime.name = facts.runtimeName;
  record.rehearsal.runtime.revision = facts.runtimeRevision;
  return record;
}

export type UsageBaseline = { schemaVersion: 1; database: string; count: number; recordedAt: string; recordedAtMs: number };
export type UsageReading = { total: number; sinceMs: number };

/** Read-only view of the shared ledger (worker/src/usage.ts usage_requests), across all credentials. */
export function readUsage(database: string, sinceMs: number): UsageReading | { error: string } {
  try {
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      const total = (db.prepare('SELECT count(*) AS n FROM usage_requests').get() as { n: number }).n;
      const since = (db.prepare('SELECT count(*) AS n FROM usage_requests WHERE started_at >= ?').get(sinceMs) as { n: number }).n;
      return { total, sinceMs: since };
    } finally { db.close(); }
  } catch (error) { return { error: error instanceof Error ? error.message : 'unreadable' }; }
}

/** Pure: decide modelCalls from a baseline and current reading. Null plus a reason unless trustworthy. */
export function computeModelCalls(baseline: UsageBaseline, now: UsageReading | { error: string }): { modelCalls: number | null; message: string } {
  if ('error' in now) return { modelCalls: null, message: `Usage counter could not be read (${now.error}); modelCalls left null.` };
  const delta = now.total - baseline.count;
  if (delta < 0) return { modelCalls: null, message: `Usage ledger shrank (${baseline.count} -> ${now.total}); it was reset or replaced. modelCalls left null.` };
  if (delta !== now.sinceMs) {
    return { modelCalls: null, message: `Ledger delta (${delta}) disagrees with rows started since the baseline (${now.sinceMs}); the ledger was altered or the clock moved. modelCalls left null.` };
  }
  return { modelCalls: delta, message: `${delta} provider call(s) in the shared ledger since ${baseline.recordedAt}.` };
}

const usageCaveat = [
  'Caveat: this counts ALL rows the shared tracker logged to the usage database (any credential, any app: agent worker, transcription worker, AI demo)',
  'between the baseline and now, so keep other AI use off that database during the rehearsal. Calls made outside the tracker are not counted.',
  'The ledger is lifetime, so the UTC daily rollover of the office\'s "today" counter does not affect this delta; a replaced/deleted/reset database does, and then the field stays null.',
].join('\n');

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value.`);
  return args[index + 1];
}
async function exists(path: string): Promise<boolean> { return access(path).then(() => true, () => false); }
async function git(...args: string[]): Promise<string | null> {
  try { return (await exec('git', ['-C', root, ...args], { timeout: 10_000 })).stdout.trim(); } catch { return null; }
}
async function gatherFacts(env: Record<string, string | undefined>): Promise<MachineFacts> {
  const head = await git('rev-parse', 'HEAD');
  const status = head ? await git('status', '--porcelain') : null;
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version?: unknown };
  const runtime = runtimeFromEnv(env);
  return {
    gitRevision: head && /^[0-9a-f]{40}$/.test(head) && status !== null ? `${head}${status ? '-dirty' : ''}` : null,
    serverVersion: typeof pkg.version === 'string' && pkg.version ? pkg.version : null,
    runtimeName: runtime.name, runtimeRevision: runtime.revision,
  };
}
function usagePath(args: string[], env: Record<string, string | undefined>): string {
  const raw = option(args, '--usage-db') ?? env.AI_USAGE_DATABASE ?? './data/ai-usage.sqlite';
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

async function init(args: string[], env: Record<string, string | undefined>): Promise<void> {
  const out = args[0];
  if (!out || out.startsWith('--')) throw new Error('Usage: agent-acceptance-init init <out.json> --office-url <https> --livekit-url <wss> --scope lan|public');
  const sidecar = `${out}.usage-baseline.json`;
  if (await exists(out) || await exists(sidecar)) throw new Error(`Refusing to overwrite existing ${await exists(out) ? out : sidecar}.`);
  const template = JSON.parse(await readFile(resolve(root, 'docs/agent-acceptance-template.json'), 'utf8')) as unknown;
  const record = buildInitialRecord(template, {
    officeUrl: option(args, '--office-url') ?? '', livekitUrl: option(args, '--livekit-url') ?? '', scope: option(args, '--scope') as 'lan' | 'public',
  }, await gatherFacts(env));
  const database = usagePath(args, env);
  const nowMs = Date.now();
  const reading = readUsage(database, nowMs);
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  console.log(`Created ${out} (machine-observable fields only; all human attestations remain at template values).`);
  const r = (record as { rehearsal: { gitRevision: unknown; serverVersion: unknown; runtime: { name: unknown; revision: unknown } } }).rehearsal;
  console.log(`gitRevision=${String(r.gitRevision)} serverVersion=${String(r.serverVersion)} runtime=${String(r.runtime.name)}@${String(r.runtime.revision)}`);
  if ('error' in reading) {
    console.log(`No usage baseline written: ${reading.error}. Set AI_USAGE_DATABASE/--usage-db to the shared ledger (it must already exist) and re-init, or enter modelCalls by hand.`);
    return;
  }
  const baseline: UsageBaseline = { schemaVersion: 1, database, count: reading.total, recordedAt: new Date(nowMs).toISOString(), recordedAtMs: nowMs };
  await writeFile(sidecar, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  console.log(`Usage baseline ${reading.total} recorded in ${sidecar}.`);
}

async function usage(args: string[], env: Record<string, string | undefined>): Promise<void> {
  const file = args[0];
  if (!file || file.startsWith('--')) throw new Error('Usage: agent-acceptance-init usage <record.json> [--usage-db <path>]');
  const baseline = JSON.parse(await readFile(`${file}.usage-baseline.json`, 'utf8')) as UsageBaseline;
  const database = option(args, '--usage-db') ? usagePath(args, env) : baseline.database;
  const { modelCalls, message } = computeModelCalls(baseline, readUsage(database, baseline.recordedAtMs));
  console.log(message);
  console.log(usageCaveat);
  const data = JSON.parse(await readFile(file, 'utf8')) as { rehearsal?: { runtime?: Record<string, unknown> } };
  if (!data.rehearsal?.runtime) throw new Error('Record has no rehearsal.runtime object.');
  data.rehearsal.runtime.modelCalls = modelCalls;
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  if (modelCalls === null) process.exitCode = 1;
  else if (modelCalls > 6) console.log('Warning: exceeds the six-call assignment cap; the validator will report FAIL. The true count was recorded.');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'init') await init(args, process.env);
  else if (command === 'usage') await usage(args, process.env);
  else throw new Error('Usage: agent-acceptance-init <init|usage> ...');
}

if (process.argv[1]?.endsWith('/agent-acceptance-init.ts') || process.argv[1]?.endsWith('/agent-acceptance-init.js')) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
