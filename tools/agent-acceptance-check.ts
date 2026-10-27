/** Validate a human-completed M5/M6 JSON record; never fills missing evidence. */
import { readFile } from 'node:fs/promises';
import { isLanHostname, isPublicHostname } from './agent-deployment-check.js';

type Verdict = 'PASS' | 'OPEN' | 'FAIL';
type Result = { verdict: Verdict; missing: string[]; invalid: string[] };
const scenarioNames = [
  'offlineBusyDelivery', 'restartDuringWait', 'rejection', 'requestedEdits',
  'cancellation', 'lateReply', 'changedOrExpiredApproval', 'providerOrBudgetFailure',
] as const;
const deploymentChecks = ['https', 'health', 'readiness', 'wssTls', 'separateDevices', 'nearAudio', 'farAudio', 'privateRoomIsolation'] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value: unknown): boolean { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
function requiredText(obj: Record<string, unknown> | undefined, key: string, path: string, missing: string[], invalid: string[]): string | undefined {
  const value = obj?.[key];
  if (value === undefined || value === null || value === '') missing.push(path);
  else if (typeof value !== 'string') invalid.push(`${path} must be text.`);
  else if (!value.trim()) missing.push(path);
  else return value;
}
export function expectedUrl(value: unknown, protocol: 'https:' | 'wss:', scope: unknown): boolean {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    const hostAllowed = scope === 'lan' ? isLanHostname(url.hostname) : scope === 'public' && isPublicHostname(url.hostname);
    return url.protocol === protocol && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === '/' || url.pathname === '') && hostAllowed;
  } catch { return false; }
}

export function validateAcceptance(value: unknown): Result {
  const missing: string[] = [];
  const invalid: string[] = [];
  const root = record(value);
  if (!root) return { verdict: 'FAIL', missing, invalid: ['Root must be a JSON object.'] };
  if (root.schemaVersion !== 1) invalid.push('schemaVersion must be 1.');

  const deployment = record(root.deployment);
  if (!deployment) invalid.push('deployment must be an object.');
  const scope = deployment?.networkScope;
  if (scope !== 'lan' && scope !== 'public') {
    if (scope === null || scope === undefined || scope === '') missing.push('deployment.networkScope');
    else invalid.push('deployment.networkScope must be public or lan.');
  }
  for (const [key, protocol, label] of [['officeUrl', 'https:', 'office HTTPS'], ['livekitUrl', 'wss:', 'LiveKit WSS']] as const) {
    const url = deployment?.[key];
    if (!expectedUrl(url, protocol, scope)) {
      if (url === null || url === undefined || url === '') missing.push(`deployment.${key} (${scope === 'lan' ? 'private LAN' : 'public'} ${label} origin)`);
      else invalid.push(`deployment.${key} must be a valid ${scope === 'lan' ? 'private LAN' : 'public'} ${label} origin without credentials, path, query, or fragment.`);
    }
  }
  requiredText(deployment, 'joinInstructions', 'deployment.joinInstructions', missing, invalid);
  const depChecks = record(deployment?.checks);
  const checkOutcomes: unknown[] = [];
  for (const name of deploymentChecks) {
    const check = record(depChecks?.[name]);
    if (!check || check.result === 'not_run' || check.result === undefined || check.result === null) {
      missing.push(`deployment.checks.${name}`); checkOutcomes.push('not_run'); continue;
    }
    checkOutcomes.push(check.result);
    if (check.result !== 'pass' && check.result !== 'fail' && check.result !== 'blocked') invalid.push(`deployment.checks.${name}.result must be pass, fail, or blocked.`);
    const observedAt = requiredText(check, 'observedAt', `deployment.checks.${name}.observedAt`, missing, invalid);
    if (observedAt && !timestamp(observedAt)) invalid.push(`deployment.checks.${name}.observedAt must be a date/time.`);
    requiredText(check, 'evidence', `deployment.checks.${name}.evidence`, missing, invalid);
  }

  const rehearsal = record(root.rehearsal);
  if (!rehearsal) invalid.push('rehearsal must be an object.');
  for (const key of ['performedAt', 'gitRevision', 'serverVersion'] as const) {
    const item = rehearsal?.[key];
    requiredText(rehearsal, key, `rehearsal.${key}`, missing, invalid);
    if (key === 'performedAt' && item !== undefined && item !== null && item !== '' && !timestamp(item)) invalid.push('rehearsal.performedAt must be a date/time.');
  }

  const runtime = record(rehearsal?.runtime);
  if (!runtime) invalid.push('rehearsal.runtime must be an object.');
  requiredText(runtime, 'name', 'rehearsal.runtime.name', missing, invalid);
  requiredText(runtime, 'revision', 'rehearsal.runtime.revision', missing, invalid);
  const mode = runtime?.mode;
  if (mode !== 'fixture' && mode !== 'live') {
    if (mode === null || mode === undefined || mode === '') missing.push('rehearsal.runtime.mode');
    else invalid.push('rehearsal.runtime.mode must be fixture or live.');
  }
  const modelCalls = runtime?.modelCalls;
  if (!Number.isInteger(modelCalls) || Number(modelCalls) < 0) {
    if (modelCalls === null || modelCalls === undefined) missing.push('rehearsal.runtime.modelCalls');
    else invalid.push('rehearsal.runtime.modelCalls must be a non-negative integer.');
  }
  if (mode === 'fixture' && Number.isInteger(modelCalls) && modelCalls !== 0) invalid.push('Fixture mode must record zero model calls.');
  if (Number.isInteger(modelCalls) && Number(modelCalls) > 6) invalid.push('rehearsal.runtime.modelCalls exceeds the six-call assignment cap.');
  if (mode === 'live') {
    requiredText(runtime, 'provider', 'rehearsal.runtime.provider', missing, invalid);
    requiredText(runtime, 'model', 'rehearsal.runtime.model', missing, invalid);
    if (modelCalls === 0) invalid.push('Live mode must record at least one model call.');
  }

  const participants = Array.isArray(rehearsal?.participants) ? rehearsal.participants.map(record) : undefined;
  const participantIds = new Set<string>();
  const devices = new Set<string>();
  if (!participants || participants.length < 2) missing.push('rehearsal.participants (two real people on separate devices)');
  else participants.forEach((person, index) => {
    const label = `rehearsal.participants[${index}]`;
    if (!person) { invalid.push(`${label} must be an object.`); return; }
    const id = requiredText(person, 'id', `${label}.id`, missing, invalid);
    const name = requiredText(person, 'nameOrRole', `${label}.nameOrRole`, missing, invalid);
    const device = requiredText(person, 'device', `${label}.device`, missing, invalid);
    requiredText(person, 'browser', `${label}.browser`, missing, invalid);
    if (person.attestedRealPerson !== true) missing.push(`${label}.attestedRealPerson (participant attestation)`);
    if (name && /\b(synthetic|fictional|fake|mock|test account|demo account)\b/i.test(name)) invalid.push(`${label}.nameOrRole appears to describe a synthetic identity.`);
    if (id) {
      if (participantIds.has(id)) invalid.push('Participant IDs must be distinct.');
      participantIds.add(id);
    }
    if (device) {
      const normalized = device.trim().toLowerCase();
      if (devices.has(normalized)) invalid.push('Participants must use distinct devices.');
      devices.add(normalized);
    }
  });

  const goal = record(rehearsal?.goal); const question = record(rehearsal?.question);
  const answer = record(rehearsal?.answer); const brief = record(rehearsal?.brief);
  for (const [obj, path] of [[goal, 'goal'], [question, 'question'], [answer, 'answer'], [brief, 'brief']] as const) {
    if (!obj) { missing.push(`rehearsal.${path}`); continue; }
    requiredText(obj, 'evidence', `rehearsal.${path}.evidence`, missing, invalid);
  }
  if (goal?.realAssignment !== true) missing.push('rehearsal.goal.realAssignment');
  if (question?.crossUserQuestion !== true) missing.push('rehearsal.question.crossUserQuestion');
  if (answer?.realAnswer !== true) missing.push('rehearsal.answer.realAnswer');
  if (brief?.evidenceLinked !== true) missing.push('rehearsal.brief.evidenceLinked');
  const reviewDecision = brief?.reviewDecision;
  if (reviewDecision === null || reviewDecision === undefined || reviewDecision === '') missing.push('rehearsal.brief.reviewDecision (approved or rejected)');
  else if (reviewDecision !== 'approved' && reviewDecision !== 'rejected') invalid.push('rehearsal.brief.reviewDecision must be approved or rejected.');
  const artifactRevision = brief?.artifactRevision;
  if (!Number.isInteger(artifactRevision) || Number(artifactRevision) < 1) {
    if (artifactRevision === null || artifactRevision === undefined || artifactRevision === '') missing.push('rehearsal.brief.artifactRevision');
    else invalid.push('rehearsal.brief.artifactRevision must be a positive integer.');
  }
  const requesterId = requiredText(goal, 'requesterId', 'rehearsal.goal.requesterId', missing, invalid);
  const questionFrom = requiredText(question, 'fromId', 'rehearsal.question.fromId', missing, invalid);
  const questionTo = requiredText(question, 'toId', 'rehearsal.question.toId', missing, invalid);
  const responderId = requiredText(answer, 'responderId', 'rehearsal.answer.responderId', missing, invalid);
  for (const [path, id] of [['goal.requesterId', requesterId], ['question.fromId', questionFrom], ['question.toId', questionTo], ['answer.responderId', responderId]] as const) {
    if (id && !participantIds.has(id)) invalid.push(`rehearsal.${path} must identify a recorded participant.`);
  }
  if (requesterId && questionFrom && requesterId !== questionFrom) invalid.push('question.fromId must match goal.requesterId.');
  if (requesterId && questionTo && requesterId === questionTo) invalid.push('Question recipient must differ from the assignment requester.');
  if (questionTo && responderId && questionTo !== responderId) invalid.push('answer.responderId must match question.toId.');

  const scenarios = record(rehearsal?.scenarios);
  const scenarioOutcomes: unknown[] = [];
  for (const name of scenarioNames) {
    const scenario = record(scenarios?.[name]);
    if (!scenario || scenario.result === 'not_run' || scenario.result === undefined || scenario.result === null) {
      missing.push(`rehearsal.scenarios.${name}`); scenarioOutcomes.push('not_run'); continue;
    }
    scenarioOutcomes.push(scenario.result);
    if (!['pass', 'fail', 'blocked'].includes(String(scenario.result))) invalid.push(`rehearsal.scenarios.${name}.result must be pass, fail, or blocked.`);
    requiredText(scenario, 'evidence', `rehearsal.scenarios.${name}.evidence`, missing, invalid);
    if (scenario.result === 'blocked') requiredText(scenario, 'notes', `rehearsal.scenarios.${name}.notes`, missing, invalid);
  }
  const outcomes = [...checkOutcomes, ...scenarioOutcomes];
  const hasRecordedFailure = outcomes.includes('fail');
  const hasBlocked = outcomes.includes('blocked');
  return { verdict: invalid.length || hasRecordedFailure ? 'FAIL' : missing.length || hasBlocked ? 'OPEN' : 'PASS', missing, invalid };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input || input.startsWith('--')) throw new Error('Usage: agent-acceptance-check <record.json>');
  const data = JSON.parse(await readFile(input, 'utf8')) as unknown;
  const result = validateAcceptance(data);
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== 'PASS') process.exitCode = 1;
}

if (process.argv[1]?.endsWith('/agent-acceptance-check.ts') || process.argv[1]?.endsWith('/agent-acceptance-check.js')) await main();
