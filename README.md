# Lucid Virtual Office

A virtual office where people can walk up to conversations. M2 adds authenticated LiveKit microphone credentials, public-floor proximity audio, verified lifecycle webhooks, and a browser media harness to the shared office and authoritative movement from M1. M3 adds automatic private meeting-room audio. M4 adds opt-in AI meeting notes through a separate worker. M5 adds self-owned reminders with durable delivery and offline catch-up; real-device and second-host deployment checks remain manual acceptance work.

## Test the integrated office frontend

From the repository root, run **npm ci** and **npm run setup:local** (first time only), then **npm run office:demo** and open **http://localhost:2568/**. Choose the fictional Nathan, Cameron and Maya accounts in separate windows to test the complete UI/backend flow. The demo seeds private notes and shared work in an isolated in-memory office; restarting resets fixtures without changing the normal database or resetting Gemini usage. Audio capture is disabled in this mode. AI submits only when you click Ask assistant and uses the configured Gemini key: add your `GEMINI_API_KEY` to `.env` (setup:local already sets `AI_PROVIDER=gemini` and generates `AI_WORKER_SECRET`; keep that generated secret, as a hand-typed one must be at least 32 characters). If Google returns a quota error, Ask stays paused until you run `npm run ai:usage -- --clear-pause`, which clears only this project's local pause and does not reset Google's quota.

Use **npm run office:dev** for the persistent office at **http://localhost:2567/** with your configured invite. Real audio additionally requires LiveKit; real AI capture requires AI_ENABLED=true and a worker (npm run office:dev -- --worker). OFFICE_LAYOUT=prototype matches the approved frontend artwork. No external Teams/Slack delivery or video calls are connected.

See [Integrated demo checklist](docs/INTEGRATED_DEMO_CHECKLIST.md) for all eight assistant actions, task/message approval, privacy, optional interruptions, and real-microphone checks. **npm run office:verify** runs typecheck, the production build, all tests and the integrated browser checks with external networking blocked. **npm run office:live-check** is a separate, bounded live Gemini check using fictional data and the persistent quota ledger.

## Start the AI transcript demo (no Docker required)

From this repository, run `npm run ai:demo` and open http://127.0.0.1:8788/.
Choose an offline reference replay or live Gemini extraction. The demo includes editable fictional transcripts and evidence-backed task drafts, with participant/time context and accuracy/latency/token metrics. `npm run ai:eval` runs offline fixtures; `npm run ai:eval -- --live --all` evaluates Gemini within free-tier safeguards.
See [AI transcript demo and evaluation](docs/AI_TRANSCRIPT_DEMO.md) for configuration, test coverage, and scoring limitations. External message/task delivery and office microphone capture are separate from this transcript demo.
The transcript demo also includes editable message drafts and task proposals with local approval, saved history, evidence, and approved-only JSON export. See [Message draft preview](docs/MESSAGE_DRAFT_PREVIEW.md). This stage adds no Gemini requests and does not send anything externally.

## Run with Docker Compose

Install Docker with the Compose plugin, then prepare local settings:

```sh
cp .env.example .env
```

Change the session secret, guest invite code, and LiveKit API secret before sharing access. Then start the application and self-hosted LiveKit:

```sh
docker compose up --build
```

AI notes are disabled by default. To enable them, set `AI_ENABLED=true`, replace `AI_WORKER_SECRET` with a random secret of at least 32 characters (distinct from both `SESSION_SECRET` and `LIVEKIT_API_SECRET`), and configure `AI_PROVIDER=gemini` and `GEMINI_API_KEY` (or explicitly select OpenAI with compatible model/base URL settings) in `.env`. The same worker secret is shared with the optional worker; Compose supplies its internal `AI_SERVER_URL`. Start the AI worker profile with:

```sh
docker compose --profile ai up --build
```

Worker provider settings include `AI_PROVIDER_BASE_URL`, `AI_TRANSCRIPTION_MODEL`, `AI_SUMMARY_MODEL`, `AI_CHUNK_SECONDS`, and `AI_PROVIDER_TIMEOUT_MS`. See [M4 AI notes verification](docs/M4_AI_CHECK.md) for the consent flow and manual checks. No live-provider or real-device verification is claimed yet.

Compose initializes the named SQLite volume, applies migrations in a one-shot job, then starts the server. Open `http://localhost:2567/healthz` for liveness and `http://localhost:2567/readyz` for storage readiness and dependency status. Its `dependencies.ai` value is `disabled`, `up`, or `down`; `up` means an authenticated worker request was seen in the last 10 seconds, not that a provider call has succeeded. Application readiness is separate from media availability. The server binds to `0.0.0.0:2567`; LiveKit signaling is exposed on `ws://localhost:7880`.

Stop with Ctrl-C and restart with `docker compose up`. The `office-data` named volume persists across image rebuilds and container replacement. To deliberately erase the demo database, stop Compose and remove the volume:

```sh
docker compose down
docker volume rm lucidhackathonfall2026_office-data
```

## Run locally with Node.js

Use Node.js 24 LTS. Copy `.env.example` to `.env`, then set the local database and LiveKit address in `.env`:

```dotenv
DATABASE_URL=./data/office.sqlite
LIVEKIT_INTERNAL_URL=http://localhost:7880
```

The npm scripts load `.env` automatically. Install, build, and start:

```sh
npm ci
npm run build
npm run migrate
npm start
```

`npm run dev` starts the TypeScript server for development; run `npm run build` first to generate the browser harness bundle. `npm test` runs the tests. `npm run smoke` runs the SDK smoke client and requires a running server. The local Node path does not start LiveKit; use Compose or run LiveKit separately.

## Guest session and office join

Redeem the configured invite code to create a guest. Save the returned bearer token securely; it expires after seven days.

```sh
curl -sS http://localhost:2567/api/sessions/guest \
  -H 'Content-Type: application/json' \
  -d '{"inviteCode":"your-invite-code","displayName":"Ada"}'
```

The response contains `token`, `userId`, `officeId`, `displayName`, and `expiresAt`. Send the token to `GET /api/sessions/current` to recover the current identity after reload:

```sh
curl -sS http://localhost:2567/api/sessions/current \
  -H 'Authorization: Bearer YOUR_SESSION_TOKEN'
```

Request an office seat using protocol version 1:

```sh
curl -sS http://localhost:2567/api/offices/demo-office/join \
  -H 'Authorization: Bearer YOUR_SESSION_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"protocolVersion":1}'
```

Pass the returned seat reservation to the Colyseus SDK. The bearer token is sent to the server for the authenticated HTTP join; the SDK consumes the resulting reservation over the Colyseus WebSocket connection:

```ts
import { Client } from "@colyseus/sdk";

const token = "YOUR_SESSION_TOKEN"; // Load from secure client storage.
const response = await fetch("http://localhost:2567/api/offices/demo-office/join", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ protocolVersion: 1 }),
});
if (!response.ok) throw new Error(`Office join failed: ${response.status}`);
const reservation = await response.json();

const client = new Client("ws://localhost:2567");
const room = await client.consumeSeatReservation(reservation);
room.onMessage("session.ready", (identity) => console.log("Joined office", identity));
```

The server blocks public matchmaking for new joins; its private reconnect route remains available to the SDK. M1 validates the session, reserves a seat, emits `session.ready`, and synchronizes players keyed by Colyseus `sessionId`. Movement messages contain only `{ seq, dx, dy }`; the server applies speed, elapsed time, map bounds, and collision. Clients may send `{ status: "available" | "away" | "busy" }`. Invalid messages receive `request.error` with a stable error code. Application HTTP errors use `{ "error": { "code": "...", "message": "..." } }`.

An office join returns HTTP `409` with `DUPLICATE_CONNECTION` when that guest already has a reserved or active seat, or `ROOM_FULL` when all 20 seats are occupied. Keep the SDK's `room.reconnectionToken` to resume a dropped connection within 30 seconds, then continue sequence numbers from `lastProcessedInputSeq`:

```ts
persistSecurely(room.reconnectionToken);
const resumedRoom = await client.reconnect(loadSecurelySavedReconnectToken());
let nextSeq = (resumedRoom.state.players.get(resumedRoom.sessionId)?.lastProcessedInputSeq ?? -1) + 1;
resumedRoom.send("player.input", { seq: nextSeq++, dx: 1, dy: 0 });
```

Room state is in memory, so after a server restart use the saved guest bearer token to request a fresh office seat and begin a new room session.

Fetch the versioned map contract for the authenticated office with `GET /api/offices/:officeId/map`, using the guest bearer token. The M1 office simulation runs at 20 Hz with 20 Hz state patches, expires held input after 250 ms, and accepts up to 60 application messages per second per client. Colyseus reconnection reservations last 30 seconds.

Example movement and status messages:

```ts
room.send("player.input", { seq: 1, dx: 1, dy: 0 });
room.send("player.status", { status: "busy" });
room.onMessage("request.error", ({ code, message }) => console.warn(code, message));
```

## Runtime and shared access

The checked-in URLs are for local development. For browser access from other devices, set `PUBLIC_SERVER_URL`, `ALLOWED_ORIGINS`, and `LIVEKIT_PUBLIC_URL` to externally reachable addresses and use HTTPS/WSS with a trusted certificate. Other devices cannot use `localhost` to reach the host. The sample maps LiveKit signaling TCP `7880`, ICE/TCP `7881`, and single-port ICE/UDP `7882`; a signaling proxy alone does not carry WebRTC media. Configure reachable advertised addresses, firewall/router forwarding, and TURN for the deployment network as needed.

SQLite lives at `/data/office.sqlite` in the Compose volume and at the configured path for local Node runs. Before backup, stop the server and worker, then archive the complete `/data` directory, including any SQLite WAL/SHM files. Images do not contain application data. See the [M5 reminders and demo readiness runbook](docs/M5_REMINDERS_CHECK.md) for consistent backup/restore and registry-image deployment. Run one server replica while office state is in memory and SQLite is the application store. Compose includes the server, migration and volume initialization jobs, and LiveKit; the AI worker is an opt-in `ai` profile.

## Pinned Colyseus versions

| Package | Version |
| --- | --- |
| `@colyseus/core` | `0.18.23` |
| `@colyseus/schema` | `5.0.42` |
| `@colyseus/ws-transport` | `0.18.4` |
| `@colyseus/tools` | `0.18.10` |
| `@colyseus/sdk` | `0.18.6` |
| `@colyseus/testing` | `0.18.6` |

The server foundation follows the TypeScript minimal starter from [`create-colyseus-app` 0.18.1](https://www.npmjs.com/package/create-colyseus-app). Use the official [Colyseus 0.18 documentation](https://docs.colyseus.io/) and [0.18 migration guide](https://docs.colyseus.io/migrating/0.18) when extending it. The [Client SDK guide](https://docs.colyseus.io/getting-started/typescript) documents connecting a client.

## M0 verification

Validated on October 23, 2026: TypeScript checks and build, 31 tests, Compose startup with usable SQLite and LiveKit, SDK seat consumption and schema decoding, rejection of unauthorized joins, durable guest identity after container replacement, non-root execution, and graceful SIGTERM shutdown. Application images built and passed the SDK smoke check on native Linux arm64 and emulated Linux amd64. This verifies the M0 foundation; browser audio and cross-device media are later milestones.

The GitHub Actions workflow runs the type checks, tests, build, Compose startup, and SDK smoke check on pushes and pull requests. Run it locally with `npm run typecheck`, `npm test`, `npm run build`, `docker compose up --build -d --wait`, and `npm run smoke`.

## M1 verification

M1 validation covers strict input/status contracts, map contract and collision behavior, authenticated seat handling, reconnect reservations and authorization rechecks, duplicate guest seats, and full-room rejection. All 73 tests, TypeScript checks, and the build passed. The server Docker image built successfully, and the isolated runtime SDK smoke passed with two distinct guests in the same office instance, shared presence, movement observed by the second client, rejected client coordinate injection, and graceful client leaves. A separate SDK check synchronized 20 clients in the default-capacity office, observed movement, and confirmed that a 21st guest received `ROOM_FULL`.

## M2: walk up and talk

After building/starting the server, open [the media harness](http://localhost:2567/media-harness/) in three independent browser contexts, create a distinct guest in each, and explicitly enable microphones. Microphones start off. Use headphones, focus the map, and move with WASD/arrows. The harness bundles its pinned Colyseus and LiveKit SDKs locally; no CDN is required. It supports mute, deafen, playback resume, microphone republishing, and manual connection retry. Browser permission denial preserves listening and movement. Meeting-zone shading is only a map preview in M2; private meeting audio is added in M3 (below).

`POST /api/media/token` requires the guest bearer token and strict JSON `{ "sessionId": "COLYSEUS_SESSION_ID" }`. The session must be a currently connected office seat owned by that guest. The response is `{ url, token, mediaIdentity, roomName, expiresAt }`, where `expiresAt` is an ISO UTC timestamp. Clients cannot choose identities, rooms, zones, or grants. Credentials last 60 seconds for admission, permit microphone publication and subscription, and prohibit camera/screen/data publication. LiveKit uses an opaque floor room per office instance and an opaque participant identity per connection; identities are refreshed after a Colyseus reconnect. Do not log or persist media tokens.

Room clients send `media.preferences` with `{ muted: boolean, deafened: boolean }`. These preferences start muted and stay private. The server sends each listener a private `audio.policy` message at 5 Hz with `{ revision, speakers: [{ mediaIdentity, distance, gain }] }`. Revisions increase for the lifetime of the office. Distances are tiles: gain is 1 through 2 tiles and fades linearly to 0 at 6. Speakers enter the subscription list at distance ≤6 and remain through distance ≤7, with zero gain beyond 6. Hearing is computed independently for each listener; nearby people do not relay each other's conversations. Disconnected, muted, and non-floor speakers are excluded; deafened listeners receive an empty list.

The browser connects to LiveKit once per office connection with automatic subscription disabled. It reconciles microphone publications from policy, smooths playback gain, and handles republished tracks. Moving across a proximity boundary changes subscriptions and volume without reconnecting LiveKit. On an office/media drop, the harness stops media and requires manual retry; production clients may use the SDK reconnect reservation, then request fresh media credentials. The server invalidates the binding immediately on office drop/leave, removes the old media participant, and cleans up floor rooms on disposal. Cleanup failures are logged without taking down office storage readiness.

`POST /api/livekit/webhook` accepts `application/webhook+json` up to 64 KiB, verifies the exact raw-body signature with the configured LiveKit key, deduplicates verified event IDs, and ignores delayed participant events for older SIDs. Media events never create office membership. Old or unbound identities observed joining/publishing are evicted. Compose enables signed callbacks to `http://server:2567/api/livekit/webhook`; update `deploy/livekit.yaml` if changing the application's port or running Node outside Compose (for Docker Desktop, use a reachable host callback such as `http://host.docker.internal:2567/api/livekit/webhook`). `LIVEKIT_WEBHOOK_API_KEY` in Compose follows `LIVEKIT_API_KEY`.

Public-floor proximity controls the listening experience; it is not a confidentiality boundary. A modified client with subscription permission can receive other floor tracks. Self-hosted LiveKit does not revoke previously issued tokens when removing a participant, so short-lived floor credentials can be replayed until expiry; webhook eviction is best effort. M3 isolates meeting rooms and rotates their media epochs (below), but the public floor keeps this caveat: it remains a listening experience, not a confidentiality boundary.

The [M2 verification guide](docs/M2_MEDIA_CHECK.md) covers three-person listening, independent distances, hysteresis, microphone denial, mute/deafen, republishing, and disconnects. Automated service/room tests verify token grants and signatures, forged claims, disconnect/reconnect binding changes, private policies, exact webhook signatures, delayed events, and cleanup. Physical microphones and separate-device/network connectivity still require the manual guide.

For automated Chromium/WebRTC verification with synthetic microphones against a running stack:

```sh
npx playwright install chromium
npm run smoke:media
```

This opens three isolated browser contexts, exercises movement and media subscriptions, and checks inbound audio packets/energy. CI runs it after the Compose and SDK smoke checks. It does not establish human audibility or separate-device/network connectivity.

Validated on October 23, 2026: all 95 tests, TypeScript checks, the production build, Docker Compose startup/health, the SDK movement smoke, and the three-context synthetic WebRTC media smoke passed. Physical microphones, permission prompts/denial, and separate-device/network audio still require the manual M2 guide.

## M3: meeting rooms

Meeting-zone membership comes only from the authoritative server position: `zoneAt` tests the player's point against the map's `meetingZones`. Rectangles own their left/top edges and exclude right/bottom, and map validation rejects overlapping zones, so a point has at most one owner and doorway crossings are deterministic. Entering a zone moves a connected player from the public floor into that zone's private audio automatically; leaving returns them to the floor. Clients never choose zones, rooms, or grants. Exits always take effect immediately. To stop doorway pacing from forcing endless epoch rotations, re-entering any meeting within 1 second of a walking exit is deferred: the player stays on floor audio (with `zoneId` still following position) and joins on the first tick after the cooldown if still inside. A direct room-to-room move after a normal stay, a first entry, and a reconnect are not delayed. The shipped map has one zone, `meeting-east`.

Each meeting zone has an opaque LiveKit room (`meet_...`) per meeting session, created on first entry and ended when the last occupant leaves. Meeting occupants are excluded from floor policies in both directions, and floor speakers are never subscribed from inside. Inside a meeting, `audio.policy` is `{ revision, mode: "meeting", zoneId, speakers }` where speakers are the other connected, unmuted occupants of the same zone at gain 1 (with their real distance); deafened listeners get an empty list. Floor policies carry `mode: "floor"` and `zoneId: ""`. Mute and deafen are server-held preferences and carry across transitions; the server never unmutes anyone.

A zone change sends the caller three private messages in order: `meeting.exited { zoneId, meetingSessionId, revision }` (if leaving), `meeting.entered { zoneId, meetingSessionId, name, videoAvailable, revision }` (if entering), then `media.transition { revision, mode, zoneId, meetingSessionId?, reason }` with `reason` one of `zone_change`, `epoch_rotation`, or `reconnect`. The client replies with `media.transition.ack { revision }` (strict; malformed payloads get `request.error` `INVALID_INPUT`, stale or future revisions are ignored silently, and acks count toward the 60 messages/second limit). Revisions are per connection and increase monotonically. `POST /api/media/token` now accepts `{ sessionId, transitionRevision? }` (a non-negative safe integer) and `MediaCredentials` adds `transitionRevision`, `mode` (`"floor" | "meeting"`), `zoneId`, and, for meetings, `meetingSessionId`. Credentials still last 60 seconds and permit microphone only. Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN` (not your connected seat, or the seat dropped during signing), `409 STALE_TRANSITION` (revision differs from the current one, or a transition happened during removal or signing), `409 TRANSITION_PENDING` (a transition is pending and the revision was omitted or not yet acked), and `503 UNAVAILABLE` (signing or old-room removal failed; the transition stays pending and the next request retries removal).

Client procedure on `media.transition` revision R: (1) stop the microphone and disconnect the current LiveKit room, never reconnecting to the old one; (2) send `media.transition.ack { revision: R }`; (3) `POST /api/media/token` with `transitionRevision: R` (retry shortly on `TRANSITION_PENDING`; on `STALE_TRANSITION` abandon R and follow the newest transition; on `503` stay disconnected and retry with the same R); (4) connect to `credentials.roomName`, apply `audio.policy`, and republish the microphone only if the user's own preference is unmuted. A same-revision refresh may omit `transitionRevision`. Floor-only M2 clients that never transition still work. The server removes the participant from the old LiveKit room at the same time it sends `media.transition`, so a client may see a `PARTICIPANT_REMOVED` disconnect before the message arrives; treat that as an expected transition rather than a fatal media loss. The bundled `/media-harness/` follows this procedure, including a manual "Retry media connection" button after `503`.

Public state gains `OfficeState.meetings`, a map keyed by `zoneId` that holds an entry only while the zone is occupied: `{ zoneId, meetingSessionId, occupancy, videoAvailable, videoCallActive, assistantStatus }`. `videoCallActive` remains false because video is not implemented. M4 updates `assistantStatus` to reflect the AI notes lifecycle; private roster, transcript, notes, room names, seat identities, and tokens stay out of synchronized state. `Player.zoneId` is derived from position for connected players, and `Player.audioMode` is `"meeting"` only while a meeting occupant.

A dropped or leaving connection is unregistered immediately and leaves its meeting, so its audio mode returns to floor. If it was the last occupant the meeting session ends and its room is deleted; otherwise the epoch rotates (below). A reconnect receives a fresh media identity; if the player is inside a zone the server rejoins or starts that zone's session, bumps the revision, and sends `meeting.entered` plus `media.transition` with reason `reconnect` (ack required). A reconnect on the floor produces no transition.

Self-hosted LiveKit does not revoke tokens already issued when a participant is removed, so a departing occupant could replay a still-valid token (up to 60 seconds). To prevent this, when someone leaves a meeting that continues, the remaining occupants move to a new media room (a new epoch) with a `media.transition` of reason `epoch_rotation` and brief reconnects, and the old room is deleted. Tokens for the old epoch can only reach a retired, deleted room, and rejoins there are evicted by the webhook. Because a room is addressed by its epoch, a replayed credential from a previous epoch or zone never reaches the current meeting.

The server reconciles at startup and every 30 seconds: it lists LiveKit rooms and participants, deletes unowned `floor_`/`meet_` rooms, and evicts unbound participants, logging `media.reconcile.failed` on failure. Two servers must not share one LiveKit.

Known limitations: there is a short window between epoch rotation and completion of old-room deletion in which the retired room still exists; privacy is only as strong as short token lifetime plus rotation and eviction, and a modified client can ignore the policy within its own room. The public floor stays non-confidential. Video remains a placeholder. Each leave of a multi-person meeting causes a brief reconnect for the remaining occupants. The shipped map has a single meeting zone, so room-to-room transitions are covered by automated tests only.

The [M3 verification guide](docs/M3_MEDIA_CHECK.md) is the three-person browser procedure. There are 117 automated server/domain tests, which cover zone ownership, the meeting state machine, the re-entry cooldown, token and transition-revision errors, epoch rotation, retired-room delete retries, drop/reconnect, reconcile failures, and replay against retired rooms. `npm run smoke:media` adds two synthetic Chromium checks: A and B hear each other privately inside `meeting-east` while floor listener C just outside the wall receives none of their audio, and when A walks out A returns to floor audio while B epoch-rotates and stops receiving A.

Validated on October 23, 2026: 117 tests, TypeScript checks, the production build, Docker Compose startup/health, and three consecutive passing runs of the synthetic media smoke against self-hosted LiveKit. Physical microphones, real listening, and separate-device/network validation of M3 still require the manual guide.

## M4: AI meeting notes

The `/media-harness/` exposes **Request AI notes**, consent/decline/withdraw, and stop/finalize controls only while connected inside a meeting. Requesting notes does not capture audio. Each current occupant must explicitly consent for the current roster revision; a roster change pauses the session, clears its transcript context, rotates the media epoch when an assistant was active, and requires fresh consent from everyone. Declining or withdrawing cancels the job and deletes stored transcript segments. Stop during capture cancels further capture and summarizes only committed transcript segments. Capture is read-only: the worker subscribes only to consenting meeting microphones and does not publish audio.

The client messages are `ai.request { requestId }`, `ai.consent { aiSessionId, revision, consent }`, and `ai.stop { aiSessionId, revision }`. The server returns private `ai.status` messages with the roster and lifecycle status, then `notes.ready { noteId, aiSessionId }` to the authorized readers. `GET /api/notes` and `GET /api/notes/:id` require a guest bearer token and enforce the readership snapshot frozen at capture consent; later entrants cannot read an earlier draft. Draft claims include transcript `segmentIds`; uncertain action-item owners and due dates remain `null`.

Every saved M4 note is currently marked `partial`: stop or meeting exit cancels capture and discards the worker's unfinished in-memory chunk instead of draining it. The default chunk length is 10 seconds. For a manual speech check, talk for at least 15 seconds and wait until the harness reports at least one speech excerpt transcribed before stopping; a session with no committed transcript segment returns `NO_TRANSCRIPT` and creates no note. Allow extra time for provider latency.

The application/worker API is internal under `/internal/ai/jobs/*`, authenticated with `AI_WORKER_SECRET`; it does not return worker jobs to browsers. `/readyz` reports AI as `disabled`, `up`, or `down`; `up` means an authenticated worker request arrived in the last 10 seconds. A capture that is not claimed/attached within 15 seconds fails. Jobs use renewable 15-second leases with worker heartbeats every 2 seconds, and cancellation invalidates a lease so late segments or model results cannot be saved. Provider requests have configured timeouts and responses are capped at 1 MB. A summary job attempt can make at most two provider calls (one retry); a failed or expired summary job gets at most two durable attempts, for a maximum of four provider calls. The server cancels processing after 120 seconds. The session duration limit starts at the first request, so consent and re-consent time count against it along with capture. Transcript size and concurrent sessions are also bounded. Raw audio is processed in memory and not written to disk. Durable transcript segments are cleared after completion, cancellation, or failure.

The M4 automated suite (161 tests at that milestone), production build, synthetic browser media smoke, and worker PCM/native-image checks passed. These checks do not exercise credentialed provider transcription or summary generation. A real two-person speech run, an unauthorized third-reader attempt, and withdrawal/new-entrant late-result checks on real devices still need to be recorded; no live-provider verification has been claimed. See the [M4 guide](docs/M4_AI_CHECK.md) for those checks and the evidence record.

## M5: reminders and demo readiness

Guests can create, edit, and cancel reminders for themselves through the media harness. A confirmed action item from AI notes is only a prefilled proposal; the user reviews it and selects **Create reminder** to save it. The server stores reminder records and due notifications in SQLite. It delivers `reminder.due` privately to the owner, retries unacknowledged notifications, and supports offline catch-up after reconnect. Clients deduplicate by `notificationId` and acknowledge with `reminder.ack`; delivery is at least once.

`POST /api/reminders` creates a reminder with a UUID `requestId`, text, an explicit-offset UTC ISO `dueAt`, and valid IANA `timezone`; a note/action-item reference can be supplied as `source`. `GET /api/reminders` returns only the owner's `{ reminders, nextCursor }`, up to 100 per page; pass `?before=<nextCursor>` to reach older reminders. `PATCH /api/reminders/:id` edits or cancels with a UUID `requestId` and positive `revision`. A stale revision or request-key reuse for a different mutation returns `409 CONFLICT`. The full contract and demo checklist are in the [M5 runbook](docs/M5_REMINDERS_CHECK.md).

CI exercises offline delivery, client deduplication, persisted acknowledgments, and reminder survival through server-container replacement on the same named volume. The registry-image example is [deploy/compose.images.yaml](deploy/compose.images.yaml); it accepts published images via `SERVER_IMAGE` and `WORKER_IMAGE`. A local backup restored into a new volume passed integrity and reminder recovery checks. A second-host deployment, trusted-TLS shared URL, and complete demo on separate physical machines are still pending manual acceptance. The runbook has an evidence record for those checks.

Typed AI panel, dependency radar and overlap review: [AI_PANEL.md](docs/AI_PANEL.md).

Decision questions, daily/catch-up briefs and meeting prep: [AI_KNOWLEDGE_TOOLS.md](docs/AI_KNOWLEDGE_TOOLS.md).
