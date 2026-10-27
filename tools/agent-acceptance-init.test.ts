import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageTracker } from '../worker/src/usage.js';
import { validateAcceptance } from './agent-acceptance-check.js';
import { recordDeploymentChecks, type DeploymentReport } from './agent-deployment-check.js';
import { buildInitialRecord, computeModelCalls, readUsage, runtimeFromEnv, HERMES_PIN, type UsageBaseline } from './agent-acceptance-init.js';

const exec = promisify(execFile);
const cli = resolve('tools/agent-acceptance-init.ts');
const tsx = resolve('node_modules/.bin/tsx');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'accept-init-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const template = async () => JSON.parse(await readFile('docs/agent-acceptance-template.json', 'utf8'));
const facts = { gitRevision: 'a'.repeat(40) + '-dirty', serverVersion: '0.1.0', runtimeName: 'hermes', runtimeRevision: HERMES_PIN };
const opts = { officeUrl: 'https://192.168.1.20:8443', livekitUrl: 'wss://192.168.1.20:8444', scope: 'lan' as const };

function flatten(value: unknown, path = ''): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.assign({}, ...Object.entries(value).map(([k, v]) => flatten(v, path ? `${path}.${k}` : k)));
  }
  return { [path]: value };
}

it('keeps HERMES_PIN in sync with the worker pin', async () => {
  // Duplicated to avoid importing the worker stack; this guards against drift.
  expect(await readFile('agent-worker/src/hermes.ts', 'utf8')).toContain(`export const HERMES_COMMIT = '${HERMES_PIN}';`);
});

describe('init', () => {
  it('fills only allowed fields and leaves human attestations at template values', async () => {
    const t = await template();
    const filled = buildInitialRecord(t, opts, facts);
    const before = flatten(t); const after = flatten(filled);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).sort();
    expect(changed).toEqual([
      'deployment.livekitUrl', 'deployment.networkScope', 'deployment.officeUrl',
      'rehearsal.gitRevision', 'rehearsal.runtime.name', 'rehearsal.runtime.revision', 'rehearsal.serverVersion',
    ]);
    expect(validateAcceptance(filled).verdict).toBe('OPEN');
  });

  it('leaves undeterminable facts null and rejects invalid URLs/scope', async () => {
    const t = await template();
    const r = buildInitialRecord(t, opts, { gitRevision: null, serverVersion: null, runtimeName: null, runtimeRevision: null }) as any;
    expect(r.rehearsal.gitRevision).toBeNull(); expect(r.rehearsal.runtime.name).toBeNull();
    expect(() => buildInitialRecord(t, { ...opts, officeUrl: 'http://192.168.1.20' }, facts)).toThrow();
    expect(() => buildInitialRecord(t, { ...opts, livekitUrl: 'wss://127.0.0.1' }, facts)).toThrow();
    expect(() => buildInitialRecord(t, { ...opts, scope: 'public' }, facts)).toThrow();
  });

  it('derives runtime only from an explicit AGENT_RUNTIME', () => {
    expect(runtimeFromEnv({})).toEqual({ name: null, revision: null });
    expect(runtimeFromEnv({ AGENT_RUNTIME: 'hermes' })).toEqual({ name: 'hermes', revision: HERMES_PIN });
    expect(runtimeFromEnv({ AGENT_RUNTIME: 'gemini' })).toEqual({ name: 'gemini', revision: null });
  });

  it('CLI creates a record plus baseline and refuses to overwrite', async () => {
    const db = join(dir, 'usage.sqlite');
    const tracker = new UsageTracker(db, 'key'); tracker.finish(tracker.reserve('m', 'op'), {}); tracker.close();
    const out = join(dir, 'rec.json');
    const args = [cli, 'init', out, '--office-url', opts.officeUrl, '--livekit-url', opts.livekitUrl, '--scope', 'lan', '--usage-db', db];
    await exec(tsx, args);
    const rec = JSON.parse(await readFile(out, 'utf8'));
    expect(rec.deployment.networkScope).toBe('lan');
    expect(rec.rehearsal.serverVersion).toBe(JSON.parse(await readFile('package.json', 'utf8')).version);
    expect(rec.rehearsal.gitRevision).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
    expect(JSON.parse(await readFile(`${out}.usage-baseline.json`, 'utf8')).count).toBe(1);
    await expect(exec(tsx, args)).rejects.toThrow();
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(rec);
  }, 30_000);
});

describe('usage accounting', () => {
  const baseline = (count: number, recordedAtMs: number): UsageBaseline => ({ schemaVersion: 1, database: '', count, recordedAt: new Date(recordedAtMs).toISOString(), recordedAtMs });

  it('computes the delta including failed attempts, from a read-only open', async () => {
    const db = join(dir, 'u.sqlite');
    const t = new UsageTracker(db, 'key');
    t.finish(t.reserve('m', 'old'), {});
    const base = readUsage(db, Date.now() + 1) as { total: number };
    expect(base.total).toBe(1);
    const startMs = Date.now() + 5;
    await new Promise((r) => setTimeout(r, 15));
    t.finish(t.reserve('m', 'a'), {});
    t.finish(t.reserve('m', 'b'), { code: 'PROVIDER_ERROR', httpStatus: 500 });
    t.reserve('m', 'c'); // unfinished still counts
    const other = new UsageTracker(db, 'other-credential'); other.reserve('m', 'x'); other.close();
    const now = readUsage(db, startMs);
    expect(computeModelCalls(baseline(base.total, startMs), now).modelCalls).toBe(4);
    t.close();
  });

  it('leaves null on negative delta, unreadable DB, or inconsistent ledger', () => {
    expect(computeModelCalls(baseline(5, 1), { total: 2, sinceMs: 0 }).modelCalls).toBeNull();
    expect(computeModelCalls(baseline(5, 1), { total: 2, sinceMs: 0 }).message).toMatch(/reset|replaced/);
    expect(computeModelCalls(baseline(1, 1), { error: 'unable to open database file' }).modelCalls).toBeNull();
    expect(computeModelCalls(baseline(1, 1), { total: 4, sinceMs: 1 }).modelCalls).toBeNull();
    expect('error' in (readUsage(join(dir, 'missing.sqlite'), 0))).toBe(true);
  });

  it('CLI usage writes modelCalls, and null when the ledger was replaced', async () => {
    const db = join(dir, 'u.sqlite'); const out = join(dir, 'rec.json');
    const t = new UsageTracker(db, 'key'); t.finish(t.reserve('m', 'old'), {}); t.close();
    await exec(tsx, [cli, 'init', out, '--office-url', opts.officeUrl, '--livekit-url', opts.livekitUrl, '--scope', 'lan', '--usage-db', db]);
    await new Promise((r) => setTimeout(r, 20));
    const t2 = new UsageTracker(db, 'key'); t2.finish(t2.reserve('m', 'a'), {}); t2.finish(t2.reserve('m', 'b'), { code: 'X' }); t2.close();
    await exec(tsx, [cli, 'usage', out]);
    expect(JSON.parse(await readFile(out, 'utf8')).rehearsal.runtime.modelCalls).toBe(2);
    await rm(db); await rm(`${db}-wal`, { force: true }); await rm(`${db}-shm`, { force: true });
    const t3 = new UsageTracker(db, 'key'); t3.close();
    await expect(exec(tsx, [cli, 'usage', out])).rejects.toThrow();
    expect(JSON.parse(await readFile(out, 'utf8')).rehearsal.runtime.modelCalls).toBeNull();
  }, 30_000);
});

describe('deployment-check --record merge', () => {
  const report: DeploymentReport = {
    checkedAt: '2026-10-27T18:00:00.000Z', networkScope: 'lan', officeOrigin: 'https://192.168.1.20:8443', livekitOrigin: 'wss://192.168.1.20:8444',
    humanAcceptance: 'not-assessed',
    checks: {
      officeHttps: { status: 'pass', detail: 'Configured with HTTPS for lan scope.' },
      healthz: { status: 'pass', detail: 'HTTP 200; ok.' },
      readyz: { status: 'fail', detail: 'HTTP 503; expected ready.' },
      livekitTls: { status: 'not-run', detail: 'No public WSS origin supplied.' },
    },
  };

  it('writes only the four automated checks', async () => {
    const filled = buildInitialRecord(await template(), opts, facts);
    const merged = recordDeploymentChecks(filled, report) as any;
    const changed = Object.keys(flatten(merged)).filter((k) => JSON.stringify(flatten(merged)[k]) !== JSON.stringify(flatten(filled)[k]));
    expect(changed.every((k) => /^deployment\.checks\.(https|health|readiness)\./.test(k))).toBe(true);
    expect(merged.deployment.checks.https.result).toBe('pass');
    expect(merged.deployment.checks.readiness).toMatchObject({ result: 'fail', observedAt: report.checkedAt });
    expect(merged.deployment.checks.readiness.evidence).toContain('HTTP 503');
    expect(merged.deployment.checks.wssTls.result).toBe('not_run'); // not-run probe leaves entry alone
    for (const human of ['separateDevices', 'nearAudio', 'farAudio', 'privateRoomIsolation']) {
      expect(merged.deployment.checks[human]).toEqual({ result: 'not_run', observedAt: null, evidence: null });
    }
    expect(merged.rehearsal).toEqual((filled as any).rehearsal);
    expect(validateAcceptance(merged).verdict).toBe('FAIL'); // recorded failure stays visible
  });

  it('refuses mismatched record or malformed record', async () => {
    const filled = buildInitialRecord(await template(), opts, facts);
    expect(() => recordDeploymentChecks(filled, { ...report, officeOrigin: 'https://192.168.1.99:8443' })).toThrow(/officeUrl/);
    expect(() => recordDeploymentChecks(filled, { ...report, networkScope: 'public' })).toThrow(/networkScope/);
    expect(() => recordDeploymentChecks({}, report)).toThrow();
  });
});
