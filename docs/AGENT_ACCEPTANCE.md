# Shared office deployment and human acceptance record

Use this record for M5/M6. The blank [JSON template](agent-acceptance-template.json) is the machine-readable source; this page is its field guide. Complete it from a real rehearsal in the persistent shared office. Do not mark an item passed from fixture data, synthetic accounts, automated browser contexts, a local `office:demo`, or an unverified URL supplied in an answer. Leave unavailable evidence `OPEN` and describe the blocker.

## Current state

- M5 shared deployment: **OPEN — LAN hosting is the planned demo path, but no two-device connection, trusted certificate, or media evidence is recorded yet.**
- M6 two-person/two-device acceptance: **OPEN — no real-person rehearsal is recorded.**
- Existing automated and bounded live-agent checks are described in [AGENT_IMPLEMENTATION.md](AGENT_IMPLEMENTATION.md). They do not close either gate.

## Deployment details (M5)

| Field | Recorded value |
| --- | --- |
| Network scope (`lan` or `public`) | OPEN |
| Actual office URL (copy from the deployed service/operator) | OPEN |
| Join instructions and invite delivery method (do not put invite secrets in this file) | OPEN |
| Browser-facing LiveKit WSS origin | OPEN |
| Deployment/hosting owner | OPEN |
| Persistent storage confirmed across service restart | OPEN |
| `PUBLIC_SERVER_URL` uses HTTPS | OPEN |
| `LIVEKIT_PUBLIC_URL` uses WSS | OPEN |
| Certificate valid on both public endpoints | OPEN |
| Health and readiness probe result, date/time | OPEN |
| WSS/WebRTC/audio result from two separate devices | OPEN |
| Near audio result | OPEN |
| Far audio result | OPEN |
| Private-room isolation result (outside person cannot hear) | OPEN |
| Known network, browser, TURN or firewall limitations | OPEN |

Optional read-only preflight from a machine that can reach the deployed service:

```sh
npx tsx --env-file-if-exists=.env tools/agent-deployment-check.ts \
  --allow-lan \
  --office-url https://192.168.1.20:8443 \
  --livekit-url wss://192.168.1.20:8444
```

The tool prints only the supplied origins and probe outcomes. Without `--allow-lan`, it requires public hostnames/IPs. With `--allow-lan`, it accepts private LAN addresses or LAN hostnames but still requires HTTPS/WSS and rejects loopback. It checks `/healthz`, `/readyz`, HTTPS configuration and a TLS handshake/certificate for the configured WSS host. It does not perform a WebSocket upgrade: LiveKit signaling requires a valid room token and signaling path, and an unauthenticated probe cannot establish room access. It creates no account, room, message or provider request. You may instead use `AGENT_OFFICE_URL` (preferred for the deployed office) or `PUBLIC_SERVER_URL`, and `LIVEKIT_PUBLIC_URL`. Do not paste `.env` contents into the record. The office's Colyseus WebSocket route is established from an authorized seat reservation and has no fixed public join URL, so only an actual authenticated browser join from each device verifies it. Neither TLS preflight nor HTTP health checks verify ICE paths, WebRTC media or private-room isolation. For the laptop-hosted LAN setup, follow [the LAN runbook](OFFICE_LAN.md). A trusted HTTPS certificate is still needed for microphone access in collaborators' browsers. The two-device checks below are still required.

The package command is `npm run agent:deployment-check -- --allow-lan --office-url <https-origin> --livekit-url <wss-origin>`.

Copy the template before entering evidence, set `deployment.networkScope` to `lan` for the LAN rehearsal (or `public` for a public deployment), then run the validator:

```sh
cp docs/agent-acceptance-template.json data/agent-acceptance.json
npx tsx --env-file-if-exists=.env tools/agent-acceptance-check.ts data/agent-acceptance.json
```

The validator only reads the supplied record. It reports `OPEN` while evidence is missing or a scenario is blocked, `FAIL` for invalid evidence or a recorded failure, and `PASS` only when the required M5/M6 fields are present and every required result passes. It requires two distinct participant IDs and devices, an assignment requester and a different question respondent, that person's answer, the reviewed artifact revision, runtime revision and model-call count. Participant identity attestations and linked evidence are declarations by the recorder; the tool cannot independently prove that people, devices, or observations are genuine. Keep the JSON and evidence access-controlled.

## Recommended flow: init, preflight, rehearse, usage, validate

```sh
# 1. Create the record; fills only machine-observable fields and snapshots the usage baseline.
npx tsx --env-file-if-exists=.env tools/agent-acceptance-init.ts init data/agent-acceptance.json \
  --office-url https://192.168.1.20:8443 --livekit-url wss://192.168.1.20:8444 --scope lan
# 2. Preflight; --record writes the four automated deployment checks into the record.
npx tsx --env-file-if-exists=.env tools/agent-deployment-check.ts --allow-lan \
  --office-url https://192.168.1.20:8443 --livekit-url wss://192.168.1.20:8444 --record data/agent-acceptance.json
# 3. Run the human rehearsal and fill every attestation by hand.
# 4. After the rehearsal, compute the provider-call count from the shared usage ledger.
npx tsx --env-file-if-exists=.env tools/agent-acceptance-init.ts usage data/agent-acceptance.json
# 5. Validate.
npx tsx --env-file-if-exists=.env tools/agent-acceptance-check.ts data/agent-acceptance.json
```

`init` refuses to overwrite an existing record or baseline, and validates the URLs with the validator's own rules. A fresh record validates as `OPEN`, never `PASS`.

Machine-filled (the only fields the tools write):

| Field | Source |
| --- | --- |
| `deployment.networkScope`, `officeUrl`, `livekitUrl` | `init` arguments, validated |
| `rehearsal.gitRevision` | `git rev-parse HEAD`, suffixed `-dirty` if the working tree (including untracked files) has changes |
| `rehearsal.serverVersion` | root `package.json` version |
| `rehearsal.runtime.name`, `revision` | only when `AGENT_RUNTIME` is explicitly set: `hermes` gives the pinned commit `74885f997bece88c1393bd174b25b32338336cb6`; `gemini`/`fixture` give a name and a null revision. Otherwise null (fill by hand). |
| `deployment.checks.https`, `health`, `readiness`, `wssTls` | `agent-deployment-check --record` (`pass`/`fail`, probe time, short outcome). Probes that did not run are left untouched. The record's scope and origins must match the probe. |
| `rehearsal.runtime.modelCalls` | `usage` subcommand (below) |

Everything else stays a human attestation and is never written by a tool: `joinInstructions`, `separateDevices`, `nearAudio`, `farAudio`, `privateRoomIsolation`, `performedAt`, `runtime.mode`/`provider`/`model`, all participants, goal/question/answer/brief, and every scenario. A recorded probe `fail` makes the validator report `FAIL`; do not edit it away without recording the retry.

Model-call accounting: `init` snapshots the row count of the shared usage ledger (`usage_requests` in `AI_USAGE_DATABASE`, or `--usage-db`) into `<record>.usage-baseline.json`. `usage` reopens the database read-only and writes the delta, which includes failed and unfinished attempts. If the database is unreadable, shrank (replaced or reset), or disagrees with the timestamp cross-check, `modelCalls` is set to null and the command exits non-zero. If `init` could not read the ledger (for example it does not exist yet), no baseline is written and `usage` cannot run. Caveats: the ledger counts every tracked call from any credential or app on that database in the window (agent worker, transcription worker, AI demo), so keep other AI use off it during the rehearsal; calls outside the tracker are not counted. The office's own "today" counter resets at the UTC day boundary, but this delta reads the lifetime ledger and is unaffected by that rollover; a deleted or replaced database is what breaks it. The server and worker must share the same absolute database path.

## Rehearsal identity and build (M6)

| Field | Recorded value |
| --- | --- |
| Date/time and timezone | OPEN |
| Office URL used | OPEN |
| Git commit/deployed build identifier | OPEN |
| Server version | OPEN |
| Agent runtime and version | OPEN |
| Model/provider, if live | OPEN |
| Fixture or live mode | OPEN |
| Person 1 (name/role, with consent to record) | OPEN |
| Device 1 and browser/version | OPEN |
| Person 2 (name/role, with consent to record) | OPEN |
| Device 2 and browser/version | OPEN |
| Actual provider model-call count; include failed attempts | OPEN |
| Actual assignment/request IDs or links to access-controlled evidence | OPEN |
| Evidence storage location and audience | OPEN |

Avoid recording credentials, invite codes, private answer text or personal details beyond what participants agreed to share. Keep evidence links access-controlled.

## Scenario results

The [rehearsal runbook](AGENT_REHEARSAL.md) gives per-scenario steps by role, pass/fail criteria and known gaps.

Use `PASS`, `FAIL`, `NOT RUN`, or `BLOCKED`, add the date/time, and link to evidence. A failure must remain visible; do not relabel it as a pass after retry without recording both attempts.

| Scenario | Status | Result / evidence |
| --- | --- | --- |
| Both people join the same persistent office from separate devices | OPEN | |
| Person 1 assigns a goal with stated scope, contacts, audience and budget | OPEN | |
| Agent asks Person 2 a real, relevant question | OPEN | |
| Question is visible in the correct private inbox; offline/busy delivery behavior checked | OPEN | |
| Person 2 answers and selects the allowed answer audience | OPEN | |
| Evidence-linked brief attributes the answer and preserves source/audience boundaries | OPEN | |
| Person 1 reviews the exact artifact revision and approves or rejects publication | OPEN | |
| Offline/busy delivery | OPEN | |
| Server restart while waiting; request survives and no duplicate work occurs | OPEN | |
| Rejection leaves the artifact private | OPEN | |
| Requested edits create a new revision and require fresh review | OPEN | |
| Cancellation prevents subsequent work/publication | OPEN | |
| Late reply after cancellation/closure does not resume work | OPEN | |
| Changed or expired approval cannot publish | OPEN | |
| Provider failure or exhausted budget is visible and accurately counted | OPEN | |
| Near/far audio works between devices | OPEN | |
| Private-room audio cannot be heard by an outside participant | OPEN | |

## Outcome

- Overall result: **OPEN**
- What worked: OPEN
- Failures and retries: OPEN
- Limitations and follow-up owner: OPEN
- Human acceptance by both participants (names/roles and date, or link to approved record): OPEN

Only update the M5/M6 roadmap checkboxes after the corresponding deployment and real-human evidence is filled in. Synthetic browser sessions, fixture answers, and a bounded Gemini run are useful supporting evidence, but they cannot attest for participants or separate devices.
