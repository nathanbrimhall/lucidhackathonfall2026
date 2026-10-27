# Shared office agent: implementation and rehearsal

Implemented October 27, 2026 against the roadmap's first deliverable slice. Later opt-in monitoring, external tools, personal agents, voice, and skill learning remain deferred. The existing explicit assistant and consent-based transcription worker retain their separate behavior.

## Run it

Use Node 24 and `npm run office:dev` for a persistent office, or `npm run office:demo` for the loopback-only, in-memory fictional office. Open **Shared agent** in two different browser sessions. The default fixture adapter runs inside the server, requires no provider key and consumes no model requests.

1. Requester: enter a goal, select shared task sources and up to two named contacts. Starting authorizes only these in-office questions. The draft audience is the requester; publication requires a separate exact-revision review.
2. Recipient: open Shared agent. Questions survive disconnect and appear even if immediate interruptions are disabled. Choose Reply, Decline or Later. Answer use defaults to requester only; explicitly select requester and office publication if appropriate.
3. For the deterministic fixture, supply the confirmed scenario fields with one label per line. Different contacts may supply different fields:

   ```text
   Office URL: https://your-confirmed-office-address.example
   Join instructions: Open that address and use the invite supplied by the host.
   Near audio: Stand together and check both voices.
   Far audio: Walk six tiles apart and check fading.
   Private-room audio: Enter together; a third person outside must not hear.
   Known issues: Playback may require a click.
   ```

   These are fictional sample instructions. Use real, confirmed details for the human rehearsal. Supplied URLs are not independently verified. Missing or conflicting fields leave a partial draft that cannot be published.
4. Requester: open authorized activity, inspect the attributed answer and source revisions, then approve and publish, reject publication, request edits or stop. Saving an edit creates a fresh revision. Published results appear in the office panel once; rejected results remain private.

Fixture mode applies explicit `Title: …` and `Section: <scenario heading> = <replacement>` commands. Its six scenario fields are editable; source and uncertainty sections stay intact. Unsupported prose is visibly marked unapplied and leaves the draft partial. Live turns receive the actual edit comments and current artifact revision. A declined contact is not replaced by another contact to bypass the decision. There are no reminders or automatic repeated questions.

## Explicit live worker

The worker now supports the pinned Hermes `AIAgent` programmatic API in a separate process. Its only enabled tool submits scoped questions and/or a draft for office-server validation; human questions terminate that turn. Each continuation starts with a fresh home/session and current authorized office state. Memory, profile/context loading, background review, title generation, tool search, external tools and provider fallback are disabled. A one-use local provider gateway routes Gemini requests through the existing shared usage tracker and prevents extra provider dispatches. Stop kills the child process; the server independently rejects late lease results. See [the worker setup and source pin](../agent-worker/README.md).

The exact pinned runtime passed seven dependency acceptance checks with a synthetic counted provider: question plus independent draft, fresh-process continuation, disabled tools/memory/credentials, rejected non-proxy networking/subprocesses, shared daily cap, provider failure, and cancellation. The report is `data/ai-eval/hermes-verification-latest.json`: six synthetic provider dispatches, zero paid requests, zero skipped tests. This verifies runtime integration. A subsequent bounded live check on October 27 at 15:51 MDT passed through Hermes with exactly three real `gemini-3.6-flash` requests: scoped question, durable wait without inference, supplied-answer incorporation, and requested title edit on a new evidence-linked revision. The previous approval revision returned 409. The run used two synthetic authenticated accounts and zero separate devices; real-person acceptance remains open. See `data/ai-eval/agent-live-check-latest.json`. Python audit restrictions plus a verified clean source pin are not an OS sandbox for hostile Python.

Direct `gemini` remains an explicitly selected alternative. There is no automatic provider or runtime fallback, and a live worker cannot claim jobs for a different configured engine.

Set `AGENT_RUNTIME=hermes` (or explicitly `gemini`) and a distinct `AGENT_WORKER_SECRET` of at least 32 characters in the server environment. Set those same values for the separate worker, along with `AI_PROVIDER=gemini`, `GEMINI_API_KEY` and the existing worker configuration. Both processes must use the same absolute `AI_USAGE_DATABASE`, credential and daily limit. Hermes additionally requires `AGENT_HERMES_SOURCE_ROOT` at the exact clean pinned checkout and `AGENT_HERMES_PYTHON` pointing to its installed environment. The worker README provides installation and `npm run agent:verify:hermes` verification steps. Restart the office and run:

```sh
npm run agent:dev
```

The built command is `npm run agent:start`. `AGENT_SERVER_URL` defaults to `http://127.0.0.1:2567`; remote worker control requires HTTPS. The worker can run locally beside a shared office, independently of the audio worker. A live assignment may use at most six requests; each claim durably reserves one before dispatch, and the provider reserves the shared daily limit immediately before calling Gemini. Failed/aborted requests remain counted. Idle and human-waiting states use zero model requests. Each turn has a 45-second execution timeout, a 90-second lease, cancellation checks every second and no hidden retries, auxiliary calls or nested tools.

A provider key remains only in server/worker environments. The runtime receives only the selected task fields and this assignment's explicit answers, artifact and review comments. Notes, private messages, microphone data, prior assignments, runtime memory, terminal, browser, external messaging and delegation are unavailable.

## Persistence and API

Migration 005 adds runs, requests, versioned artifacts, ordered events, outbox records and immutable review decisions. Migration 006 retains immutable answer revisions and each revision’s explicit publication grant, including answers already stored before the upgrade. Short immediate transactions serialize claims, responses, cancellation and publication. No transaction is held across a model call or human wait. A SQLite unique index permits one active office assignment. A restarted fixture turn is safe to replay; an expired live execution becomes partial with an uncertain-outcome message and is never automatically retried.

Authenticated browser endpoints:

| Method/path | Meaning |
| --- | --- |
| `GET /api/agents` | Own assignments, recipient inbox, office publications, generic shared status and configured runtime |
| `POST /api/agents/runs` | Explicit scoped assignment with request ID, goal, task IDs, up to two contact IDs, mode and cap |
| `GET /api/agents/runs/:id?cursor=N` | Requester-only detail plus durable event replay |
| `POST /api/agents/requests/:id/respond` | Intended recipient’s answer/decline/later with explicit publication grant |
| `POST /api/agents/requests/:id/revise` | Original respondent’s voluntary corrected or shareable replacement, bound to the current answer revision |
| `GET /api/agents/requests/:id/versions` | Answer history, accessible only to its respondent and assignment requester |
| `POST /api/agents/runs/:id/cancel` | Requester stop using current run revision |
| `PATCH /api/agents/runs/:id/artifact` | Requester edit using current artifact revision and evidence |
| `POST /api/agents/runs/:id/review` | Requester approve/reject/request-changes on exact artifact revision |

An initial turn can persist both scoped questions and an independent partial draft atomically. Each new reply queues one continuation even while another request remains open; saving progress returns the assignment to waiting. Polling, reconnects and presence changes never schedule model work. A response arriving during execution invalidates the older lease, so stale work cannot overwrite the new answer. The model request already reserved for that older turn remains counted.

Answered requests remain available to their respondent as optional correction cards while the assignment and request are still active. Only that respondent may replace the complete answer and explicitly choose the new audience. Corrections increment the answer revision, preserve private history, supersede the draft, invalidate review, and rebuild from current answers without the superseded draft or older edit comments. Stale evidence and approvals fail. Declines, expired requests, cancellation and completed publication stay closed; the agent sends no repeated correction requests or reminders.

The distinct worker secret authenticates `/internal/agents/jobs/claim`, `/:id/context`, `/:id/complete` and `/:id/fail`. Browser sessions cannot use worker endpoints, and worker routes reject browser origins. Questions persist before any notification. Notifications require a connected, available, opted-in person outside meeting audio. The inbox remains available when a notification is suppressed. An initial private notification is attempted once; reconnect retrieves durable inbox state.

Approval and office publication occur in one transaction. The action is fixed to publication inside this office; no arbitrary action/tool payload is accepted. The review record binds the artifact revision, audience and decision. Approving expires 24 hours after artifact creation; save a fresh revision to review again. Publication rechecks membership, task revisions and every answer's audience grant, including answers whose citations were removed. Human prose cannot grant permission. Partial/open-question drafts cannot publish. Cancellation prevents subsequent worker results and late replies from acting.

The server owns a separate Colyseus `agents` collection with one nonblocking avatar. It walks reachable routes deterministically and returns home when idle. The public payload contains only ID, badge, coordinates, generic state and sponsor ID. Questions, task titles, answers and artifacts are never broadcast. The avatar never enters player or audio rosters, and walking does not control request correctness.

## Evidence and remaining gates

Final `npm run office:verify` passed 376 tests in 44 files and all three browser checks (integrated office, manual demo, and agent workflow), with zero live API calls in that suite. Five optional installed-Hermes checks are skipped in the dependency-free run; the dedicated installed-runtime verifier separately passed all seven checks with zero skips. Run it to reproduce the offline regression suite plus the new two-context agent browser check. `npm run smoke:agents` runs that browser path alone after a frontend build. Service and runtime tests cover wrong users/offices, exact revision review, restricted answers, cancellation, duplicate responses/publication, source changes, multiple pending questions, expiry, restart and uncertain leases, counted provider failures and daily caps.

`npm run agent:live-check -- --live` is a separate explicitly live check (two requests). Add `--runtime hermes --edits` for a three-request maximum check of the pinned runtime and actual requested editing. It uses an isolated fictional office, two synthetic authenticated accounts and the selected maximum of existing-budget Gemini requests, never a provider fallback or quota reset. Its report is `data/ai-eval/agent-live-check-latest.json`. The first implementation check on October 27 returned HTTP 503 on one counted request and failed visibly without automatic retry. A later explicit check passed at 15:26 MDT with exactly two real `gemini-3.6-flash` requests: a scoped question, durable no-call wait, synthetic authenticated answer and an evidence-linked complete draft. Three provider attempts were consumed across these checks. The later Hermes check described above used three further real requests and verified the requested title edit. Human usability and separate-device rehearsal remain unverified; synthetic accounts cannot establish those gates.

The automated browser check uses two separate browser contexts on one computer. It establishes the cross-user UI contract, recipient reconnect, answer incorporation and exact approved publication; it does not establish human usability, two laptops, shared HTTPS/audio deployment, or real recorded meetings. Before claiming the demo complete, record the actual participants, devices, office URL, runtime/model version, request count, supported output, approval outcome and failures from a two-person rehearsal in the persistent office. Never describe `office:demo` as cross-device or restart durable.

## LAN hosting and human acceptance

The intended shared deployment is the requester’s laptop on the collaborators’ LAN. Use the persistent office and reachable HTTPS/WSS addresses, with certificate trust on each device and correctly advertised LiveKit media ports. See [LAN setup](OFFICE_LAN.md) and the [M5/M6 acceptance record](AGENT_ACCEPTANCE.md). The read-only deployment preflight and human-record validator support this workflow; neither can attest to separate-device audio or human acceptance on its own. Those observations remain required.
