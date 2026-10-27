# AI integration checklist — Nathan

Reviewed baseline: main at 76a27f2a44545ca34becc786ba485ebad598135f. Current transcript-demo implementation and verification: see AI_TRANSCRIPT_DEMO.md. Historical baseline notes below are retained as historical results, not current state.

Scope: audio/transcript inputs, extraction, notes, message drafts, task proposals, and integration boundaries. Checked boxes mean implementation inspected in source; live acceptance is separate. The earlier offline prototype is preserved at ../local-work/conversation-pipeline. Reuse this repository's worker and contracts instead of transplanting the standalone server.

## Already implemented — reuse

- [x] TypeScript worker with leased capture/summary jobs and authenticated internal API.
- [x] LiveKit subscribe-only assistant restricted to consenting speakers in one private meeting room.
- [x] Per-speaker PCM capture, in-memory WAV chunks and transcription requests.
- [x] Configurable OpenAI-compatible transcription and strict-schema summary endpoints/models. Arbitrary model APIs are not interchangeable without an adapter.
- [x] Structured summary, decisions and action items, including supporting segment IDs and nullable owner/due timestamp.
- [x] Output validation for schema, evidence IDs and authorized owners.
- [x] Unanimous consent, roster revisions, withdrawal/cancellation, worker authorization checks and stale-result rejection.
- [x] Durable notes, frozen readership, authenticated read endpoints and private completion events.
- [x] Confirmed AI action items can become self-owned reminders using the existing reminder form/service.
- [x] Durable reminder scheduling, retry/outbox, mutation idempotency, revision checks and offline catch-up.
- [x] Verification UI for consent, notes and reminders; this is not a finished Phaser frontend.
- [x] Raw audio is not written to disk by the capture implementation. Temporary transcript records are cleared on completion/cancellation; logical deletion is not forensic erasure from SQLite/WAL/backups.

## 1. Establish the baseline and live AI path — P0

- [x] Install dependencies on this review host using a writable temporary npm cache; SQLite-backed automated tests execute. Native live RTC transport remains a separate smoke test.
- [x] Run typecheck and the complete automated suite: TypeScript passes; 179 tests pass across 21 files.
- [x] Fix scripts/build-media-harness.mjs using fileURLToPath; Windows production build passes from the project path containing spaces.
- [ ] Start server, LiveKit and AI worker with distinct session/media/worker secrets. Confirm readiness and job dispatch.
- [x] Configure Gemini native API and a server-side credential. Current model is gemini-3.5-flash-lite; live structured extraction acceptance is tracked separately below.
- [ ] Run the isolated synthetic audio smoke described in worker/README.md. It verifies transport, not real model quality.
- [ ] Run actual credentialed transcription and structured-summary calls, including provider-specific schema compatibility and failure responses.
- [ ] Complete docs/M4_AI_CHECK.md with two human speakers and retrieve the note as both authorized participants.
- [ ] Verify denial to an unrelated guest, consent refusal, withdrawal mid-request and new-entrant stale-result rejection on the running stack.

## 2. Repeatable text-first AI development — P0

- [x] Add fictional, speaker-labelled transcript fixtures and an executable runner using this repo's AiTranscriptSegment and AiDraftNotes contracts.
- [x] Offer clearly labelled mocked versus real-model modes; the earlier deterministic rules parser is not an AI model.
- [x] Keep input adapters, model calls, validation, review and delivery separately testable. Later sources can include LiveKit or authorized Teams text.
- [x] Supply conversation/session timestamp, IANA timezone and authorized user-ID/display-name mapping to the model. Actual office summary jobs and fixtures now include context; legacy jobs stay compatible.
- [x] Preserve useful source references and expose stage status/errors without dumping credentials or complete private transcripts into ordinary logs.
- [x] Keep fixture ingress restricted to development/test use; do not expose an unauthenticated production injection endpoint.

## 3. Extraction behavior and quality — P0

- [ ] Define expected outputs for commitments, decisions, questions, blockers, uncertainty, declined actions and irrelevant small talk. Empty useful output is valid.
- [ ] Add a labelled regression dataset with expected message/task outputs rather than testing only canned model responses.
- [x] Implement fixture scoring for missed/extra actions, owners and deadlines, plus latency/tokens/free-tier cost estimates; nonzero exit flags mismatches. Live model acceptance is separate from offline replay.
- [ ] Resolve ownership through the authorized roster, never a guessed identity; include pronouns and named third parties in evaluations.
- [x] Supply clock/timezone, conservative relative-date prompt rules, and tomorrow/next-Monday/DST/ambiguous-deadline fixtures. Verify actual model output with live evaluation.
- [ ] Apply later corrections and withdrawals; deduplicate action proposals across chunks and conversations without merging unrelated tasks.
- [ ] Check semantic support of each claim. A valid evidence ID does not prove the model's claim is accurate.
- [ ] Evaluate multiple speakers, overlapping speech, noise, accents, brief silence and names relevant to the demo.
- [x] Add mocked provider tests for refusals/safety, malformed JSON, invented IDs, request/stalled-body timeouts, truncation, prompt-injection boundaries, quota/auth/server/network failures and cancellation. The quoted-injection fixture also supports live evaluation.

## 4. Message drafts — missing capability, P1

- [ ] Add a proposal contract: ID, author, recipient candidate/verified recipient, body, purpose, source note/segments and review status.
- [ ] Extend shared schemas, worker prompt, provider output validation, server completion validation and storage together. Current output has no message field.
- [ ] Generate targeted follow-ups, not wholesale meeting-summary forwarding. Relevance is not permission to disclose.
- [ ] Hold ambiguous recipients for user selection. Office guest IDs need a separate verified Microsoft identity mapping.
- [ ] Add editable review/discard/approve controls in the product frontend and persist drafts with appropriate readership.
- [ ] Keep model generation independent from sending; an extracted instruction must not execute an external action.
- [ ] Test recipient mistakes, draft revisions, cancellation, unauthorized access and no-send-before-review.
- [ ] Keep unsent drafts in our app unless a supported native Teams draft mechanism is established. The current chat connector cannot save native unsent drafts.

## 5. Tasks and reminders — P1

- [ ] Decide whether the hackathon uses existing self-reminders, general tasks, or both. A required-date reminder is not a shared Planner task.
- [ ] Reuse ReminderService and the existing confirmed-action-item flow for self-reminders; do not create a second scheduler.
- [ ] If general tasks are needed, define title, optional deadline, owner, status, source and create/update target; do not invent deadlines to fit reminders.
- [ ] Add review/edit/approve/discard for the selected destination and preserve the approved proposal revision.
- [ ] Match existing tasks conservatively; save external IDs and block ambiguous updates.
- [ ] Add a durable external-action ledger/outbox with idempotency and reconciliation after uncertain network outcomes.
- [ ] Test repeated approval, lost responses, stale edits, cancellation and restarts without duplicate creation or overwriting newer updates.

## 6. Informal conversations — missing scope, coordinate with backend/media

- [ ] Decide whether private meeting-room notes suffice for the first demo. Current AI capture and assistant media authorization require meeting rooms, not floor-side conversations.
- [ ] For informal notes, define a bounded opt-in huddle/group and explicit membership. Proximity and playback volume alone are not authorization boundaries.
- [ ] Extend existing consent/roster/media/readership machinery rather than recording the entire office.
- [ ] Define start/finalize/pause/cancel behavior when people move, join, leave or reconnect.
- [ ] Address short-conversation loss: incomplete chunks and pending provider work are discarded on stop; short exchanges can yield NO_TRANSCRIPT, and finalized notes are marked partial.
- [ ] If required, add a consent-preserving final flush for ordinary stop while keeping withdrawal as cancel/discard. Verify it does not admit audio from a new roster.
- [ ] Measure provider backpressure. Current bounded capture fails rather than queues indefinitely when transcription falls behind; tune or extend only from observed behavior.
- [ ] Test adjacent independent conversations, passersby, overlap and changing membership without cross-group capture or disclosure.

## 7. Microsoft integration — conditional on approved access

- [ ] Obtain an authorized Entra app registration/test tenant. The local app cannot reuse ChatGPT's Microsoft connector session.
- [ ] Select an appropriate authentication flow with the backend owner, including account binding, session expiry and revocation. Request only scopes for implemented actions.
- [ ] Confirm office-user-to-Microsoft-user identity mapping; do not treat model-generated names/emails as authoritative.
- [ ] Discover/select an accessible basic Planner plan and bucket; create one approved test task and retain its external ID.
- [ ] Support reviewed updates with ETags/conflict handling and external-state synchronization; snapshot polling is not a complete audit history.
- [ ] If sending is in scope, confirm exact recipient/content and add an authenticated delivery adapter. Review UI remains in our app.
- [ ] Test wrong tenant, expired/denied consent, inaccessible plans, throttling, timeouts and retry reconciliation.
- [ ] If blocked by institution policy, label export/manual connector delivery as a fallback; do not claim autonomous Microsoft integration.

## 8. Full acceptance and team handoff

- [ ] Demonstrate fixture transcript -> validated notes -> edited message and task -> explicit approval -> intended destination.
- [ ] Repeat with real consented LiveKit speech, including very short conversations and late corrections.
- [ ] Verify saved notes/reminders survive restart and stay inaccessible to unrelated users.
- [ ] Record results against a commit, model/config names, observed latency/cost and known limitations without including secrets.
- [ ] Agree frontend/backend contracts for AI events, schemas, review UI, identity and delivery. Nathan owns model/extraction/evaluation; media-group authorization, persistence and authentication require coordinated changes.
- [ ] Keep video independent of AI completion. Current grants permit microphone publication; video is not required to produce notes or follow-ups.

## Deferred by request — future requirements, not current implementation

- [ ] Encryption at rest, key management, deployment/backup protection and deletion/retention guarantees.
- [ ] Provider retention/training controls or approved local inference. Encryption does not stop a remote inference service from seeing input plaintext.
- [ ] Separate participant permission/data governance for training your own model; note-taking consent is not training consent.
- [ ] Reading unread Teams conversations: additional scopes, bounded retrieval, context/ownership, deduplication and review.
- [ ] Additional provider APIs, a conversational shared colleague and voice replies unless explicitly selected for the demo.

## Source map

- shared/src/ai-worker.ts: strict worker and output contracts.
- worker/src/providers.ts: transcription, summary prompt, provider output validation.
- worker/src/audio.ts: LiveKit capture, chunk boundaries and backpressure.
- worker/src/runner.ts: authorization checks, cancellation and processing lifecycle.
- server/src/services/AISessionService.ts: consent, jobs, notes completion and stale results.
- server/src/repositories/AIRepository.ts: notes/transcript persistence and readership.
- server/src/services/ReminderService.ts: user-confirmed self-reminders and durable delivery.
- tools/media-harness/main.ts: existing notes/action-item review and reminder form.
- docs/M4_AI_CHECK.md and docs/M5_REMINDERS_CHECK.md: manual acceptance procedures.

## Verification record for this review

Git clone and git pull --ff-only succeeded; main is up to date at the reviewed commit. Initial npm installation failed on a Windows cache rename and native-build fallback. A retry using a writable temporary cache installed 251 packages. TypeScript typecheck passed. All 179 tests pass across 21 files after overriding the test process TEMP/TMP to a writable temporary directory. The default sandbox temporary path initially caused Vitest EPERM rename errors before any tests executed. Production build FAILS in scripts/build-media-harness.mjs: .pathname produces /C:/.../BYU%20AIA/... on Windows; esbuild cannot resolve that entry point. Use fileURLToPath for both entryPoints and outfile, then verify again. No application source files were changed or fixes applied. Docker's Linux engine is not running, so live Compose/media smoke/two-person/provider tests are not verified in this review. Historical README/CI claims are not fresh local results.


## Phase 1 execution update
Windows build fix applied and build passes. A private local .env was created with fresh secrets and AI disabled. Native RTC loading and the live application SDK smoke passed. Docker startup was attempted but the engine remains unavailable. No provider credential is configured, so paid API requests, live notes and human speech/withdrawal acceptance remain blocked. See AI_LOCAL_SETUP.md for exact commands and design decisions. The preceding verification record describes the initial review, before this execution pass.

Current transcript extraction acceptance: Gemini 3.5 Flash-Lite with AI_GEMINI_OUTPUT_MODE=json passed all seven live text fixtures on prompt meeting-actions-v3 (zero missed/extra actions or owner/deadline errors; 4.6-second mean latency). See AI_TRANSCRIPT_DEMO.md for the report path, token counts, automated test results, and limitations. Full LiveKit audio acceptance and message delivery remain outstanding.

Message/task preview implemented: see MESSAGE_DRAFT_PREVIEW.md. A separate follow-up contract and deterministic post-extraction composer now support reviewer identity, suggested recipients, editable message/task drafts, saved approval/discard/restore state, revisions, cited evidence, and approved-only JSON export. Transcript demo and CLI are wired; live office UI integration and external delivery adapters remain separate. Verification passed 234 tests, typecheck, build, eight offline fixtures, and the browser review/export/reload flow without Gemini calls.
