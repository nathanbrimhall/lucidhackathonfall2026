# Decision questions, briefs and meeting preparation

The typed AI panel now supports four read-only history tools. Restart `npm run ai:demo` and refresh http://127.0.0.1:8788/.

- Decision questions: ask what was decided, what was only assumed, and what recorded reasoning supported a decision. Confirmed, superseded, unverified, open and answered evidence stay distinct.
- Daily brief: select one local calendar date and summarize the recorded updates for that day.
- Catch-up brief: select an inclusive local-date range of up to 90 days.
- Meeting prep: propose questions and desired outcomes from unresolved issues and assumptions. It does not book meetings, send invitations or create tasks.

## Context and limits

This is a fixed fictional history for October 23–26, 2026, separate from office notes and the real company. The catalog demonstrates an audio-only decision with recorded rationale, a conditional Teams plan superseded by Slack-oriented local previews, an unapproved video assumption, an unverified model-training assumption, and an open retention question. A restricted fictional personnel record exercises access filtering. None of these records establishes current third-party policy.

History is filtered server-side for the selected fictional viewer before a model request. Role and project-detail settings tailor the brief; they cannot grant access. The viewer selector is a demonstration, not authentication. Real office integration must use the existing authenticated readership checks and requires Nathan's approval.

Decision Q&A and meeting prep use accessible history through the selected end date. Briefs filter record dates to the requested local-date window. Supersession is evaluated as of the selected local day: an October 23 check does not receive the October 24 replacement or its sources. This is calendar-day granularity, not intraday time travel. Date matching uses the requested IANA timezone, including repeated DST hours, without assuming a calendar day is 24 hours.

Current tasks are supplied separately and clearly labeled as a current workspace snapshot, not changes during the historical window. Contributors see their own active tasks and direct blockers. Expanded project detail shows additional accessible project work. There is no historical task-change log or actual supervisor-management UI yet.

## Output and safeguards

Every factual item references known records or current tasks. Record citations must match the selected record's available source excerpts. Recorded reasoning needs an actual reasoning source. Assumptions and superseded decisions cannot be labeled confirmed. Unknown evidence produces no supported claims; conflict answers need evidence from two positions. Meeting agendas may not contain only an already answered question, and duplicate evidence groups are rejected.

Validation proves reference/state consistency, not semantic entailment of generated prose. Users must inspect the supporting excerpts. Follow-up questions and desired meeting outcomes are suggestions. No knowledge tool changes tasks, decisions, ownership, availability, notifications or calendars. The existing coordination-review actions remain separate.

Offline reference mode renders the filtered catalog and sample agenda; it does not interpret arbitrary questions or measure model quality. Live mode interprets the typed question using the configured Gemini model, one request per explicit submission. It reuses request bounds, timeouts, persistent usage tracking, quota pause, cooldown and session cap, with no fallback or automatic retry. Typing, changing dates/role, choosing a quick action and preparing a follow-up question make no provider calls.

## Try everything without Gemini quota

1. Click Decision questions and submit in Offline reference mode. Inspect decisions, assumptions, recorded reasoning and supporting excerpts.
2. Set the end date to October 23. The conditional Teams plan is current as of that day; the later Slack replacement is absent.
3. Set the end date back to October 26. Choose Daily brief; both date fields will use that day.
4. Compare Contributor and Project lead detail with Nathan as viewer. Extra project detail appears, but restricted personnel content does not.
5. Choose Catch-up brief to cover October 23–26. Inspect the superseded and replacement decisions.
6. Choose Meeting prep. Inspect retention and assumption questions; the already answered destination question should not become an unresolved agenda item.
7. Use Ask this question on a follow-up. It fills the typed request but waits for explicit Submit.
8. To test semantic responses to custom questions, switch to Live Gemini. Each submission spends one request; wait for the shared cooldown.

## Modules and checks

- tools/ai-demo/knowledge.ts: fictional evidence, viewer filtering, date/role context, output schemas and state/source validation.
- tools/ai-demo/knowledge-runner.ts: offline catalog responses and bounded Gemini Q&A/brief/agenda requests.
- tools/ai-demo/coordination.ts and app.ts: shared panel inputs, validation before spending quota and read-only routing.
- tools/ai-demo/ai-panel.js: new buttons, role/date controls, citations, proposed agenda cards and explicit follow-ups.
- worker/test/knowledge.test.ts and knowledge-http.test.ts: unit/HTTP acceptance scenarios.
- tools/ai-demo/knowledge-browser-smoke.mjs: interactive checks without live API usage.

47 focused tests across seven files passed, as did the knowledge browser check. Coverage includes access vs role, as-of supersession, unknown evidence, rationale verification, input/output validation, local dates/DST, date windows, read-only behavior, shared budgets and quota errors. No real Gemini requests were made. Live semantic quality has not been evaluated. Full compiler/build/full-suite checks remain unconfirmed because of the earlier automatic telemetry-review block; those commands were not retried for this slice. The existing ai:verify command includes all collaboration browser suites for local verification.
