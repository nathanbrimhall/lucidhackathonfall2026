# AI collaboration roadmap and acceptance plan

Implementation update: typed AI panel, shared fictional task workspace, dependency radar and overlap review are implemented in the Conversation Lab. See AI_PANEL.md. The decision-and-assumption Q&A, daily/catch-up briefs and meeting prep are now implemented for the fictional demo; see AI_KNOWLEDGE_TOOLS.md. Real office integration and live semantic acceptance remain outstanding. Historical estimates below describe the planned demo effort, not promised assistant turnaround or completed live acceptance.

Scope: extend the Conversation Lab first. This is a design/estimate, not a claim that the planned features exist. Office-backend integration requires Nathan's explicit approval. Existing demo includes conversation discovery, helper suggestions and interruption preferences.

## Confirmed product decisions

- AI runs only after a typed submission or an explicit action button. No inference on typing, page load, presence changes, task changes or return from absence. Voice invocation is deferred.
- A user can request a dependency scan or duplicate check; findings are suggestions. Priority, links and task changes require review first.
- Role and project settings tailor detail over the same authorized material. Role rank is neither a relevance score nor an authorization grant. Supervisor settings change briefing scope, not permissions.
- Demo is fictional. Existing local proposals are not an authoritative shared team task database. Invitations remain simulated. No office-backend changes are authorized by this roadmap.

## Current foundations

AiDraftNotes contains summary, decisions and actionItems. Office notes persist all three with frozen readership; decision extraction/storage already exists. Decision lifecycle (tentative/confirmed/superseded), shared tasks, dependency links, reporting relationships and out-of-office windows do not exist yet. The transcript demo has saved per-reviewer task proposals, not shared task ownership or external Planner/Slack synchronization.

## Implementation sequence and effort

Estimates are focused developer hours for a fictional single-user demo reusing the existing server, not calendar commitments. They include ordinary implementation and local checks; unfamiliar integration issues can increase them. The additional end-to-end testing estimate covers cross-feature flows and semantic evaluations.

| Sequence | Slice | Estimate | Observable result |
| --- | --- | --- | --- |
| 1 | Typed AI panel and shared fictional workspace | 2–3 h | Text submission plus Conversations, Helper, Dependencies, Overlap, Brief, Decisions, Meeting prep buttons |
| 2 | Dependency radar | 4–6 h | Evidence-linked blockers and reviewed priority suggestions |
| 3 | Overlap discovery | 3–5 h | Duplicate candidates, comparison, link-existing or keep-separate review |
| 4 | Decision questions | 3–5 h | Cited answers, conflicting assumptions and explicit unknowns |
| 5 | Daily/catch-up briefs | 3–5 h | User-requested time-windowed summary tailored to project/role preferences |
| 6 | Open questions and meeting preparation | 2–4 h | Unresolved questions and a proposed agenda with sources |
| 7 | Cross-feature acceptance and quality evaluation | 4–6 h | Repeatable scenarios, browser flows, small bounded Gemini acceptance set |

Total: approximately 21–34 focused hours for the full demo, roughly 3–5 working days for one developer. The panel plus dependency/overlap story is approximately 9–14 hours. Office integration needs a separate design and estimate after checking the team's current frontend, shared tasks, identity and permissions; expect additional days rather than treating it as a toggle. External Teams/Planner delivery and voice are excluded.

## Dependencies and priority

Separate base priority and hard due date from suggested coordination urgency. The user sees both the input reasons and the resulting suggestion. More distinct active people blocked can raise the suggested urgency, but it must not override a critical deadline automatically. Repeated mentions by one person do not increase the count. Closed/completed/retracted dependencies do not count. Self-dependencies and cycles are flagged rather than recursively escalating scores. AI proposes semantic dependency links; deterministic code computes the score from reviewed links. The exact weights remain adjustable and must be agreed before treating a score as authoritative.

Cards show task owner, blocked work, distinct affected people, supporting discussion, confidence/uncertainty, and approve/dismiss. Scanning does not mutate the to-do list. Applied changes retain previous values and source revisions for undo/stale-update protection. In a real workspace, private dependencies must not reveal participant names or task details without access; a restricted project may require an explicitly shared coordination signal.

## Duplicate/overlap review

Match semantic intent, project, deliverable, scope, status and timing, not text similarity alone. Two people reviewing the same design may be intentional; frontend and backend subtasks are not duplicates. A possible match offers compare, link to existing work, keep separate, or request transfer. Do not delete or suppress a task merely on a model judgment.

After the user confirms it is the same work, linking prevents a second canonical task and may add the user's distinct dependency. Repeated linking is idempotent. Notify the owner only after a confirmed coordination action, following their interruption preference. Ownership transfers need acceptance from the affected owner; they are not chatbot edits. Real delivery, shared state and cross-user enforcement require backend approval.

## Decisions chatbot

Retrieve authorized decisions and relevant evidence before answering. Track scope, date, status and supersession. Answers cite sources and distinguish explicit decisions from inferred assumptions. Later discussion is not automatically authoritative over a confirmed decision. Conflicting sources produce a clarification question; missing support produces "I don't have a confirmed decision." Ask or propose an agenda item rather than silently writing a new decision. Chat is read-only by default.

## Briefs and role tailoring

Daily brief: selected local-day interval. Catch-up: user-specified absence interval. Resolve boundaries in the user's timezone including DST; do not equate 24 hours with a calendar day. Separate changed decisions, blockers, commitments and unresolved questions. Omit already-dismissed/completed items when appropriate. Managers may prefer project risk and dependencies; interns may prefer assigned work and immediate context, with optional expansion into other authorized topics. Every important point cites its origin. Supervisor scope changes are explicit preferences and cannot widen readership. No employee ranking, attendance inference or productivity scoring.

## Open questions and meeting prep

Questions retain source, project, status and any supported answer/superseding question. Tentative suggestions do not become confirmed decisions. A user-requested meeting-prep action collects relevant open questions, conflicts, dependency decisions and desired outcomes into an editable agenda. Different-meeting/project items are excluded. Do not create a calendar event, assign an owner or send an agenda without a separate approved action.

## Proposed modular boundaries

- authorized context adapter: fixed fictional workspace first; office adapter later with server-enforced readership.
- retrieval: shortlist accessible tasks/notes by project and time before an LLM call.
- analysis: dependency/overlap/decision/question/brief typed results with evidence IDs.
- validation: strict schema plus valid source, user, task, lifecycle and time-window references.
- deterministic policy: scoring, interruption rules, revisions, idempotency and access checks.
- review/action: read-only results first; explicit reviewed mutations with undo in the demo.
- AI panel: typed intent selection and frequent-action buttons sharing the same handlers.

Reuse the Gemini provider, timeout/response bounds, usage tracker and request guard. Never add an OpenAI fallback. Prefer one bounded request per explicit action; retries require a user request, and the quota circuit breaker still applies. Do not send the entire workspace as context.

## Test matrix and current status

| Area | Required scenarios | Status |
| --- | --- | --- |
| Relevant conversations | valid evidence, unknown sources, duplicates, empty matches, malformed JSON, bounded input, no client-supplied private corpus | Existing tests plus expanded validation coverage |
| Helpers | valid skill/source link, unknown person, unrelated discussion, duplicate people, empty helpers, no inferred availability | Existing tests plus expanded HTTP coverage |
| Interruptions | explicit opt-in and Available only, Away/Meeting/DND hold, preference reload, malformed storage, no AI calls from status changes | Existing policy/browser tests plus expanded checks |
| Explicit invocation | no inference on load/typing/presence/reload, one request per submit, shared active-request guard | Expanded automated/browser checks |
| Dependency radar | distinct-person count, duplicate mentions, removed blockers, deadlines, completed tasks, cycles, review/undo, restricted evidence | Planned; feature not implemented |
| Overlap | paraphrased duplicate vs similar subtask, different projects/time, completed work, intentional paired work, link idempotency, owner transfer, stale revisions | Planned; feature not implemented |
| Decisions | absent decision, tentative vs confirmed, scoped conflicts, explicit supersession, correction, evidence support | Planned; chatbot/lifecycle not implemented |
| Briefs | timezone/DST boundaries, absence interval, no updates, deduplication, changed/completed work, role detail vs access, supervisor preference | Planned; feature not implemented |
| Open questions/agenda | unresolved/answered/reopened, tentative answer, project relevance, source links, no automatic calendar/send | Planned; feature not implemented |
| Shared failures | quota, timeout, malformed provider output, prompt injection, auth, cancellation, bounded payload, no automatic external effects | Existing provider tests; extend for each new analysis path |

Tests for future features must call actual contracts/services once implemented. Do not count TODOs, reference replay or tests of expected fixture data as proof of working behavior. Prepare hand-labeled scenarios first, then assert those expectations against implementation and bounded live model output. Valid IDs are not proof of semantic correctness.

Quality measurements: false/missed dependencies, wrong duplicate merges, incorrect task owners, unsupported decision answers, missed conflicts, unanswered-question classification errors, briefing coverage, unauthorized disclosure (zero tolerance), request count, latency and reported tokens. Keep a held-out scenario per major feature and report heuristic scoring limitations.

## Example integrated acceptance story

A user asks the panel to review speaker-attribution work. It finds Cameron's existing task and supporting discussion, suggests linking Nathan's preview dependency, and explains the suggested urgency increase. Nathan reviews and confirms the link. The simulated owner inbox respects DND. A decision query answers whether video is in scope with citations or flags conflicting evidence. A requested catch-up brief summarizes the changed dependency, decision and unresolved retention question. Meeting prep turns the unresolved items into an editable agenda. No real user is contacted and no automatic inference happens between explicit requests.
