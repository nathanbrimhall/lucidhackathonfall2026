# M6 rehearsal runbook: two people, two devices, one host

This is the facilitator script for the human rehearsal required by M6 in [AGENT_ROADMAP.md](../AGENT_ROADMAP.md). [AGENT_ACCEPTANCE.md](AGENT_ACCEPTANCE.md) says what must be recorded; this page says how to trigger and observe each scenario in the persistent LAN office. Nothing here is evidence until real people on separate devices perform it and the observations are written into the record. Fixture answers, `agent:live-check`, `smoke:agents`, and automated browser contexts do not count.

Every mechanism below carries a **Verified in code** pointer so a maintainer can check it. Where the current code cannot do what the acceptance record asks, the step is marked **GAP**; do not work around a gap by editing the database or by relabeling the result.

## Roles

| Role | Does |
| --- | --- |
| Host | Runs the laptop (`npm run office:lan`), restarts it when told, watches terminals, records timestamps/screenshots, fills the JSON. May also be Person 1 if they sit at the host laptop; they must still be a distinct person from Person 2, on a different device. |
| Person 1 (requester) | Starts assignments, reviews drafts, stops assignments. |
| Person 2 (respondent) | The only contact the agent may ask. Answers, declines, changes availability. |

Use one named contact (Person 2) per assignment. With two contacts a fixture draft stays partial until both answer (`FixtureAgentRuntime`, `partial: ... answers.length < context.contacts.length`), which adds nothing to these scenarios.

## UI controls used (exact labels)

| Control | Where | Verified in code |
| --- | --- | --- |
| Top nav **Tasks**, **AI assistant**, **Shared agent** (badge shows open questions) | `.top-nav` | `frontend/main.ts` line 141 |
| Left nav **Office**, **People** | side panel buttons | `frontend/index.html` `data-panel` |
| **Propose shared work** modal: fields **Task**, **Proposed owner** | Tasks panel | `composeTask`, `frontend/main.ts` line 49 |
| Availability dock menu: **Available**, **Do Not Disturb**, **Away**. The HTML says "Busy"; the label is rewritten at runtime and the wire value is `busy` | bottom dock, `#status-toggle` | `frontend/main.ts` line 143; `PlayerStatus` in `shared/src/protocol.ts` |
| **Walk to meeting room** (Office panel); header then shows **In a Meeting** | Office panel | `frontend/main.ts` lines 108-115 and `changed()` |
| Checkbox **Show immediate inbox notices while Available** | Office panel | `frontend/main.ts` line 116 |
| Inbox card **A teammate needs information** with **Your answer**, **May this answer be used for** (**Requester only** / **Requester and office publication**), buttons **Reply**, **Decline**, **Later**; after answering, **Your answer can be corrected** with **Save corrected answer** | Shared agent panel | `renderAgents`, `frontend/main.ts` lines 84-100 |
| Start form: **Goal**, **Allowed shared tasks**, **People the agent may ask (up to two)**, **Maximum model calls**, **Run mode** (**Fixture demo** / **Live model**), **Start assignment** | Shared agent panel | same |
| Assignment card: **Open authorized activity**, **Stop assignment**, **Draft for review** textarea, **Save draft changes**, **Approve and publish**, **Reject publication**, **Request changes** text field with **Request edits**, **Refresh agent activity**; list **Published results** | Shared agent panel | same |
| Toast **A shared agent question is waiting in your inbox.** | recipient only | `frontend/main.ts` line 28 |
| Assignment card line `Usage: <modelCalls>/<max>` and `Status detail: ...` | Shared agent panel | same |

**Important UI behavior:** the Shared agent panel does not poll. It refetches on connect, on `agent.request`, after the viewer's own actions, and when **Refresh agent activity** is pressed (`refreshAgents` call sites in `frontend/main.ts`). Opening the panel does not refetch. Anyone observing another person's action must press **Refresh agent activity** first. Some scenarios below depend on this (the stale view).

## Gaps found while writing this runbook

1. **Approval and question expiry cannot be shortened.** Both are hard-coded 24 hours. No environment variable or config field exists. See scenario 7.
2. **Fixture mode cannot produce a provider or budget failure.** Fixture turns always report `modelCalls: 0` and never call a provider; the **Live model** option is disabled when `AGENT_RUNTIME=fixture`. See scenario 8.
3. **The record has a single `runtime.mode` and a single `modelCalls` total, capped at 6.** The validator rejects fixture mode with a nonzero count and rejects any total above six (`validateAcceptance` in `tools/agent-acceptance-check.ts`). A mixed fixture/live rehearsal, or a fully live rehearsal of all scenarios (roughly 7+ requests), cannot be recorded faithfully. See "Choosing fixture or live".
4. **No assignment or request IDs are shown in the UI.** Evidence IDs must come from screenshots with timestamps or from the DevTools Network responses of `GET /api/agents`.
5. **A busy or opted-out person gets no live indication.** The inbox is correct but only appears after reconnect or **Refresh agent activity** (see the note above). This matches the "persistent inbox item instead of an interrupting popup" intent but is easy to mistake for a failure.
6. **`serverVersion` has no source.** `/healthz` returns only `{status:"ok"}`; `/readyz` reports dependency status, not a version. Record the git commit. At the time of writing the working tree has uncommitted agent changes; rehearse from a committed build or `gitRevision` will not describe what ran.

## Pre-flight (Host, before the 45 minutes)

- [ ] Commit or otherwise pin the build; `git rev-parse HEAD`; confirm no unreviewed local edits. Record it.
- [ ] Follow [OFFICE_LAN.md](OFFICE_LAN.md): confirm the LAN IP, create the mkcert certificate, install **only** `rootCA.pem` on Person 2's device, free ports 8443/8444/7881/7882/7883, allow them in the firewall, ensure Docker Desktop is running.
- [ ] Start with `npm run office:lan -- --ip "$OFFICE_LAN_IP" --cert ... --key ...` and leave that terminal visible. Write down the exact command; you will rerun it verbatim in scenario 2.
- [ ] Run the deployment preflight from a machine that trusts the CA (`NODE_EXTRA_CA_CERTS=... npm run agent:deployment-check -- --allow-lan --office-url https://<ip>:8443 --livekit-url wss://<ip>:8444`). If `agent:deployment-check --record <file>` is available, use it to save the result; otherwise copy the printed outcome. It does not prove WebRTC, audio or people.
- [ ] Decide **fixture or live** (next section) and set it before starting. Fixture needs only `AGENT_RUNTIME=fixture` (the default in `.env.example`) and no worker. Live needs `AGENT_RUNTIME` set to `gemini` or `hermes`, a distinct `AGENT_WORKER_SECRET` (32+ characters, enforced in `loadConfig`), the shared `AI_USAGE_DATABASE`, and `npm run agent:dev` running in a second terminal ([agent-worker/README.md](../agent-worker/README.md)).
- [ ] **Consent to record.** Before anyone joins, tell both participants what will be kept (screenshots, the filled JSON, their names/roles, answers they type), where it is stored and who can read it, and get a yes from each. Participants should not type secrets or personal data into answers. Do not put invite codes or `.env` content in evidence.
- [ ] Both people join from separate devices using the printed `https://<ip>:8443` address and the invite code supplied privately. Confirm **People** lists both.
- [ ] Person 1: **Tasks** > **Propose shared work**, create one task (e.g. "Prepare demo launch brief"). It appears under **Allowed shared tasks**.
- [ ] Optional baseline for live mode: note `Gemini local usage: N/limit requests today (UTC)` in **AI assistant** (`frontend/main.ts` line 67) before the first assignment.
- [ ] Copy `docs/agent-acceptance-template.json` to a private path. If `agent:acceptance-init` is available, run it now to fill machine-observable fields; otherwise fill by hand. Audio checks (near, far, private room) are out of scope for this page; run them as the acceptance doc says.

## Choosing fixture or live

| | Fixture | Live |
| --- | --- | --- |
| Provider calls | None. Record `modelCalls: 0` and mode `fixture`. | Up to six per assignment; each claim reserves one before dispatch (`AgentRunService.claim`). |
| Scenarios 1-7 | Fully exercisable. Answers must use the labeled-field format below to produce a non-partial draft. | Exercisable, but cost and nondeterminism rise; "Request edits" is free text. |
| Scenario 8 | **BLOCKED**: nothing to fail. | Exercisable with bounded spend. |
| Honesty limit | Does not show live reasoning ([AGENT_IMPLEMENTATION.md](AGENT_IMPLEMENTATION.md)). | Subject to gap 3 (record schema). |

Recommended: run scenarios 1-7 in fixture mode for a deterministic 45 minutes. Run scenario 8 as a separate, tiny live session only if the team accepts the gap-3 consequences; otherwise record it `blocked` with the reason. Do not mark scenario 8 `pass` from a synthetic `agent:live-check`.

Fixture answer text (Person 2 types real, confirmed details; this is the required label format, `FixtureAgentRuntime`, one label per line):

```text
Office URL: https://<the real LAN URL>
Join instructions: <how you actually joined>
Near audio: <what to do>
Far audio: <what to do>
Private-room audio: <what to do>
Known issues: <what you actually saw>
```

A missing or conflicting label leaves the draft **Partial draft** and **Approve and publish** disabled. That is correct behavior, not a bug.

## Assignment ledger and ordering

Only one assignment per office may be active (`AgentRunService.create` returns 409 "The office agent already has an active assignment."). Cancel, reject and approve each end an assignment, so the scenarios share assignments like this:

| Assignment | Scenarios covered | Approx. time |
| --- | --- | --- |
| A1 | happy path, 1 offline/busy delivery, 2 restart during wait, 4 requested edits, 7 changed approval, then approve | 20 min |
| A2 | 3 rejection | 5 min |
| A3 | 5 cancellation, 6 late reply | 6 min |
| A4 (live only) | 8 provider/budget failure | 8 min |
| A5 (optional, overnight) | 7 expired approval | 24 h wait |

Order A1, A2, A3, A4. The restart happens once, inside A1, so the server is reset only once. A5 must be started last because it occupies the single active slot for 24 hours.

Reserve about 5 minutes at the end for the record.

---

## Happy path (spans A1)

The record fields `goal`, `question`, `answer` and `brief`.

**Preconditions:** pre-flight complete; both joined; one shared task exists; no active assignment.

**Steps**
- Person 1: **Shared agent** > **Start an assignment**. **Goal**: e.g. "Prepare a demo launch brief from our shared demo tasks. Ask Person 2 for the confirmed office URL, join instructions and audio test procedure. Give me a finished draft to review." Tick the task under **Allowed shared tasks**, tick Person 2 under **People the agent may ask (up to two)**, leave **Maximum model calls** at 6, set **Run mode** to **Fixture demo** (or **Live model**). Press **Start assignment**.
- Person 2: when the toast or badge appears, open **Shared agent**. Read the card; note it names the requester and says the intended audience. Type the answer, choose **Requester and office publication** in **May this answer be used for**, press **Reply**. (If left at **Requester only**, publication is refused later: publication rechecks every answer's grant, `AgentRunService.review`/`evidence(...,true)`.)
- Person 1: **Refresh agent activity**, **Open authorized activity**. Inspect the **Question and answer history**, the attributed answer line (`Answer from <name> about "<question>"`) and the `Shared task:` lines.
- Person 1: **Approve and publish** (after scenarios 4 and 7, see A1 sequence below).

**PASS:** Person 2 (not Person 1) sees the question on a different device; the answer is attributed to Person 2; the draft lists the shared task and the answer as evidence with revision numbers; after approval the text appears once under **Published results**; the card reads `completed`.

**FAIL:** the question appears for Person 1 or any third account; the brief states facts not in the answer; **Published results** shows it more than once or without approval; the draft is publishable while labeled partial.

**Record:** `goal.requesterId`, `question.fromId/toId`, `answer.responderId` (participant IDs from `participants[]`), `crossUserQuestion`, `realAssignment`, `realAnswer`, `brief.artifactRevision` (revision approved), `evidenceLinked`, `reviewDecision: "approved"`. Evidence: timestamped screenshots from both devices.

**Verified in code:** `AgentRunService.create`, `apply` (questions limited to `contactUserIds`), `respond`, `review`; UI in `renderAgents`.

## 1. offlineBusyDelivery

**Template key:** `rehearsal.scenarios.offlineBusyDelivery`

**What suppresses an interrupt.** The server sends the private `agent.request` notice only if the person is connected, `status === 'available'`, `audioMode === 'floor'`, and their profile `allowInterrupt` is true (`updateAgent` in `server/src/rooms/OfficeRoom.ts`, around lines 336-351). The question itself is stored first and appears in the inbox regardless (`AgentRunService.inbox`, filters on status/expiry/run state only). So Person 2 can be made unreachable by any of:

| Condition | How Person 2 triggers it |
| --- | --- |
| Do Not Disturb | Dock availability menu > **Do Not Disturb** |
| Away | Dock availability menu > **Away** |
| In a meeting | Left nav **Office** > **Walk to meeting room**; header shows **In a Meeting** |
| Opted out | **Office** panel > untick **Show immediate inbox notices while Available** |
| Offline | Close the tab or use the dock leave button; **People** on Person 1's screen shows **Offline** |

**Preconditions:** A1 not yet started; Person 2 joined.

**Steps (run two variants, record both in `notes`)**
1. Person 2 sets **Do Not Disturb** (variant a) and, in a later step, goes offline (variant b).
2. Person 1 starts A1 (see happy path).
3. Person 2, variant a: stay on the **Office** panel. Do nothing for about 15 seconds. Host confirms no toast appeared.
4. Person 2: open **Shared agent** and press **Refresh agent activity** (gap 5). The card must be present with the badge count. Do **not** answer yet; A1 continues into scenario 2.
5. Variant b (optional, 2 minutes): Person 2 closes the tab, Person 1 refreshes and confirms **Offline** under **People**, Person 2 rejoins with the same display name and invite. On connect the inbox is refetched (`type==='connected'` handler) and the same card (same text, one copy) is visible.
6. Person 2 returns to **Available** on the floor. Per code the pending notice may then fire once (`claimNotification` marks the outbox done only on delivery). Record whether the toast arrived; neither outcome fails the scenario, but a second identical card does.

**PASS:** while suppressed, no interrupting toast; the inbox card is present with the correct question, requester and audience text; after rejoin exactly one card exists; the assignment shows `waiting_for_person`; the agent does not ask anyone else.

**FAIL:** a toast or sound reaches a suppressed person; the card is missing after refresh/rejoin; the card is duplicated; the agent re-asks or reroutes to another person.

**Record:** `offlineBusyDelivery.result`, `evidence` (screenshots of Person 2's status, absence of toast with timestamp, inbox card, **People** showing **Offline**), `notes` (which conditions you tried).

**Verified in code:** `OfficeRoom.updateAgent`; `AgentRunService.inbox`, `claimNotification`, `nextRecipient`; `frontend/main.ts` lines 25-28, 116, 143. Doc statement: "Questions survive disconnect and appear even if immediate interruptions are disabled" ([AGENT_IMPLEMENTATION.md](AGENT_IMPLEMENTATION.md)).

## 2. restartDuringWait

**Template key:** `rehearsal.scenarios.restartDuringWait`

**Preconditions:** A1 is in `waiting_for_person`, the question is unanswered, and the assignment is not `working`. Do not restart during `working`: in fixture mode a replayed turn is claimed safe, but in live mode an expired lease becomes `partial` ("execution outcome is uncertain", `AgentRunService.claim`) and is never retried.

**Steps**
1. Person 1 and Person 2 each screenshot their view and note `Usage: x/y` and the list of `Activity:` lines under **Open authorized activity** (expect one `question`).
2. Host: in the terminal running `npm run office:lan`, press Ctrl+C once. Wait for the prompt. Per [OFFICE_LAN.md](OFFICE_LAN.md) this stops the office and TLS proxies, keeps the database, and leaves the LiveKit container running. In live mode also stop `npm run agent:dev` (Ctrl+C) so no worker survives against a stopped server.
3. Wait 10 seconds. Both people should see a disconnect state (the client clears agent data on `disconnected`).
4. Host: run the exact same launcher command again. Do not start a second office against the same database. In live mode restart `npm run agent:dev`.
5. Both people reload the page if they are not reconnected automatically, rejoin with the same display name and invite, and open **Shared agent** (the client refetches on connect). Record whether manual reload was needed.
6. Person 2: one card, same question, still unanswered. Person 1: **Refresh agent activity**, **Open authorized activity**; compare with step 1.
7. Person 2 answers (continues the happy path).

**PASS:** state is still `waiting_for_person`; the question text and requester are unchanged; Person 2 has exactly one card; `Usage` is unchanged; the `Activity:` lines show exactly one `question` (no second `question` event); no second assignment exists; after the reply the draft is produced once. The persisted state also satisfies the M5 row "persistent storage confirmed across service restart".

**FAIL:** assignment lost, reset to queued with a second question, duplicate cards, `Usage` increased without a new turn, an extra assignment, a duplicated draft revision, or the answer is lost.

**Record:** `restartDuringWait.result`, `evidence` (before/after screenshots, terminal timestamps of stop/start), `notes` (manual reload needed or not; whether the notice toast fired again).

**Verified in code:** state is in SQLite (migration `server/migrations/005_agents.sql`); `apply` rejects a second question to the same contact ("This contact has already been asked"); `claim` only re-queues a waiting run when no request is open; the fixture runner is an in-server 500 ms timer (`app.config.ts` `runFixture`), so there is no separate fixture worker to forget. No-duplicate evidence is the observable signals above; there is no UI field listing outbox rows.

## 3. rejection

**Template key:** `rehearsal.scenarios.rejection`

**Preconditions:** A1 finished (approved) or otherwise ended; no active assignment.

**Steps**
1. Person 1 starts A2 (same goal, fixture). Person 2 answers with the six-label text and **Requester and office publication**.
2. Person 1: **Refresh agent activity**, **Open authorized activity**, read the draft.
3. Person 1: press **Reject publication**.
4. Person 1 and Person 2: check **Published results** and, as Person 1, the draft area.

**PASS:** card shows state `partial` with `Status detail: Publication declined. Private draft retained.`; the textarea is labeled **Rejected draft** and read-only; **Published results** has no entry for A2 on either device; Approve is no longer offered. A new assignment can then be started.

**FAIL:** any publication of the rejected revision, the draft deleted, or **Approve and publish** still works for the rejected revision.

**Record:** `rejection.result`, `evidence`. If rejection is the *only* review decision you want in the `brief` fields, set `reviewDecision: "rejected"`; otherwise leave A1's `approved`.

**Verified in code:** `AgentRunService.review`, branch `decision==='reject'` sets artifact `rejected` and state `partial`; the run is then terminal.

## 4. requestedEdits

**Template key:** `rehearsal.scenarios.requestedEdits`. Run inside A1 after the first draft is ready.

**Preconditions:** A1 `ready_for_review` with a non-partial draft at revision N.

**Steps**
1. Person 1: in the **Request changes** field enter a supported fixture command, e.g. `Title: Ready for the office`, or `Section: Known issues = <text>` (placeholder and help text are in the UI). Press **Request edits**. For live mode, free text such as "Shorten the known-issues section" is allowed.
2. Wait for the turn (`queued` then `ready_for_review`). Press **Refresh agent activity**.
3. Person 1: confirm the draft is a new revision (the evidence lines show revision numbers; `brief.artifactRevision` becomes N+1 or later), the requested change is applied under `## Requester requested edits` as `Applied: ...`, and **Approve and publish** is offered for the new revision only.

Alternative path: edit the **Draft for review** textarea and press **Save draft changes**; this also creates a fresh revision (`editArtifact`).

**PASS:** a new revision exists, the old one is not approvable (see scenario 7), the requested edit is visibly applied, and publication has not happened. An unsupported fixture instruction must be shown as `Not applied by fixture` and the draft stays partial; that is expected and not a fail.

**FAIL:** the same revision is silently changed, the edit is lost, the old revision can still be approved, or the draft publishes without a fresh review.

**Record:** `requestedEdits.result`, `evidence` (before/after screenshots with the revision numbers), `notes` (command used).

**Verified in code:** `review` branch `changes` queues a new turn; `FixtureAgentRuntime` applies `Title:`/`Section:`; `save` increments the artifact revision; `editArtifact`.

## 5. cancellation

**Template key:** `rehearsal.scenarios.cancellation`

**Preconditions:** no active assignment.

**Steps**
1. Person 1 starts A3 (fixture). Person 2 sees the card. **Person 2 does not answer yet** (needed for scenario 6).
2. Person 1: press **Stop assignment**.
3. Person 1: **Refresh agent activity**. Wait 10 seconds. Confirm nothing further happens.
4. Person 2: leave the page open with the card visible and an answer typed (do not press anything); continue to scenario 6.

**PASS:** card shows `canceled`; no new draft revision appears; no `Published results` entry; `Usage` does not increase after the stop; the agent returns to idle.

**FAIL:** work continues after stopping (new events, new draft, new question), or anything is published.

**Record:** `cancellation.result`, `evidence` (screenshots at stop time and 10+ seconds later), `notes`.

**Verified in code:** `AgentRunService.cancel` sets `canceled` and marks open requests `canceled`; `leased`/`apply` reject any result from a canceled run.

## 6. lateReply

**Template key:** `rehearsal.scenarios.lateReply`. Continues directly from scenario 5.

**Preconditions:** A3 canceled; Person 2's browser still shows the unanswered card with text typed (it has not been refreshed, so it is stale: see the no-polling note).

**Steps**
1. Person 2: press **Reply** on the stale card (and, optionally, **Later** and **Decline**).
2. Observe the toast or error. Person 2 then presses **Refresh agent activity**.
3. Person 1: **Refresh agent activity**, **Open authorized activity**.

**PASS:** the reply is rejected (server answers 409 "Assignment has ended."); after refresh the card is gone from Person 2's inbox; Person 1's assignment remains `canceled` with no new draft, no new events, and no `Usage` change; nothing published.

**FAIL:** the reply is accepted, the assignment resumes, a new turn or draft appears, or the answer leaks into any other assignment.

**Record:** `lateReply.result`, `evidence` (Person 2's error toast screenshot, then Person 1's unchanged assignment), `notes`.

**Verified in code:** `AgentRunService.respond` throws `AgentError(409,'Assignment has ended.')` when the run is canceled or terminal; `inbox` excludes canceled runs. The toast text depends on how `perform` surfaces the error; record what you saw.

## 7. changedOrExpiredApproval

**Template key:** `rehearsal.scenarios.changedOrExpiredApproval`

### 7a. Changed approval (testable now; run inside A1)

**Preconditions:** A1 `ready_for_review` at revision N, Person 2 answered with **Requester and office publication**.

**Steps**
1. Person 1: press **Refresh agent activity**, open the activity. Leave the draft showing; do **not** press anything else or refresh again.
2. Person 2: in the answered card (**Your answer can be corrected**) change the text, keep the audience, press **Save corrected answer**. This supersedes the draft and queues a rebuild.
3. Host: wait about 5 seconds.
4. Person 1 (still on the stale view for revision N): press **Approve and publish**.
5. Person 1: **Refresh agent activity**. Expect `Answer changed; rebuilding a fresh draft.` and then a new draft revision. Review it and press **Approve and publish** (this is the real approval for the happy path).

If Person 1's view re-renders so the old Approve button is gone before step 4, record that, then use a second browser tab for Person 1's session left on the old revision, or run the same test after scenario 4 (Request edits creates revision N+1; the earlier tab still shows revision N).

**PASS:** step 4 is refused (server 409 "Review the current draft revision."); nothing is published; the new revision is not published until approved; **Published results** gets exactly one entry for the final revision.

**FAIL:** the old revision is published, or two entries appear, or an approval of revision N applies to revision N+1.

**Verified in code:** `AgentRunService.review` requires `state==='ready_for_review'`, artifact status `draft` and `a.revision===input.revision`; `reviseAnswer` supersedes drafts and bumps state to `queued`. Immutable review rows are keyed by revision.

### 7b. Expired approval

**GAP: cannot be shortened.** A draft approval expires 24 hours after the artifact's `createdAt` (`review`: `Date.parse(a.createdAt)+86400000<=Date.now()` returns 409 "Draft approval expired. Save a fresh revision before reviewing."). A question expires 24 hours after creation (`apply` sets `expires_at` to `Date.now()+86400000`; `respond` returns "Request changed or expired."). There is no environment variable, config field or UI setting for either, so no short-TTL restart is possible. Do not edit the SQLite file or system clock; that is not an observation of the product.

Options:
- **Honest wait:** after A4, start A5, let it reach `ready_for_review`, leave it unreviewed for more than 24 hours (the office will have no free assignment slot meanwhile), then press **Approve and publish**. Expect the 409 above and no publication; **Save draft changes** then creates a fresh revision that can be reviewed. Record the observation date/time in `notes`.
- **BLOCKED:** if the rehearsal ends the same day, record only 7a in `evidence`, and state in `notes` that expiry was not exercised and why. The acceptance table's wording is "Changed *or* expired", so a verified 7a supports `pass` for the key, but say plainly in `notes` that expiry is untested. If the team requires both, set `result: "blocked"` with the reason; the validator then reports `OPEN`, never `PASS` (`validateAcceptance`).

**Record:** `changedOrExpiredApproval.result`, `evidence`, `notes` (changed: yes; expired: waited/not run).

## 8. providerOrBudgetFailure

**Template key:** `rehearsal.scenarios.providerOrBudgetFailure`

### Fixture mode: GAP, record BLOCKED

Fixture turns return `modelCalls: 0` and never contact a provider; the **Live model** option is disabled unless `AGENT_RUNTIME` is `gemini` or `hermes` (`runtimeStatus` in `server/src/app.config.ts`, `renderAgents`). The **Maximum model calls** control has no visible effect in fixture mode. Record `result: "blocked"` with `notes: "Fixture mode makes no provider calls; failure cannot be induced"`. Do not simulate a failure by disconnecting the network and calling it a pass.

### Live mode: two bounded ways, both visible

Prerequisites: live runtime configured, worker running, accepted spend of at most the numbers below, and a baseline from **AI assistant** (`Gemini local usage: N/limit`).

**Method A: per-assignment cap of 1 (one request, no quota knob).**
1. Person 1 starts A4 with **Run mode** **Live model** and **Maximum model calls** = 1.
2. The first turn (claimed, one request reserved) asks Person 2 the question.
3. Person 2 answers.
4. Person 1: **Refresh agent activity**. The continuation cannot be claimed: expect `partial` with `Status detail: Model request budget exhausted.` and `Usage: 1/1`.

**Method B: shared daily limit.**
1. Host stops the worker, then restarts it with a lower `AI_LOCAL_DAILY_REQUEST_LIMIT` set to `<attempts shown today> + 1` (minimum 1; the setting lives in `worker/src/config.ts`, default 20). Put it in the worker's process environment on the command line (for example `AI_LOCAL_DAILY_REQUEST_LIMIT=<n> npm run agent:dev`); confirm via **AI assistant** that the displayed `limit` matches, since the limit is read by each process that owns a tracker. Do not edit usage rows or change the credential or database path (that would split the counter).
2. Person 1 starts A4 live with **Maximum model calls** 2 or more. The first turn consumes the allowance and asks the question.
3. Person 2 answers. The second claim reserves a request but the provider reservation fails with `LOCAL_BUDGET_EXCEEDED` (`UsageTracker.reserve`).
4. Expect state `failed` with a `Status detail` message.
5. Host restores the normal limit and restarts the worker afterward.

**PASS:** the failure is shown on Person 1's card (state and `Status detail`), no hidden retry or fallback runs, no further model calls occur after the failure, and nothing is published.

**Counting (read and record all three):**
- The card `Usage: x/y` counts office claim reservations. Each claim adds one before dispatch (`claim`: `model_calls=model_calls+1`), including attempts that later fail.
- The shared tracker counts actual provider attempts (`Gemini local usage: N/limit` in **AI assistant**; the `usage_requests` table in `AI_USAGE_DATABASE`). In Method B the blocked second attempt is reserved on the card but is **not** inserted into `usage_requests` (the limit check throws before the insert), so card and tracker can differ by one. Record both numbers and the reason.
- For `rehearsal.runtime.modelCalls` record the number of requests actually sent to the provider including failed attempts, per [AGENT_ACCEPTANCE.md](AGENT_ACCEPTANCE.md). If you ran a mixed session, see gap 3.

**FAIL:** failure is silent or shown as success; the draft is marked complete without the missing turn; calls continue after the budget is exhausted; the displayed counts disagree with the tracker without explanation.

**Record:** `providerOrBudgetFailure.result`, `evidence` (card screenshot, usage meter before/after, host terminal showing the limit), `notes` (method, both counts).

**Verified in code:** `AgentRunService.claim` ("Model request budget exhausted."), `fail`, `agent-worker/src/worker.ts` catch block (calls `port.fail`), `worker/src/usage.ts` `reserve`, `agent-worker/src/runtime.ts` `GeminiAgentRuntime.turn`.

---

## Closing: filling and validating the record

1. Host fills the JSON from observations. Each scenario needs `result` (`pass`, `fail`, `blocked`; `not_run` stays `OPEN`), non-empty `evidence`, and `notes` when `blocked`. If `agent:acceptance-init` is available, use it for machine-observable fields and model-call deltas, and review its output rather than trusting it; if `agent:deployment-check --record <file>` is available, use it for the preflight results. Everything else, including participants, `attestedRealPerson`, and each scenario result, is a human declaration.
2. Both participants confirm the entries about themselves (names or roles, devices, answers). Keep the JSON and evidence access-controlled, and exclude invite codes, secrets and private answer text beyond what they agreed to.
3. Do not erase failed attempts. If you retry a scenario, keep both attempts in `notes`; a recorded `fail` keeps the verdict `FAIL`.
4. Validate:

   ```sh
   npm run agent:acceptance-check -- /absolute/path/to/rehearsal-record.json
   ```

   Verdicts: `PASS` only when all required fields exist and every deployment check and scenario passed; `OPEN` when anything is missing, `not_run` or `blocked`; `FAIL` for invalid data or any recorded failure. The validator checks completeness and internal consistency only. It cannot confirm that people, devices or observations were real, and a synthetic check never stands in for a human one.
5. Update the M5/M6 checkboxes in [AGENT_ROADMAP.md](../AGENT_ROADMAP.md) and the status lines in [AGENT_ACCEPTANCE.md](AGENT_ACCEPTANCE.md) only after the validator reports `PASS` for real-participant evidence. Until then M6 stays open and this rehearsal is a partial result.

## Suggested 45-minute schedule

| Minutes | Activity |
| --- | --- |
| 0-3 | Consent, join, confirm **People**, create shared task |
| 3-9 | A1: Person 2 sets Do Not Disturb; Person 1 starts; scenario 1 |
| 9-17 | Scenario 2: Ctrl+C, relaunch, rejoin, compare; Person 2 answers |
| 17-27 | Scenarios 4 and 7a; then approve; record the happy path |
| 27-32 | A2: scenario 3 |
| 32-38 | A3: scenarios 5 and 6 |
| 38-43 | A4 (live only) or record scenario 8 `blocked` |
| 43-45 | Start A5 if testing expiry; fill and validate the record |
