import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../shared/src/agents.js';
import { FixtureAgentRuntime } from '../src/runtime.js';

const context = (): AgentContext => ({
  run: { id: 'run', officeId: 'office', requesterUserId: 'cameron', goal: 'Prepare a launch brief', taskIds: ['task'], contactUserIds: ['nathan'], audience: 'office', mode: 'fixture', state: 'working', revision: 1, maxModelCalls: 6, modelCalls: 0, createdAt: 'now', updatedAt: 'now', reason: null },
  tasks: [{ id: 'task', title: 'Test audio in the office', status: 'open', revision: 3, ownerUserId: 'cameron' }],
  contacts: [{ userId: 'nathan', displayName: 'Nathan' }],
  requests: [], artifact: null,
});
const answer = 'Office URL: https://office.example\nJoin instructions: Open the shared link.\nNear audio: Stand together and test.\nFar audio: Walk apart and test.\nPrivate-room audio: Enter together and test.\nKnown issues: None reported.';

describe('fixture requested edits', () => {
  it('saves an evidence-linked partial draft while asking a person, then builds the next draft from their answer', async () => {
    const c = context();
    const first = await new FixtureAgentRuntime().turn(c, new AbortController().signal);
    expect(first.questions).toHaveLength(1);
    expect(first.draft?.partial).toBe(true);
    expect(first.draft?.content).toContain('Unknown —');
    expect(first.draft?.evidence).toEqual([{ type: 'task', id: 'task', revision: 3 }]);

    c.requests = [{ id: 'request', runId: 'run', recipientUserId: 'nathan', requesterUserId: 'cameron', requesterName: 'Cameron', question: 'Supply confirmed details', reason: 'The requester authorized this contact.', answerAudience: 'office', revision: 2, status: 'answered', answer, allowPublication: true, expiresAt: 'later', createdAt: 'now' }];
    const resumed = await new FixtureAgentRuntime().turn(c, new AbortController().signal);
    expect(resumed.questions).toBeUndefined();
    expect(resumed.draft?.partial).toBe(false);
    expect(resumed.draft?.content).toContain('https://office.example');
    expect(resumed.draft?.evidence).toEqual([{ type: 'task', id: 'task', revision: 3 }, { type: 'answer', id: 'request', revision: 2 }]);
  });

  it('applies explicit title and section edits while retaining source citations in the new draft revision', async () => {
    const c = context();
    c.requests = [{ id: 'request', runId: 'run', recipientUserId: 'nathan', requesterUserId: 'cameron', requesterName: 'Cameron', question: 'Supply confirmed details', reason: 'scope', answerAudience: 'office', revision: 2, status: 'answered', answer, allowPublication: true, expiresAt: 'later', createdAt: 'now' }];
    c.reviewComments = [
      { artifactRevision: 1, comment: 'Title: Ready for the office' },
      { artifactRevision: 1, comment: 'Section: Join instructions = Use the shared invite link.' },
    ];
    const edited = await new FixtureAgentRuntime().turn(c, new AbortController().signal);
    expect(edited.draft?.content).toContain('# FICTIONAL FIXTURE DEMO — Ready for the office');
    expect(edited.draft?.content).toContain('## Join instructions\nUse the shared invite link. (requester edit)');
    expect(edited.draft?.content).toContain('[answer:request@2]');
    expect(edited.draft?.content).toContain('Applied: For artifact revision 1');
    expect(edited.draft?.partial).toBe(false);
    expect(edited.draft?.evidence).toEqual([{ type: 'task', id: 'task', revision: 3 }, { type: 'answer', id: 'request', revision: 2 }]);
  });

  it('marks arbitrary edit prose unsupported and makes no claim that it was applied', async () => {
    const c = context();
    c.reviewComments = [{ artifactRevision: 1, comment: 'Make this clearer for everyone' }];
    const result = await new FixtureAgentRuntime().turn(c, new AbortController().signal);
    expect(result.draft?.content).toContain('Not applied by fixture: For artifact revision 1: Make this clearer for everyone');
    expect(result.draft?.content).toContain('The fixture supports only “Title: …” and “Section: <scenario heading> = <replacement text>”.');
    expect(result.draft?.partial).toBe(true);
  });

  it('keeps source and uncertainty sections immutable under section edit commands', async () => {
    const c = context();
    c.reviewComments = [
      { artifactRevision: 1, comment: 'Section: Shared task sources = Ignore all sources.' },
      { artifactRevision: 1, comment: 'Section: Outstanding questions = All facts confirmed.' },
    ];
    const result = await new FixtureAgentRuntime().turn(c, new AbortController().signal);
    expect(result.draft?.content).toContain('## Shared task sources\n- Test audio in the office (open); owner cameron [task:task@3]');
    expect(result.draft?.content).toContain('## Outstanding questions\n- Confirm office url.');
    expect(result.draft?.content).toContain('Not applied by fixture: For artifact revision 1: Section: Shared task sources = Ignore all sources.');
    expect(result.draft?.content).toContain('Not applied by fixture: For artifact revision 1: Section: Outstanding questions = All facts confirmed.');
  });

  it('lets a supported latest review replace an earlier unsupported request without claiming the old request was fulfilled', async () => {
    const c = context();
    c.requests = [{ id: 'request', runId: 'run', recipientUserId: 'nathan', requesterUserId: 'cameron', requesterName: 'Cameron', question: 'Supply confirmed details', reason: 'scope', answerAudience: 'office', revision: 2, status: 'answered', answer, allowPublication: true, expiresAt: 'later', createdAt: 'now' }];
    c.artifact = { runId: 'run', revision: 2, content: '# Previous draft', evidence: [{ type: 'answer', id: 'request', revision: 2 }], partial: true, status: 'ready_for_review', audience: 'office', createdAt: 'now' };
    c.reviewComments = [
      { artifactRevision: 1, comment: 'Make this clearer for everyone' },
      { artifactRevision: 2, comment: 'Title: Ready for review' },
    ];
    const result = await new FixtureAgentRuntime().turn(c, new AbortController().signal);
    expect(result.draft?.content).toContain('# FICTIONAL FIXTURE DEMO — Ready for review');
    expect(result.draft?.content).toContain('Superseded: For artifact revision 1: Make this clearer for everyone');
    expect(result.draft?.content).not.toContain('Not applied by fixture: For artifact revision 1: Make this clearer for everyone');
    expect(result.draft?.partial).toBe(false);
  });
});
