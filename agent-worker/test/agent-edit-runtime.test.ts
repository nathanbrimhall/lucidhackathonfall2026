import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../../worker/src/config.js';
import type { AgentContext } from '../../shared/src/agents.js';
import { GeminiAgentRuntime } from '../src/runtime.js';

const context = (): AgentContext => ({
  run: { id: 'run', officeId: 'office', requesterUserId: 'cameron', goal: 'Prepare a launch brief', taskIds: [], contactUserIds: ['nathan'], audience: 'office', mode: 'live', state: 'working', revision: 9, maxModelCalls: 6, modelCalls: 1, createdAt: 'now', updatedAt: 'now', reason: null },
  tasks: [], contacts: [{ userId: 'nathan', displayName: 'Nathan' }],
  requests: [{ id: 'answer-1', runId: 'run', recipientUserId: 'nathan', requesterUserId: 'cameron', requesterName: 'Cameron', question: 'Supply confirmed details', reason: 'scope', answerAudience: 'Requester draft and office publication only with your permission', revision: 4, status: 'answered', answer: 'Office URL: https://office.example', allowPublication: true, expiresAt: 'later', createdAt: 'now' }],
  artifact: { runId: 'run', revision: 5, content: '# Prior draft', evidence: [{ type: 'answer', id: 'answer-1', revision: 4 }], partial: false, status: 'ready_for_review', audience: 'office', createdAt: 'now' },
  reviewComments: [{ artifactRevision: 5, comment: 'Title: Rehearsal-ready launch brief' }],
});

describe('live requested-edit continuation contract', () => {
  it('sends the exact requester edit and artifact revision in one bounded provider request, retaining evidence', async () => {
    const config = loadWorkerConfig({ AI_PROVIDER: 'gemini', AI_WORKER_SECRET: 'unit-test-worker-secret-long-enough', GEMINI_API_KEY: 'fake-edit-test-key', AI_USAGE_DATABASE: ':memory:', AI_SUMMARY_MODEL: 'gemini-2.5-flash' });
    const evidence = [{ type: 'answer' as const, id: 'answer-1', revision: 4 }];
    let calls = 0;
    let body: any;
    const runtime = new GeminiAgentRuntime(config, async (_url, init) => {
      calls++;
      body = JSON.parse(init!.body as string);
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ modelCalls: 1, draft: { content: '# FICTIONAL FIXTURE DEMO — Rehearsal-ready launch brief\nOffice URL: https://office.example', evidence, partial: false } }) }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8, totalTokenCount: 13 } });
    });
    const result = await runtime.turn(context(), new AbortController().signal);
    const prompt = body.contents[0].parts[0].text as string;
    expect(calls).toBe(1);
    expect(prompt).toContain('"artifactRevision":5');
    expect(prompt).toContain('Title: Rehearsal-ready launch brief');
    expect(prompt).toContain('"revision":5');
    expect(result.draft?.content).toContain('Rehearsal-ready launch brief');
    expect(result.draft?.evidence).toEqual(evidence);
  });
});
