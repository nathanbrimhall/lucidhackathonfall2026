# Server Roadmap

Build a Gather.town-style virtual office where people can walk up to talk, invite an AI assistant into a conversation, get draft notes, and receive reminders. Use Colyseus for authoritative multiplayer state and self-hosted LiveKit for realtime audio. Package the application as hardware-agnostic containerized services for portable deployment. Keep the protocol independent of Phaser so backend development and testing can start immediately.

This roadmap describes the server implementation plan. Defaults below are hackathon starting points, not measured capacity guarantees.

**Implementation status (2026-10-23): M0 — Foundation, M1 — Shared office, M2 — Walk up and talk, and M3 — Meeting rooms are implemented.** The repository includes the pinned Colyseus foundation, validated configuration, shared protocol v1, SQLite guest identity, authenticated seats, authoritative movement/collision, map endpoint, and Docker Compose with self-hosted LiveKit. M2 adds connection-bound microphone credentials, a 5 Hz private proximity policy with 6/7-tile subscription hysteresis, signed raw-body webhooks with bounded deduplication and delayed-event handling, participant cleanup, and a locally bundled browser media harness at `/media-harness/`. M3 adds authoritative meeting-zone membership, automatic private meeting audio in per-session LiveKit rooms, revisioned media transitions with client acknowledgement, media-room epoch rotation when someone leaves (self-hosted LiveKit does not revoke issued tokens), a 1-second re-entry cooldown against doorway churn, drop/reconnect handling, periodic reconciliation, and a public `meetings` indicator. AI notes, reminders, and optional video remain future work. The public floor is an audio experience, not a confidentiality boundary. The synthetic three-browser media smoke covers private meeting audio and exit rotation; physical-device validation of M3 is manual; see [M3 media verification](docs/M3_MEDIA_CHECK.md). See [README.md](README.md) for the API and [M2 media verification](docs/M2_MEDIA_CHECK.md) for browser checks and remaining physical-device validation.

M1 uses the shared v1 `player.input` payload `{ seq, dx, dy }` and `player.status` payload `{ status }`. Players are synchronized by Colyseus `sessionId`; their `userId` remains the durable guest identity. Clients cannot submit position or time. Input is limited to finite direction components in `[-1, 1]`, increasing safe integer sequences, and 60 application messages per second; held input expires after 250 ms. The office simulation and state patches run at 20 Hz with a server-defined movement speed and collision against [office.json](server/maps/office.json). A 30-second Colyseus reconnect reservation is used. The temporary SDK smoke client joins two distinct guests to the same room, observes movement remotely, rejects coordinate injection, and closes both connections.

## 1. Demo target and scope

The complete demo should support this sequence:

1. Two people enter the same office and see each other's presence and movement.
2. They approach each other and hear proximity audio; walking away fades it out.
3. They walk into a meeting-room zone on the map and automatically switch to that room's private audio. They can optionally start video and explicitly enable an AI note taker.
4. They discuss a task, stop the session, and receive a draft summary with action items.
5. One person confirms a suggested reminder and receives it in the office when due.

Target one office, one map, and roughly 10–20 concurrent people first. Implement the full vertical slice before adding multiple floors, customization, or scale infrastructure.

Assume adequate compute is available. Machine selection, resource sizing, and compute provisioning are outside this roadmap; deployment must not depend on a particular desktop, CPU vendor, GPU, or hosting provider.

**In scope:** session identity, room access, presence, movement validation, map collision and meeting-room zones, audio authorization, proximity policy, private meeting-room audio, AI session lifecycle, notes, reminders, persistence, Docker packaging, and deployment. Plan the server contract for an optional video-call prompt inside meeting rooms.

**Deferred:** Phaser scenes/rendering, map editor, screen sharing, external calendar/email integrations, organization SSO, autonomous agents roaming the map, and large-scale sharding. Meeting-room video is an optional extension after private audio works; its popup and video layout belong to the future frontend. A minimal browser media harness is allowed for verification; it is not the product frontend.

## 2. Architecture and ownership

```text
Future Phaser client / temporary test clients
    | HTTPS: sessions, notes, reminders, media credentials
    | WebSocket: inputs, state patches, private application events
    v
Node.js + TypeScript server
    +-- HTTP routes and session authorization
    +-- Colyseus OfficeRoom: movement, presence, meeting-zone membership
    +-- AudioPolicyService: authoritative proximity recommendations
    +-- LiveKitService: scoped tokens, participant lifecycle, webhooks
    +-- AI orchestration: consent, jobs, status, result delivery
    +-- SQLite: durable application records and job/outbox tables
                         ^
                         | trusted internal requests / durable jobs
                  AI worker process
                         | authorized meeting-room audio via LiveKit
                         | speech-to-text and model provider

Client <======== WebRTC audio ========> LiveKit
```

| Component | Responsibility |
| --- | --- |
| Colyseus | Room lifecycle, matchmaking, authoritative state, schema patches, reconnect support |
| Application room logic | Movement rules, collision, workspace access, proximity decisions, meeting-zone membership |
| LiveKit | Audio transport, media participants/tracks, WebRTC connectivity |
| AI worker | Authorized transcription, summary generation, action-item extraction |
| Durable storage and scheduler | Notes, confirmed reminders, retries, offline delivery |
| Future client | Input capture, interpolation, audio playback/gain, device permissions, optional video prompt, consent controls |

Colyseus supplies state synchronization: clients request changes and the server mutates room state. Do not implement a second multiplayer transport or broadcast complete snapshots on every movement. See [Colyseus state synchronization](https://docs.colyseus.io/state).

Audio goes directly through LiveKit. Never send PCM/audio frames through Colyseus, store secrets in synchronized state, or run model calls inside the simulation loop.

## 3. Stack and project shape

- Node.js LTS and TypeScript; use the official Colyseus starter as the server foundation.
- Colyseus with its WebSocket transport and `@colyseus/schema`; HTTP routes on the starter's supported HTTP integration.
- `livekit-server-sdk` for server-side credentials and room management; self-hosted LiveKit as a required containerized service in development and deployment. No LiveKit Cloud account or managed media dependency is required.
- Runtime request validation, structured logs, and a small test runner such as Vitest.
- SQLite with migrations and repository interfaces on a persistent volume for the single-instance demo. Move to Postgres before running application replicas.
- A separate TypeScript worker for AI work, using LiveKit Agents or its server RTC SDK for media ingestion. Keep model and transcription providers behind adapters.
- Docker images for the server and AI worker, plus LiveKit's official server image, with Docker Compose for local startup and a single-host demo deployment. Keep the services independently configurable and avoid host-specific paths or devices.

At kickoff, choose and lock mutually compatible Colyseus server, schema, testing, and client SDK versions. Record the versions and matching documentation; do not combine snippets from different release lines. Scaffold from [Create a Colyseus server](https://docs.colyseus.io/getting-started/server).

Proposed layout:

```text
Dockerfile
.dockerignore
compose.yaml
.env.example
deploy/
  livekit.yaml
server/
  src/
    app.config.ts
    rooms/OfficeRoom.ts
    rooms/schema/OfficeState.ts
    domain/{movement,collision,proximity,meeting-zones}.ts
    http/{sessions,media,notes,reminders,webhooks}.ts
    services/{LiveKitService,AISessionService,ReminderService}.ts
    auth/
    repositories/
    jobs/
    config.ts
  maps/office.json
  migrations/
  test/
worker/
  src/{index,transcription,summarization,providers}.ts
shared/
  src/{protocol,map-contract,validation}.ts
tools/
  smoke-client.ts
  media-harness/
```

Share protocol types and map contracts with the eventual frontend. Keep server credentials, repositories, and provider code out of shared exports.

## 4. Room model and protocol

### Identity and access

Maintain separate identifiers: `userId` for the person, `officeId` for the durable workspace, `roomId` for the current Colyseus instance, `sessionId` for a connection, and `mediaIdentity` for its LiveKit participant. A meeting room has a stable map `zoneId` and a separate `meetingSessionId` for its current occupied session. A display name is never an authorization identifier.

Here, a "meeting room" is a physical zone inside the map. Everyone remains in the same Colyseus office room; the zone determines their separate LiveKit media room. Walking through the doorway is the default admission action. Room locks or invitation-only access can be added later.

Start with invite-code guest access and a server-issued signed session token. Validate office membership at HTTP routes and the Colyseus authentication hook. Guest identity must be resumable so notes and reminders survive reloads. Choose one active connection per guest initially and reject duplicate tabs clearly.

Resolve an office to its existing room through a controlled matchmaking path. Concurrent joins must not accidentally create two copies of the same office; serialize creation in the initial process and reject joins when full instead of silently creating another instance. Room metadata and client-provided join options are not proof of access.

### Synchronized public state

| Record | Suggested fields |
| --- | --- |
| OfficeState | `officeId`, `mapId`, `mapVersion`, `serverTick`, players, meeting-room/assistant indicators |
| Player | `userId`, `sessionId`, `displayName`, `avatarId`, `x`, `y`, `facing`, `status`, `connected`, `zoneId`, `audioMode`, `lastProcessedInputSeq` |
| Meeting-room indicator | `zoneId`, `meetingSessionId`, `occupancy`, `videoAvailable`, `videoCallActive`, `assistantStatus`; keep private details server-side |

Store permission sets, session tokens, transcripts, notes, reminder contents, and model prompts outside public room state. Deliver private results only to authorized connections or through authenticated HTTP reads. Avoid unbounded chat/history arrays in synchronized schemas.

### Movement

- Accept input such as `{ seq, dx, dy }`, where direction components are bounded; derive the actor from the authenticated connection.
- Simulate at an initial 20 Hz and send state patches at an initial 10–20 Hz. Tune after measurement.
- Normalize diagonal input, apply server-owned speed and elapsed time, and check map bounds and collision before committing position.
- Keep only the latest valid input per tick; rate-limit messages, reject invalid/non-finite values, and ignore duplicate or stale sequence numbers.
- Expire held input after roughly 250 ms without updates so dropped connections do not keep walking. Never integrate a client-supplied position or arbitrary delta time.
- Load a versioned map contract containing dimensions, coordinate units, blocked tiles/rectangles, spawn points, and zone polygons. Use the same data contract for Phaser later.
- Define meeting zones with `id`, `name`, `bounds`, `audioMode: "meeting"`, and `videoEnabled`. Reject overlapping meeting-zone interiors during map validation, define exact boundary ownership, and derive membership from the player's server-authoritative position after movement/collision checks.

Use Colyseus reconnection support with an initial 30-second reservation. On a drop, stop movement and disable media participation; on reconnect, recheck access and reconcile media identity. Clean up on final leave and disposal. A server process restart requires a fresh room join; in-memory rooms are not durable. See [Colyseus reconnection](https://docs.colyseus.io/room/reconnection).

### Application messages and HTTP routes

These are proposed application contracts, separate from Colyseus's built-in matchmaking endpoints:

| Channel | Contract |
| --- | --- |
| HTTP | `POST /api/sessions/guest`: redeem invite, issue resumable guest session |
| HTTP | `POST /api/offices/:officeId/join`: authorize and return a Colyseus seat reservation |
| HTTP | `POST /api/media/token`: resolve the caller's current floor/meeting zone and transition revision, then issue scoped credentials |
| HTTP | `POST /api/meetings/:meetingSessionId/video`: verify current zone membership and enable camera publication for the caller after opt-in |
| HTTP | `GET /api/notes`, `GET /api/notes/:id`: authorized note retrieval |
| HTTP | `POST /api/reminders`, `PATCH /api/reminders/:id`, `GET /api/reminders`: confirm/manage own reminders |
| HTTP | `POST /api/livekit/webhook`: verified media lifecycle events |
| HTTP | `GET /healthz`, `GET /readyz`: liveness and application readiness |
| Client → room | `player.input`, `player.status`, `media.transition.ack`; meeting entry/exit comes from movement, not a client join claim |
| Client → room | `ai.request`, `ai.consent`, `ai.stop`, `reminder.ack` |
| Server → caller | `audio.policy`, `meeting.entered`, `meeting.exited`, `media.transition`, `meeting.video.available`, `ai.status`, `notes.ready`, `reminder.due`, `request.error` |

Version the protocol, validate every payload, and bound sizes. Use request IDs for retried mutations and durable idempotency keys for reminders/jobs. Return stable error codes such as `UNAUTHORIZED`, `ROOM_FULL`, `INVALID_INPUT`, and `AI_UNAVAILABLE`.

## 5. LiveKit and proximity audio

### Public office audio

Use one LiveKit room per active office instance for the public floor. The app computes who should be heard from server positions and sends each listener a private `audio.policy` with a monotonically increasing revision, eligible speaker identities, and distance/gain information.

Starting policy, with one tile as the distance unit:

- Full gain inside 2 tiles; fade toward zero at 6 tiles.
- Subscribe when entering a 6-tile radius and unsubscribe after leaving 7 tiles to reduce boundary churn; gain remains zero beyond 6 tiles.
- Recompute eligibility around 5 Hz and smooth gain changes locally. Movement synchronization remains independent.
- Compare listener-to-speaker distance directly. A person hearing two people does not make those two people hear each other.
- Respect zone boundaries, mute/deafen preferences, disconnect state, and meeting mode. Meeting-room occupants are excluded from public-floor audio in both directions. Add wall-aware occlusion later if needed.

The future media adapter connects with automatic subscription disabled, subscribes to eligible microphone tracks, and applies gain. LiveKit supports selective subscriptions and volume control, but it does not derive map proximity for us. See [Subscribing to tracks](https://docs.livekit.io/transport/media/subscribe/).

**Public-floor proximity is an audio experience, not a confidentiality boundary.** A modified client with subscription permission could receive other public-floor tracks. Server-triggered subscription changes alone do not establish per-speaker authorization. Describe the public floor accordingly; meeting-room media is isolated in separate LiveKit rooms.

### Map-defined meeting rooms

Create a separate LiveKit room with an opaque server-generated name for each occupied meeting zone/session. Keep avatars in the Colyseus office while changing their audio mode. Issue media credentials only to connected players whose authoritative position is inside that zone and to its authorized assistant.

Inside a meeting room, all occupants hear one another at normal volume regardless of their distance within the zone. People outside cannot hear the meeting, and meeting occupants cannot hear the public floor or another meeting room. This privacy is relative to people outside the zone: any office member can walk in by default.

For each authoritative zone change:

1. Increment a per-player transition revision and immediately invalidate the old media authorization. Send the destination zone/session and transition status privately to the client.
2. Stop/unpublish and leave the previous media room before joining/publishing in the destination. Coordinate client acknowledgments with server-side participant removal so a stalled client cannot keep a microphone active in both rooms.
3. Recheck the current zone and revision before issuing destination credentials or accepting completion. Ignore stale acknowledgments/token requests if the player has already walked elsewhere.
4. Preserve the user's mute/deafen choices. Entry changes the conversation automatically but never enables a previously muted microphone or grants device permission on the user's behalf.
5. On exit, remove meeting access and restore floor proximity; on direct room-to-room movement, switch between the two isolated media rooms. If a transition fails, remain muted and offer retry.

Use doorway geometry and deduplicated transitions to avoid boundary churn. Do not debounce exits by allowing someone outside the zone to keep receiving meeting audio. On disconnect, remove media access immediately even while retaining the Colyseus reconnect reservation.

The first occupant starts a new meeting session; additional occupants join the existing session. When the last person leaves, end its AI capture, finalize any authorized notes, and clean up the media room/agent. A later visit starts a fresh session so previous consent, notes access, and video state do not carry over.

Self-hosted LiveKit does not invalidate an existing token when a participant is removed. On exit, deny new credentials and remove the participant, then retire the old media-room epoch and move remaining occupants and the authorized assistant to a fresh room with new credentials. Stop publication/capture in the retired room before resuming in the replacement. Previously issued tokens must never reach the continuing meeting's audio; even if one recreates the retired room, it contains no current meeting streams. Bind transition credentials to the current epoch and test replay explicitly. Short TTLs alone do not establish immediate revocation. See [self-hosted token behavior](https://docs.livekit.io/frontends/reference/tokens-grants/#token-revocation).

### Optional video inside meeting rooms

Expose `videoAvailable` from the map's zone configuration and emit a private entry event so the future client can show a "Start video" or "Join video" prompt. Dismissing it keeps the person in private audio. Starting video marks the current meeting session as video-active and lets the other occupants choose whether to enable their own cameras.

Use camera tracks in the same LiveKit meeting room; no second call service or additional media room is needed. After a user opts in, the server rechecks zone/session membership and updates that participant's publish permissions to allow microphone and camera. Existing participant permissions can be updated through the [LiveKit server SDK](https://docs.livekit.io/reference/server-sdk-js/classes/RoomServiceClient.html); the browser then explicitly enables camera capture through the [camera publication API](https://docs.livekit.io/transport/media/publish/).

Never automatically activate cameras on entry or because another person starts video. Preserve audio if camera permission is denied. On zone exit, unpublish camera tracks and disconnect from meeting media; do not publish video to the public floor. AI note takers remain audio-only. Actual popup/video rendering stays in the future frontend scope.

### Credential and lifecycle rules

Mint LiveKit tokens only on the backend after checking the caller's live application membership and current zone/transition revision. Derive identity and room from server records. Use an initial five-minute join TTL, microphone-only publication by default, required subscription permissions, and no room administration/recording grants. Allow camera publication only after explicit opt-in in a video-enabled meeting room; keep the public floor microphone-only. API secrets never reach the browser. See [LiveKit access tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/).

Validate webhooks with the SDK receiver against the raw request body before JSON middleware changes it. Deduplicate event IDs; tolerate missing, delayed, and repeated events by periodically reconciling active sessions with LiveKit. Webhooks do not grant office membership. See [LiveKit webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/).

## 6. First-class AI: notes and reminders

### Assistant lifecycle

Give each AI session an explicit application identity, meeting-zone/session scope, authorized participants, and visible status:

```text
requested → awaiting_consent → starting → listening → summarizing → completed
                         any active state → stopped / failed
```

1. A meeting-room occupant requests notes. Require explicit consent from every current participant before capturing any audio. Walking into the room does not imply consent to AI processing.
2. Persist the consent roster/revision, then dispatch one assistant for that session. Make repeated requests idempotent.
3. The worker joins only that meeting session's isolated media room and subscribes only to consenting participants. Default to no audio publication for a note taker.
4. Transcribe separate participant tracks with speaker identity, timestamps, and segment IDs. Use finalized segments for notes.
5. If zone occupancy changes, pause capture before admitting a new occupant to meeting media, discard uncommitted buffered audio, and obtain consent for the revised roster before resuming. Human conversation continues even if the newcomer declines AI notes. Withdrawal or stop cancels capture and pending processing for the affected session.
6. On session end, generate structured draft notes: summary, decisions, action items, suggested owners, and suggested due times. Link claims to transcript segment IDs; leave uncertain owners/dates unset.
7. Persist the draft with an authorized readership snapshot and notify those readers. A later entrant to the same map room must not automatically gain access to earlier notes.

Use explicit dispatch so agents join only when requested. LiveKit provides agent job lifecycle infrastructure; application code still owns authorization, consent, and results. See [LiveKit agent dispatch](https://docs.livekit.io/agents/server/agent-dispatch/) and [agent server overview](https://docs.livekit.io/agents/server/).

Implement the summarization path with a fixed transcript fixture first, then connect real transcription to that same interface. Text input can remain a labeled demo fallback if speech service access fails; it does not complete the live conversation-notes milestone.

### Reminder workflow

- Let users create a reminder directly or confirm an AI suggestion. The model proposes; an authenticated application action creates the reminder.
- MVP users create reminders for themselves. Shared assignment and external notifications come later.
- Store an explicit UTC due timestamp plus the user's IANA timezone. Resolve relative dates against the conversation timestamp and timezone; require clarification when ambiguous.
- Use a durable scheduler that polls due records, claims them transactionally, and writes an outbox notification. Recover expired job leases after worker crashes.
- Deliver `reminder.due` privately to the online owner; retain it as unread for the next join if offline. Acknowledge with notification ID and deduplicate client delivery. Promise at-least-once delivery with deduplication, not impossible network-level exactly-once delivery.
- Editing/canceling a reminder must invalidate pending work for its previous revision. A restart must not lose confirmed reminders.

### Boundaries and failure handling

Keep transcription/model credentials server-side. Give model calls only the authorized session context; treat transcripts as untrusted content. Validate structured outputs and allowlist tools so a spoken instruction cannot grant access or execute arbitrary code.

Set per-session duration, transcript length, model token, concurrency, and spend limits. Apply timeouts and bounded retries; surface failure and allow retry without duplicating notes or reminders. Check the session/consent revision again before saving a late result.

Default to no raw-audio storage. Keep transcripts only for the session's processing window and delete them after completion or a short documented failure TTL. Keep draft notes and reminders until deletion. If capture is interrupted, label resulting notes as partial rather than silently claiming completeness.

## 7. Persistence and recovery

Minimum durable tables:

| Table | Purpose |
| --- | --- |
| `users`, `office_memberships` | Guest identity and workspace access |
| `ai_sessions`, `ai_consents` | Authorized roster, capture status, consent revision |
| `transcript_segments` | Temporary speaker-attributed context with expiration |
| `notes`, `note_readers` | Draft artifact, source session, authorized readers |
| `reminders` | Owner, text, due time/timezone, status, revision |
| `jobs`, `notification_outbox` | Durable retries, leases, idempotency, pending private delivery |

Keep live positions, active room objects, and proximity calculations in memory. A restart restores the map and durable records, marks interrupted AI sessions, and asks users to rejoin; it does not pretend to restore a running media session. Clean up orphaned meeting media rooms/agents through startup reconciliation. Route worker completion back through application services; the worker must not mutate Colyseus state directly.

## 8. Ordered implementation milestones

Each milestone should be independently demonstrable. The complete hackathon target is M0–M5; later work is optional.

| Milestone | Deliverables | Exit check |
| --- | --- | --- |
| **M0 — Foundation** | Starter server, pinned dependencies, config validation, shared protocol, migrations, guest sessions, health routes, initial Dockerfile/Compose with self-hosted LiveKit | Fresh checkout builds and starts application/media services through Docker Compose without host Node.js or a LiveKit Cloud account; health checks pass and unauthorized joins fail |
| **M1 — Shared office** | One canonical room per office, player schema, validated input, collisions, reconnect cleanup, map contract | Two headless SDK clients join the same instance and observe authoritative movement; teleport/speed attempts fail |
| **M2 — Walk up and talk** | LiveKit token service, identity binding, public proximity policy, verified webhooks, minimal browser media harness | Three browser users hear the intended nearby speakers; moving across the boundary does not repeatedly connect/disconnect |
| **M3 — Meeting-room zones** | Map zone detection, automatic private-audio entry/exit, separate media rooms, transition revisions, media-room epoch rotation, empty-room cleanup | Two people inside hear each other; a nearby person outside cannot receive meeting audio; exiting restores floor proximity and replaying old credentials cannot reach the continuing meeting |
| **M4 — AI notes** | Consent lifecycle, worker dispatch, real transcription, structured draft notes, access checks | Two consenting users speak, stop, and retrieve notes; a third user cannot read them; revocation stops capture |
| **M5 — Reminders and demo readiness** | Confirm/create/edit/cancel reminders, durable scheduler/outbox, offline delivery, server/worker images, deployment/runbook | A confirmed reminder survives container replacement and appears once in the UI after deduplication; the same image runs on a second Docker host and the full demo works on separate machines |
| **M6 — After the demo** | Meeting-room video if not already added, optional room locks, Postgres/Redis scale path, richer agents, integrations | Prioritize from measured bottlenecks and user feedback |

Dependency order: M0 → M1 → M2 → M3 → M4 → M5. Build persistence and the direct reminder path early when useful, but preserve this end-to-end demo path. Cut cosmetic features, video, additional maps, and voice replies before cutting reliable movement, audio, notes, or reminders.

**Optional extension after M3:** implement the video opt-in endpoint, session video indicators, and camera permissions; verify with the browser media harness. This can ship independently of AI notes and reminders without adding Phaser UI work.

## 9. Verification and operating targets

Use Colyseus SDK clients and room tests for multiplayer verification; use real browser/WebRTC sessions for media. Headless movement tests cannot establish that microphones or audio playback work.

- **Movement:** collision edges, normalized diagonals, malformed input, stale sequences, input timeout, reconnect reservation expiry, simultaneous office joins, full-room rejection, exact meeting-zone boundaries, and overlapping-zone rejection.
- **Media:** near/far behavior, hysteresis, independent three-person distances, mic denial, mute/deafen, republishing tracks, forged zone claims, cross-zone isolation, rapid doorway crossings, room-to-room transitions, exit/token replay, delayed webhooks, and failed transitions.
- **Optional video:** prompt eligibility, explicit camera opt-in, camera denial preserving audio, others' cameras remaining off, stale enable requests after exit, and no camera publication on the public floor.
- **AI:** no consent/no capture, new member pauses capture, withdrawal, worker crash, repeated dispatch, late results, model timeout, malformed outputs, access isolation, and transcript cleanup.
- **Reminders:** duplicate creation, timezone conversion, canceled/rescheduled jobs, scheduler restart, offline catch-up, repeated notification delivery, and acknowledgments.
- **Containers:** clean image builds, non-root startup, migration ordering, HTTP/WebSocket reachability, graceful `docker stop`, and durable records surviving container replacement with the data volume retained. Verify both target CPU architectures before advertising support.
- **Load:** start with 20 synthetic movers for ten minutes plus a small real audio group. Record event-loop delay, tick duration, patch sizes, CPU/memory, media quality, and proximity update latency. Increase only after this passes.

Initial targets: p95 simulation work below the 50 ms tick budget; policy changes delivered within 500 ms under test conditions; due notifications delivered within five seconds while services are healthy. Measure voice and model latency separately before setting promises.

Deploy one long-running application container with persistent storage, one worker container, and one self-hosted LiveKit container. Supply HTTPS/WSS and the required media connectivity through deployment configuration. Verify real WebRTC connectivity from separate client devices and the demo network, including a second network if possible. An HTTP reverse proxy alone is insufficient for WebRTC; configure LiveKit's documented UDP/TCP/TURN connectivity as part of the initial deployment. See [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/).

Document startup, migrations, demo guest creation, seed map, service credentials, restart/reset, and known limitations. Suggested config: `PORT`, `PUBLIC_SERVER_URL`, `ALLOWED_ORIGINS`, `SESSION_SECRET`, `DATABASE_URL`, `LIVEKIT_INTERNAL_URL`, `LIVEKIT_PUBLIC_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, provider credentials, and AI budget/time limits. Internal application/worker connections use `LIVEKIT_INTERNAL_URL` (mapped to the worker SDK's `LIVEKIT_URL`); browser credentials return `LIVEKIT_PUBLIC_URL`. Validate required values at startup and redact tokens/transcripts from logs.

On shutdown, stop new joins/jobs, drain room activity, stop capture, release/expire job leases, and close storage cleanly. Expose dependency degradation separately from liveness so a model outage does not take down the office.

## 10. Docker packaging and portable deployment

Docker support is part of the initial implementation, not a final packaging task. The finished stack should run on any compatible container host, with environment-specific configuration supplied at runtime. Assume the host provides adequate compute; do not add machine-specific tuning, hardware detection, or infrastructure provisioning. See Docker's [Node.js container guide](https://docs.docker.com/guides/nodejs/).

### Images and runtime contract

- Provide a root multi-stage `Dockerfile` with separate `server-runtime` and `worker-runtime` targets. Install from the lockfile, compile TypeScript during the build, and include only required production dependencies, compiled shared code, maps, and migration assets in the runtime stages.
- Use a pinned Node.js LTS base compatible with the SQLite and LiveKit native dependencies. Start with a Debian slim variant; build native dependencies inside the target platform image rather than copying host `node_modules`.
- Run as a non-root user. Make only the data directory writable as needed; exclude `.git`, local databases, `.env` files, host dependencies, and generated local artifacts through `.dockerignore`.
- Bind the application to `0.0.0.0` on configurable `PORT` (initial default `2567`), serving HTTP and Colyseus WebSockets on that port. Configure the public HTTPS/WSS address separately from the bind address.
- Supply configuration and credentials through runtime environment variables or mounted secrets. Publish `.env.example` with placeholders. Never bake credentials into an image or require source edits for deployment.
- Write application logs to stdout/stderr. Use an exec-form Node entrypoint, handle `SIGTERM`, and configure a bounded shutdown grace period. Use an init process for the worker if required to reap its job subprocesses.
- Provide health checks using a tool available in the runtime image, such as Node's HTTP client. Application readiness requires completed migrations and usable storage; report AI/media outages separately.
- Publish `linux/amd64` and `linux/arm64` image variants for portable container execution. Build and smoke-test both, including native SDK loading; keep deployment configuration independent of the host's hardware.

### Compose topology and durable storage

| Service | Deployment contract |
| --- | --- |
| `server` | Required application container; exposes port `2567`, owns SQLite and the scheduler, mounts a named volume at `/data` |
| `worker` | Separate AI container added with the AI milestone; receives jobs and submits results through an authenticated internal application API |
| `migrate` | One-shot command from the server image; mounts the data volume and completes migrations before the server starts |
| `livekit` | Required media container using a pinned official image and mounted runtime configuration; exposes signaling and the configured WebRTC/TURN ports |
| `proxy` | TLS/WebSocket termination for application and LiveKit signaling when an existing deployment proxy is not supplied |

Only the server and migration job access the SQLite files; the worker does not mount the database volume. Serialize migration execution, configure volume ownership for the runtime user, and set dependency conditions for successful migration/application readiness. Keep external-call retries in the application because startup ordering does not handle later outages. See [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/).

Persist the database and any SQLite journal/WAL files under `/data`; retain the named volume across image upgrades and container replacement. Document backup/restore and deliberate volume deletion. Moving an image to a new host does not move its data: copy a consistent database backup or restore into a new volume. See [Docker volumes](https://docs.docker.com/engine/storage/volumes/).

Use Compose service DNS names for container-to-container traffic. Browser clients need externally reachable application and LiveKit URLs; a container hostname or container-local `localhost` is not a public endpoint. Terminate TLS at the deployment's reverse proxy/load balancer with WebSocket upgrade support. Configure a reachable LiveKit webhook callback URL for each environment.

### Self-hosted media configuration

Keep LiveKit configuration in `deploy/livekit.yaml`, with credentials supplied at runtime and networking values set per environment. Use one LiveKit node initially; add Redis only when required by a selected feature or a later multi-node deployment. Single-node media does not inherently require Redis. See [LiveKit SFU architecture](https://docs.livekit.io/reference/internals/livekit-sfu/).

Document signaling (`7880` internally), ICE/TCP (`7881` by default), and either a configured UDP media range or LiveKit's single-port UDP multiplexing option. Include TURN when clients need relay connectivity. Configure reachable advertised addresses and any host/router firewall rules; do not hardcode a developer's IP or require host networking as the only supported deployment mode. See [LiveKit network configuration](https://docs.livekit.io/transport/self-hosting/ports-firewall/).

Provide separate localhost-development and shared-access configuration examples. Shared browser access needs a trusted HTTPS origin for microphone/camera capture, including when the server is on the same LAN; plain HTTP to a LAN IP is not equivalent to the browser's localhost exception. See [browser media secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#privacy_and_security).

Run the AI worker against this self-hosted LiveKit instance. Keep transcription/model endpoints configurable; choosing self-hosted media does not select a local model runtime or impose a GPU requirement. Provider selection remains independent of container hosting, and the roadmap makes no fully offline AI guarantee.

### Delivery and acceptance

Document `docker compose up --build` as the target local startup command after environment setup, plus image-only startup from a registry for deployment. These commands become supported when the Docker assets are implemented; this roadmap does not yet supply runnable containers.

Build and smoke-test images in CI, then publish versioned tags and record the deployed image digest so rollback uses a known artifact. Run migrations as an explicit deployment step and document database compatibility/backup requirements before rollback. The default deployment remains one server replica while it owns SQLite and in-memory offices.

Acceptance: a teammate with Docker and configured application/provider credentials can build/start the app, worker, and self-hosted media without installing Node.js or creating a LiveKit Cloud account, connect two SDK clients, and verify media across separate devices. Replacing the server container preserves notes/reminders on its volume, and deploying the same images on another compatible host requires only configuration, networking, and storage setup.

## 11. Scale only after the vertical slice

Start with straightforward pairwise proximity checks; use a spatial grid if profiling justifies it. Scale across offices before attempting to split one shared map across processes.

For multiple Colyseus processes, add shared presence and a shared matchmaking driver, plus routing that reaches the process owning each room. Redis is coordination infrastructure, not durable office state or live-room failover. A room remains owned by one process; adding workers does not distribute its simulation. See [Colyseus scalability](https://docs.colyseus.io/scalability).

Before application replicas, move durable data/jobs to shared storage, enforce office-room uniqueness across processes, add transactional job claims, and reconcile media state across restarts. Add further infrastructure only for an observed constraint.
