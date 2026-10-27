import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage, type Storage } from '../src/repositories/Storage.js';
import { AgentRunService } from '../src/services/AgentRunService.js';

let storage: Storage;
const directories: string[] = [];
afterEach(() => { storage?.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(mode: 'fixture' | 'live' = 'fixture', path = ':memory:') {
  storage = openStorage(path);
  const service = new AgentRunService(storage);
  const person = (name: string, officeId = 'office') => ({ ...storage.createGuest(name, officeId), officeId, expiresAt: '2099-01-01' });
  const requester = person('Requester'), first = person('First'), second = person('Second'), outsider = person('Outsider', 'other');
  const run = service.create(requester, { requestId: 'start', goal: 'Prepare brief', taskIds: [], contactUserIds: [first.userId, second.userId], mode });
  const lease = service.claim('initial')!;
  service.apply(run.id, lease.leaseToken, { modelCalls: mode === 'live' ? 1 : 0,
    questions: [first, second].map(p => ({ recipientUserId: p.userId, question: 'Confirmed details?', reason: 'Explicitly selected by requester' })),
    draft: { content: 'Independent outline: office URL and audio procedure remain unknown.', evidence: [], partial: true } });
  return { service, requester, first, second, outsider, run, q: service.inbox(first)[0], q2: service.inbox(second)[0] };
}
function answer(s: ReturnType<typeof setup>, publication = false) {
  return s.service.respond(s.first, s.q.id, { requestId: 'answer', revision: 1, decision: 'answer', answer: 'Private original detail', allowPublication: publication });
}
it('saves independent work with questions, consumes no waiting calls, and resumes once per answer', () => {
  const s = setup('live');
  expect(s.service.get(s.requester, s.run.id)).toMatchObject({ run: { state: 'waiting_for_person', modelCalls: 1 }, artifact: { partial: true } });
  for (let n = 0; n < 5; n++) expect(s.service.claim('idle')).toBeNull();
  answer(s);
  const next = s.service.claim('continue')!;
  expect(s.service.context(s.run.id, next.leaseToken).requests.find(q => q.id === s.q2.id)?.status).toBe('open');
  s.service.apply(s.run.id, next.leaseToken, { modelCalls: 1, draft: { content: 'First contribution incorporated; audio still unknown.', evidence: [{ type: 'answer', id: s.q.id, revision: 1 }], partial: false } });
  const waiting = s.service.get(s.requester, s.run.id);
  expect(waiting.run).toMatchObject({ state: 'waiting_for_person', modelCalls: 2 });
  expect(waiting.artifact).toMatchObject({ revision: 2, partial: true });
  expect(s.service.claim('no-spin')).toBeNull();
  expect(() => s.service.review(s.requester, s.run.id, { requestId: 'premature', revision: 2, decision: 'approve' })).toThrow(/current/);
});
it('invalidates a running lease when another answer arrives so stale work cannot overwrite it', () => {
  const s = setup(); answer(s);
  const stale = s.service.claim('old-context')!;
  s.service.respond(s.second, s.q2.id, { requestId: 'second-answer', revision: 1, decision: 'answer', answer: 'Audio verified', allowPublication: true });
  expect(() => s.service.apply(s.run.id, stale.leaseToken, { modelCalls: 0, draft: { content: 'Stale', evidence: [], partial: true } })).toThrow(/stopped/);
  const fresh = s.service.claim('new-context')!;
  expect(s.service.context(s.run.id, fresh.leaseToken).requests.filter(q => q.status === 'answered')).toHaveLength(2);
  expect(s.service.claim('racer')).toBeNull();
});
it('replaces a private answer with a versioned shareable answer and requires a fresh evidence-linked review', () => {
  const s = setup(); answer(s);
  s.service.respond(s.second, s.q2.id, { requestId: 'second', revision: 1, decision: 'answer', answer: 'Audio steps', allowPublication: true });
  const j = s.service.claim('draft')!;
  s.service.apply(s.run.id, j.leaseToken, { modelCalls: 0, draft: { content: 'Private original detail', evidence: [{ type: 'answer', id: s.q.id, revision: 1 }], partial: false } });
  expect(() => s.service.review(s.requester, s.run.id, { requestId: 'blocked', revision: 2, decision: 'approve' })).toThrow(/audience|restricted/);
  s.service.review(s.requester, s.run.id, { requestId: 'private-edit', revision: 2, decision: 'changes', comment: 'Retain Private original detail' });
  const replacement = { requestId: 'correction', revision: 1, answer: 'Shareable replacement', allowPublication: true };
  expect(() => s.service.reviseAnswer(s.requester, s.q.id, replacement)).toThrow(/not found/);
  expect(() => s.service.reviseAnswer(s.outsider, s.q.id, replacement)).toThrow(/not found/);
  expect(s.service.reviseAnswer(s.first, s.q.id, replacement)).toMatchObject({ revision: 2, answer: 'Shareable replacement' });
  expect(s.service.reviseAnswer(s.first, s.q.id, replacement).revision).toBe(2);
  expect(() => s.service.reviseAnswer(s.first, s.q.id, { ...replacement, answer: 'Changed replay' })).toThrow(/already used/);
  expect(() => s.service.reviseAnswer(s.first, s.q.id, { ...replacement, requestId: 'stale' })).toThrow(/current/);
  expect(() => s.service.answerHistory(s.second, s.q.id)).toThrow(/not found/);
  expect(s.service.answerHistory(s.requester, s.q.id)).toMatchObject([{ revision: 1, answer: 'Private original detail' }, { revision: 2, answer: 'Shareable replacement' }]);
  expect(() => s.service.review(s.requester, s.run.id, { requestId: 'old', revision: 2, decision: 'approve' })).toThrow(/current/);
  const next = s.service.claim('rebuild')!, context = s.service.context(s.run.id, next.leaseToken);
  expect(context.artifact).toBeNull();
  expect(context.reviewComments).toEqual([]);
  expect(JSON.stringify(context)).not.toContain('Private original detail');
  expect(() => s.service.apply(s.run.id, next.leaseToken, { modelCalls: 0, draft: { content: 'Old revision', evidence: [{ type: 'answer', id: s.q.id, revision: 1 }], partial: false } })).toThrow(/unavailable/);
  s.service.apply(s.run.id, next.leaseToken, { modelCalls: 0, draft: { content: 'Shareable replacement', evidence: [{ type: 'answer', id: s.q.id, revision: 2 }, { type: 'answer', id: s.q2.id, revision: 1 }], partial: false } });
  s.service.review(s.requester, s.run.id, { requestId: 'fresh', revision: 3, decision: 'approve' });
  expect(s.service.publications(s.second)).toMatchObject([{ revision: 3, content: 'Shareable replacement' }]);
});
it('does not reopen declined or expired requests or issue correction notifications', () => {
  const s = setup();
  s.service.respond(s.first, s.q.id, { requestId: 'no', revision: 1, decision: 'decline' });
  expect(() => s.service.reviseAnswer(s.first, s.q.id, { requestId: 'bypass', revision: 1, answer: 'Changed mind', allowPublication: true })).toThrow(/declined/);
  s.service.respond(s.second, s.q2.id, { requestId: 'yes', revision: 1, decision: 'answer', answer: 'Audio', allowPublication: false });
  storage.db.prepare('UPDATE agent_requests SET expires_at=? WHERE id=?').run('2000-01-01', s.q2.id);
  expect(() => s.service.reviseAnswer(s.second, s.q2.id, { requestId: 'expired', revision: 1, answer: 'Late', allowPublication: true })).toThrow(/unexpired/);
  expect(storage.db.prepare("SELECT * FROM agent_outbox WHERE kind='question'").all()).toHaveLength(2);
});
it('upgrades existing answers and preserves corrections and independent progress across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-answer-upgrade-')); directories.push(dir);
  const path = join(dir, 'office.sqlite'), s = setup('fixture', path); answer(s);
  // Reproduce a persisted migration-005 database with an existing answered question.
  storage.db.exec('DROP TABLE agent_answer_versions; DELETE FROM schema_migrations WHERE version=6');
  storage.close(); storage = openStorage(path);
  const upgraded = new AgentRunService(storage);
  expect(upgraded.answerHistory(s.requester, s.q.id)).toMatchObject([{ revision: 1, answer: 'Private original detail' }]);
  upgraded.reviseAnswer(s.first, s.q.id, { requestId: 'correction', revision: 1, answer: 'Shareable replacement', allowPublication: true });
  storage.close(); storage = openStorage(path);
  const restarted = new AgentRunService(storage), next = restarted.claim('after-restart')!;
  const context = restarted.context(s.run.id, next.leaseToken);
  expect(context.artifact).toBeNull();
  expect(context.requests.find(q => q.id === s.q.id)).toMatchObject({ revision: 2, answer: 'Shareable replacement', allowPublication: true });
  expect(context.requests.find(q => q.id === s.q2.id)?.status).toBe('open');
  expect(restarted.answerHistory(s.first, s.q.id)).toHaveLength(2);
  expect(restarted.claim('race')).toBeNull();
});
