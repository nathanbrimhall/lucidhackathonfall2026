# Typed AI panel, dependency radar and overlap review

## Implemented

The Conversation Lab now has a typed collaboration panel and quick buttons for Dependencies, Overlap, Conversations and Helpers. Typing/selecting options is local; only Submit runs analysis. Conversations/Helpers reuse the existing Gemini discovery path. Dependency/overlap offer a no-cost reference scenario or one bounded live Gemini request. Decision-and-assumption verification, daily/catch-up briefs and meeting preparation are now available as read-only actions; see AI_KNOWLEDGE_TOOLS.md.

A shared fictional workspace holds tasks owned by Nathan, Cameron, Maya and Jordan. It is stored in memory per demo-server instance, survives browser refresh, and resets on server restart. It is separate from the persistent transcript review database and from real to-do lists. There is no office-backend integration or external sending.

## Dependency radar

The reference scenario identifies three distinct people blocked by Cameron's speaker-ID export. The model proposes links with discussion/excerpt IDs; strict validation checks known tasks, active state, project, unique evidence and graph cycles. It cannot write a priority or reassign owners. Cross-suggestion cycles are checked as a graph, not just one edge at a time.

Current and proposed coordination urgency are calculated in code. One distinct other person waiting raises low to medium; two or more raise it to high. Existing higher base priority is retained. Original deadlines are unchanged; the UI displays both base priority and coordination urgency. Critical work is not demoted. This is a transparent demo policy, not a finalized organization-wide priority formula.

Confirm one link or all reviewed links. The entire set's preview is labeled as such. Base priority is unchanged and urgency is derived from the approved links. Repeated mentions or multiple dependent tasks owned by one person count once. A person linked through both a dependency and a duplicate request is also counted once. Completed work and self-owned work do not add beneficiaries.

## Overlap review

The reference candidate is Nathan's proposed speaker-ID export; Cameron already owns the existing export. Analyze does not add Nathan's proposed task to active work. Confirming a duplicate links the proposal to the existing task, adds Nathan as a distinct requester, recalculates urgency and records one quiet simulated inbox notice for Cameron. The original task stays with Cameron. The proposal is retained as linked history, not deleted.

If the overlap is intentional or only superficial, choose Keep as separate task. No owner notice is created. Neither action performs a transfer. A real ownership-transfer workflow remains out of scope.

## Review and undo

The server retains validated analyses and accepts only their ID, finding index, action and expected workspace revision. The client cannot replace task owners, supply private context or forge a finding body. Stale/concurrent reviews are rejected with 409. Double application cannot create another notice. If another action was applied, rerun analysis before applying more findings; Confirm all reviewed dependencies reduces extra model calls.

Undo restores the previous task/notification state and increments the revision, invalidating earlier findings. Only the last workspace action can be undone. The history is bounded to 30 actions and the retained analysis set to 20 entries. A fresh server starts from the fictional seed. Existing transcript proposals are unaffected.

## Manual acceptance with zero Gemini usage

1. Restart `npm run ai:demo` and refresh http://127.0.0.1:8788/.
2. Click Dependency radar. Leave analysis mode at Offline reference scenario and submit.
3. Inspect the three links and source excerpts. Confirm all reviewed dependencies.
4. Open Team task workspace: Cameron's speaker export should show 3 people waiting and high coordination urgency, with low base priority still visible. The critical sign-in task stays critical.
5. Undo. Cameron's coordination urgency returns to low.
6. Choose Check overlap and submit. Confirm duplicate and link.
7. Inspect Nathan's linked proposal, Cameron's medium urgency, and the quiet simulated task-owner inbox. Refresh to verify the reviewed state persists.
8. Undo; rerun overlap; choose Keep as separate task. Nathan's proposal becomes open without an owner notice.
9. To try arbitrary fictional prompts, select Live Gemini before submitting. One live request per submission; the same daily tracking, quota pause, session cap, active-request guard and cooldown apply to all AI paths. No automatic fallback or retry occurs.

Offline reference mode ignores prompt semantics and only demonstrates the fixed scenario. It is not a model-quality evaluation. Invalid or empty model output never applies task changes. A valid source ID does not prove semantic support: reviewers must check cited excerpts.

## Verification

Source and route tests cover no-mutation analysis, unique-person counts, deadlines/base priorities, active states, project boundaries, cycles, source validation, forged review requests, stale/double review, duplicate linking, separate tasks, undo, refresh, provider quota failures and shared request limits. The new panel browser smoke covers explicit invocation, review/undo, owner notices, keep-separate, refresh, one mocked live request and network failure.

The existing transcript smoke now scopes its action-card assertions to the transcript result, since workspace task cards share the action style. The existing `npm run ai:verify` command now includes both collaboration browser suites in addition to full tests, typecheck, build and offline fixtures. Without `--live`, these checks make no real provider calls. Run in a terminal with a writable TEMP/TMP if needed on Windows.

## Source map

- tools/ai-demo/workspace.ts: fictional tasks, evidence/graph validation, scoring, analysis snapshots, revisions and undo.
- tools/ai-demo/coordination.ts: typed panel requests, reference scenarios and bounded Gemini analysis.
- tools/ai-demo/ai-panel.js: typed UI, review cards, workspace and simulated owner inboxes.
- tools/ai-demo/app.ts: localhost-protected demo endpoints and shared request limits.
- worker/test/coordination.test.ts and worker/test/ai-panel.test.ts: new unit/HTTP checks.
- tools/ai-demo/panel-browser-smoke.mjs: interactive acceptance without live Gemini calls.

Office backend files were not changed for this implementation. Real shared task state, readership and cross-device delivery require a separately approved office integration.

### Latest implementation verification

30 focused tests passed across coordination, panel HTTP, discovery, helpers and transcript demo tests. The panel browser suite, discovery/helper/interruption suite, and original transcript edit/approve/export browser suite passed with no real Gemini calls. Final typecheck/build/full-suite verification was blocked by automatic approval review after an unspecified external telemetry connection was detected, including on the standalone compiler check. Those blocked checks were not claimed as passed. The known test type assertion was corrected, but a final compiler pass remains unconfirmed.
