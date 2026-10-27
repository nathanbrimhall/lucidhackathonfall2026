import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { runDeploymentCheck, isLanHostname, isPublicHostname } from './agent-deployment-check.js';
import { validateAcceptance } from './agent-acceptance-check.js';

const passingFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  return {
    ok: true, status: 200,
    json: async () => ({ status: url.endsWith('/healthz') ? 'ok' : 'ready' }),
  } as Response;
});

function passingRecord() {
  const passed = { result: 'pass', observedAt: '2026-10-27T18:00:00Z', evidence: 'evidence/verified-observation.txt' };
  const scenario = { result: 'pass', evidence: 'evidence/scenario-observation.txt', notes: null };
  return {
    schemaVersion: 1,
    deployment: {
      networkScope: 'public',
      officeUrl: 'https://office.lucidhackathon.com',
      livekitUrl: 'wss://media.lucidhackathon.com',
      joinInstructions: 'Use the host-provided invite in the office UI.',
      checks: Object.fromEntries(['https', 'health', 'readiness', 'wssTls', 'separateDevices', 'nearAudio', 'farAudio', 'privateRoomIsolation'].map((key) => [key, { ...passed }])),
    },
    rehearsal: {
      performedAt: '2026-10-27T18:00:00Z', gitRevision: 'a'.repeat(40), serverVersion: 'release-1',
      runtime: { name: 'agent-worker', revision: 'worker-1', mode: 'fixture', provider: null, model: null, modelCalls: 0 },
      participants: [
        { id: 'p1', nameOrRole: 'Person A', device: 'Laptop A', browser: 'Browser A', attestedRealPerson: true },
        { id: 'p2', nameOrRole: 'Person B', device: 'Laptop B', browser: 'Browser B', attestedRealPerson: true },
      ],
      goal: { requesterId: 'p1', realAssignment: true, evidence: 'evidence/assignment.txt' },
      question: { fromId: 'p1', toId: 'p2', crossUserQuestion: true, evidence: 'evidence/question.txt' },
      answer: { responderId: 'p2', realAnswer: true, evidence: 'evidence/answer.txt' },
      brief: { artifactRevision: 1, evidenceLinked: true, reviewDecision: 'approved', evidence: 'evidence/review.txt' },
      scenarios: Object.fromEntries(['offlineBusyDelivery', 'restartDuringWait', 'rejection', 'requestedEdits', 'cancellation', 'lateReply', 'changedOrExpiredApproval', 'providerOrBudgetFailure'].map((key) => [key, { ...scenario }])),
    },
  };
}

describe('shared office deployment and acceptance gates', () => {
  it('probes only health/readiness and TLS using injected local mocks', async () => {
    const tlsProbe = vi.fn(async () => {});
    const result = await runDeploymentCheck({
      officeUrl: 'https://office.lucidhackathon.com', livekitUrl: 'wss://media.lucidhackathon.com',
      fetchImpl: passingFetch, tlsProbe,
    });
    expect(result.checks).toMatchObject({
      officeHttps: { status: 'pass' }, livekitWss: { status: 'pass' },
      healthz: { status: 'pass', detail: 'HTTP 200; ok.' },
      readyz: { status: 'pass', detail: 'HTTP 200; ready.' },
      livekitTls: { status: 'pass' },
    });
    expect(passingFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://office.lucidhackathon.com/healthz', 'https://office.lucidhackathon.com/readyz',
    ]);
    expect(tlsProbe).toHaveBeenCalledWith('media.lucidhackathon.com', 443, 8000);
    expect(result.humanAcceptance).toBe('not-assessed');
  });

  it('reports failed readiness and TLS without upgrading or creating a room', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ status: 'not_ready' }) }) as Response);
    const tlsProbe = vi.fn(async () => { throw new Error('certificate verification failed'); });
    const result = await runDeploymentCheck({ officeUrl: 'https://office.lucidhackathon.com', livekitUrl: 'wss://media.lucidhackathon.com', fetchImpl, tlsProbe });
    expect(result.checks.healthz.status).toBe('fail');
    expect(result.checks.readyz.status).toBe('fail');
    expect(result.checks.livekitTls).toEqual({ status: 'fail', detail: 'TLS certificate validation failed.' });
  });

  it.each([
    ['http://office.lucidhackathon.com', 'wss://media.lucidhackathon.com'],
    ['https://localhost:2567', 'wss://media.lucidhackathon.com'],
    ['https://192.0.2.10', 'wss://media.lucidhackathon.com'],
    ['https://office.lucidhackathon.com/path', 'wss://media.lucidhackathon.com'],
    ['https://office.lucidhackathon.com', 'ws://media.lucidhackathon.com'],
    ['https://office.lucidhackathon.com', 'wss://127.0.0.1:7880'],
  ])('rejects insecure, local, reserved or non-origin URLs (%s, %s)', async (officeUrl, livekitUrl) => {
    await expect(runDeploymentCheck({ officeUrl, livekitUrl, fetchImpl: passingFetch, tlsProbe: async () => {} })).rejects.toThrow();
  });

  it('rejects private, loopback, link-local, documentation and non-global IP hosts', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.1', '172.16.1.1', '192.0.2.1', '198.51.100.2', '203.0.113.8', '::1', 'fc00::1', '2001:db8::1', 'office.local']) {
      expect(isPublicHostname(host), host).toBe(false);
    }
    for (const host of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', 'office.lucidhackathon.com']) expect(isPublicHostname(host), host).toBe(true);
    for (const host of ['192.168.1.20', '10.0.0.4', 'office.local', 'room.lan']) expect(isLanHostname(host), host).toBe(true);
    for (const host of ['127.0.0.1', '192.0.2.1', 'localhost', 'example', 'test', 'invalid', 'office.example.net']) expect(isLanHostname(host), host).toBe(false);
  });

  it('allows explicitly selected private LAN origins over HTTPS/WSS but not loopback', async () => {
    const result = await runDeploymentCheck({
      officeUrl: 'https://192.168.1.20', livekitUrl: 'wss://192.168.1.20:7880', allowLan: true,
      fetchImpl: passingFetch, tlsProbe: async () => {},
    });
    expect(result.networkScope).toBe('lan');
    expect(result.checks.officeHttps.status).toBe('pass');
    expect(result.checks.livekitTls.status).toBe('pass');
    await expect(runDeploymentCheck({ officeUrl: 'https://127.0.0.1', livekitUrl: 'wss://192.168.1.20', allowLan: true })).rejects.toThrow();
  });

  it('validates a LAN acceptance record only when its scope and both URLs are LAN addresses', () => {
    const candidate: any = passingRecord();
    candidate.deployment.networkScope = 'lan';
    candidate.deployment.officeUrl = 'https://192.168.1.20';
    candidate.deployment.livekitUrl = 'wss://office.local:7880';
    expect(validateAcceptance(candidate).verdict).toBe('PASS');
    candidate.deployment.livekitUrl = 'wss://localhost:7880';
    expect(validateAcceptance(candidate).verdict).toBe('FAIL');
  });

  it('leaves the blank machine-readable template open instead of supplying evidence', async () => {
    const template = JSON.parse(await readFile('docs/agent-acceptance-template.json', 'utf8')) as unknown;
    const result = validateAcceptance(template);
    expect(result.verdict).toBe('OPEN');
    expect(result.missing).toContain('deployment.networkScope');
    expect(result.missing).toContain('deployment.officeUrl (public office HTTPS origin)');
    expect(result.missing).toContain('rehearsal.participants (two real people on separate devices)');
  });

  it('passes only a complete record with distinct, attested people/devices and every scenario outcome', () => {
    expect(validateAcceptance(passingRecord())).toEqual({ verdict: 'PASS', missing: [], invalid: [] });
  });

  it('does not accept local URLs, duplicate devices or missing runtime revision as a pass', () => {
    const candidate: any = passingRecord();
    candidate.deployment.officeUrl = 'http://localhost:2567';
    candidate.rehearsal.participants[1].device = candidate.rehearsal.participants[0].device;
    candidate.rehearsal.runtime.revision = null;
    const result = validateAcceptance(candidate);
    expect(result.verdict).toBe('FAIL');
    expect(result.invalid).toContain('deployment.officeUrl must be a valid public office HTTPS origin without credentials, path, query, or fragment.');
    expect(result.invalid).toContain('Participants must use distinct devices.');
    expect(result.missing).toContain('rehearsal.runtime.revision');
  });

  it('requires provider accounting for live mode and zero calls for fixture mode', () => {
    const candidate: any = passingRecord();
    candidate.rehearsal.runtime.modelCalls = 1;
    expect(validateAcceptance(candidate).invalid).toContain('Fixture mode must record zero model calls.');
    candidate.rehearsal.runtime.mode = 'live';
    candidate.rehearsal.runtime.model = null;
    const liveResult = validateAcceptance(candidate);
    expect(liveResult.missing).toContain('rehearsal.runtime.model');
    candidate.rehearsal.runtime.model = 'test-model';
    candidate.rehearsal.runtime.modelCalls = 0;
    expect(validateAcceptance(candidate).invalid).toContain('Live mode must record at least one model call.');
    candidate.rehearsal.runtime.modelCalls = 7;
    expect(validateAcceptance(candidate).invalid).toContain('rehearsal.runtime.modelCalls exceeds the six-call assignment cap.');
  });

  it('records failures as FAIL and requires evidence even for failed scenarios', () => {
    const candidate: any = passingRecord();
    candidate.rehearsal.scenarios.restartDuringWait = { result: 'fail', evidence: null, notes: 'Process lost request.' };
    const result = validateAcceptance(candidate);
    expect(result.verdict).toBe('FAIL');
    expect(result.missing).toContain('rehearsal.scenarios.restartDuringWait.evidence');
  });

  it('keeps blocked outcomes OPEN and gives an observed failure precedence over missing fields', () => {
    const candidate: any = passingRecord();
    candidate.rehearsal.scenarios.restartDuringWait = { result: 'blocked', evidence: 'evidence/blocker.txt', notes: 'Needs host access.' };
    expect(validateAcceptance(candidate).verdict).toBe('OPEN');
    candidate.rehearsal.scenarios.rejection = { result: 'fail', evidence: 'evidence/failure.txt', notes: null };
    candidate.rehearsal.runtime.revision = null;
    expect(validateAcceptance(candidate).verdict).toBe('FAIL');
  });

  it('rejects synthetic labels, duplicate participant IDs and misattributed answers', () => {
    const candidate: any = passingRecord();
    candidate.rehearsal.participants[1].nameOrRole = 'Synthetic test account';
    candidate.rehearsal.participants[1].id = 'p1';
    candidate.rehearsal.answer.responderId = 'p1';
    const result = validateAcceptance(candidate);
    expect(result.verdict).toBe('FAIL');
    expect(result.invalid).toContain('rehearsal.participants[1].nameOrRole appears to describe a synthetic identity.');
    expect(result.invalid).toContain('Participant IDs must be distinct.');
    expect(result.invalid).toContain('answer.responderId must match question.toId.');
  });

  it('rejects non-text evidence instead of treating it as a missing field', () => {
    const candidate: any = passingRecord();
    candidate.rehearsal.scenarios.lateReply.evidence = 17;
    const result = validateAcceptance(candidate);
    expect(result.invalid).toContain('rehearsal.scenarios.lateReply.evidence must be text.');
  });
});
