# Client protocol

This is the contract between a client and the Lucid office server: HTTP endpoints, Colyseus room messages, and the media (LiveKit) procedure. The bundled frontend and `/media-harness/` both follow it. Types live in [`shared/src/protocol.ts`](../shared/src/protocol.ts) and routes in [`server/src/app.config.ts`](../server/src/app.config.ts).

Examples assume the server is on `http://localhost:2567`.

## Conventions

- Authenticated HTTP requests send `Authorization: Bearer <session token>`.
- Request bodies are strict JSON; unknown fields are rejected.
- HTTP errors use `{ "error": { "code": "...", "message": "..." } }`.
- Invalid room messages receive a private `request.error { code, message }` with a stable code.
- Each client may send up to 60 room messages per second.
- The protocol version is `1`.

## Sessions

### Create a guest

Redeem the configured invite code. The returned token expires after seven days; store it securely.

```sh
curl -sS http://localhost:2567/api/sessions/guest \
  -H 'Content-Type: application/json' \
  -d '{"inviteCode":"your-invite-code","displayName":"Ada"}'
```

The response contains `token`, `userId`, `officeId`, `displayName` and `expiresAt`.

### Recover the current identity

```sh
curl -sS http://localhost:2567/api/sessions/current \
  -H 'Authorization: Bearer YOUR_SESSION_TOKEN'
```

## Joining the office

Public matchmaking is blocked. Request a seat over authenticated HTTP, then pass the reservation to the Colyseus SDK:

```ts
import { Client } from "@colyseus/sdk";

const token = "YOUR_SESSION_TOKEN"; // Load from secure client storage.
const response = await fetch("http://localhost:2567/api/offices/demo-office/join", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ protocolVersion: 1 }),
});
if (!response.ok) throw new Error(`Office join failed: ${response.status}`);
const reservation = await response.json();

const client = new Client("ws://localhost:2567");
const room = await client.consumeSeatReservation(reservation);
room.onMessage("session.ready", (identity) => console.log("Joined office", identity));
```

A join returns `409` with:

- `DUPLICATE_CONNECTION` when that guest already has a reserved or active seat.
- `ROOM_FULL` when all 20 seats are taken.

`GET /api/offices/:officeId/map` returns the versioned map contract (walls, collision, meeting zones) for an authenticated guest.

### Reconnecting

Keep `room.reconnectionToken` to resume a dropped connection within 30 seconds, then continue input sequence numbers from `lastProcessedInputSeq`:

```ts
persistSecurely(room.reconnectionToken);
const resumedRoom = await client.reconnect(loadSecurelySavedReconnectToken());
let nextSeq = (resumedRoom.state.players.get(resumedRoom.sessionId)?.lastProcessedInputSeq ?? -1) + 1;
resumedRoom.send("player.input", { seq: nextSeq++, dx: 1, dy: 0 });
```

Room state is held in memory. After a server restart, use the saved bearer token to request a fresh seat.

## Movement and presence

The simulation runs at 20 Hz with 20 Hz state patches. The server owns position: clients send direction only, and the server applies speed, elapsed time, map bounds and collision. Held input expires after 250 ms.

| Client → server | Payload |
| --- | --- |
| `player.input` | `{ seq, dx, dy }` |
| `player.status` | `{ status: "available" \| "away" \| "busy" }` |

```ts
room.send("player.input", { seq: 1, dx: 1, dy: 0 });
room.send("player.status", { status: "busy" });
room.onMessage("request.error", ({ code, message }) => console.warn(code, message));
```

Players are synchronized keyed by Colyseus `sessionId`. `Player.zoneId` is derived from position, and `Player.audioMode` is `"meeting"` only while the player is a meeting occupant.

## Audio

### Media credentials

`POST /api/media/token` (bearer token) with `{ sessionId, transitionRevision? }`. The session must be a currently connected seat owned by the caller. The response is:

```
{ url, token, mediaIdentity, roomName, expiresAt, transitionRevision, mode, zoneId, meetingSessionId? }
```

- `mode` is `"floor"` or `"meeting"`; `meetingSessionId` is present only for meetings.
- Credentials are valid for 60 seconds of admission and allow microphone publish and subscribe only (no camera, screen or data).
- Clients cannot choose identities, rooms, zones or grants. Identities are refreshed after a reconnect.
- Do not log or persist media tokens.

| Error | Meaning |
| --- | --- |
| `400 INVALID_INPUT` | Malformed body |
| `401 UNAUTHORIZED` | Missing or invalid session |
| `403 FORBIDDEN` | Not your connected seat, or the seat dropped during signing |
| `409 STALE_TRANSITION` | Revision isn't current, or a transition happened during signing |
| `409 TRANSITION_PENDING` | A transition is pending and the revision was omitted or not yet acknowledged |
| `503 UNAVAILABLE` | Signing or old-room removal failed; retry with the same revision |

### Preferences and listening policy

Clients send `media.preferences { muted, deafened }`. Both start muted and stay private; the server never unmutes anyone, and preferences carry across rooms.

The server sends each listener a private `audio.policy` at 5 Hz:

```
{ revision, mode, zoneId, speakers: [{ mediaIdentity, distance, gain }] }
```

- **Floor** (`mode: "floor"`, `zoneId: ""`): distances are in tiles. Gain is 1 up to 2 tiles and fades linearly to 0 at 6. Speakers enter the list at ≤6 tiles and stay until >7 (hysteresis), with zero gain beyond 6.
- **Meeting** (`mode: "meeting"`): speakers are the other connected, unmuted occupants of the same zone at gain 1.
- Muted, disconnected and other-zone speakers are excluded. Deafened listeners receive an empty list.

Connect to LiveKit with automatic subscription disabled, subscribe to the policy's speakers, and apply its gains.

### Meeting rooms and transitions

Meeting membership comes from the authoritative position only. Zone rectangles include their left/top edges and exclude right/bottom, and zones never overlap. Re-entering a meeting within 1 second of walking out is deferred until the cooldown ends. First entries, direct room-to-room moves and reconnects are not delayed.

A zone change sends the client, in order:

1. `meeting.exited { zoneId, meetingSessionId, revision }` (if leaving)
2. `meeting.entered { zoneId, meetingSessionId, name, videoAvailable, revision }` (if entering)
3. `media.transition { revision, mode, zoneId, meetingSessionId?, reason }`, where `reason` is `zone_change`, `epoch_rotation` or `reconnect`

On `media.transition` with revision R, the client must:

1. Stop the microphone and disconnect from the current LiveKit room. Never reconnect to it.
2. Send `media.transition.ack { revision: R }`.
3. Request `POST /api/media/token` with `transitionRevision: R`.
   - On `TRANSITION_PENDING`, retry shortly.
   - On `STALE_TRANSITION`, abandon R and follow the newest transition.
   - On `503`, stay disconnected and retry with the same R.
4. Connect to `credentials.roomName`, apply `audio.policy`, and republish the microphone only if the user is unmuted.

The server removes the participant from the old room when it sends the transition, so a `PARTICIPANT_REMOVED` disconnect may arrive first; treat it as expected. Stale or future acks are ignored silently.

When someone leaves a meeting that continues, the remaining occupants are moved to a new media room (an *epoch rotation*) and the old room is deleted, so a departing person's unexpired credential can't reach the current meeting.

Public state includes `OfficeState.meetings`, keyed by `zoneId` and present only while occupied: `{ zoneId, meetingSessionId, occupancy, videoAvailable, videoCallActive, assistantStatus }`. Rosters, transcripts, notes, room names and tokens are never synchronized.

### LiveKit webhook

`POST /api/livekit/webhook` accepts `application/webhook+json` up to 64 KiB. It verifies the raw-body signature with the configured LiveKit key, deduplicates event IDs, ignores delayed events for older participant SIDs, and evicts unknown or stale identities. Media events never create office membership.

Compose points LiveKit at `http://server:2567/api/livekit/webhook`. If the server runs outside Compose, update [`deploy/livekit.yaml`](../deploy/livekit.yaml) (for Docker Desktop, `http://host.docker.internal:2567/api/livekit/webhook`).

The server also reconciles every 30 seconds and at startup, deleting unowned rooms and evicting unbound participants. Two servers must not share one LiveKit.

## AI meeting notes

Available only inside a meeting when `AI_ENABLED=true`.

| Client → server | Payload |
| --- | --- |
| `ai.request` | `{ requestId }` |
| `ai.consent` | `{ aiSessionId, revision, consent }` |
| `ai.stop` | `{ aiSessionId, revision }` |

| Server → client | Payload |
| --- | --- |
| `ai.status` | Roster, consent and lifecycle status, sent to every occupant |
| `notes.ready` | `{ noteId, aiSessionId }`, sent to authorized readers |

- Every occupant must consent for the current roster revision before capture starts. A roster change pauses capture, clears transcript context and requires fresh consent.
- Declining or withdrawing cancels the session and deletes stored transcript segments. Stopping summarizes only segments already transcribed.
- A session with no transcribed segment ends with `NO_TRANSCRIPT` and produces no note.

`GET /api/notes` and `GET /api/notes/:id` return only notes whose readership (frozen at consent time) includes the caller. Draft claims cite transcript `segmentIds`; uncertain owners and due dates are `null`.

The worker uses an internal API under `/internal/ai/jobs/*` (`claim`, then `:id/heartbeat`, `:id/segments`, `:id/complete`, `:id/fail`), authenticated with `AI_WORKER_SECRET`. It is never exposed to browsers. See [`worker/README.md`](../worker/README.md).

## Reminders

- `POST /api/reminders` with `{ requestId, text, dueAt, timezone, source? }`. `requestId` is a UUID, `dueAt` is an ISO timestamp with an explicit offset, and `timezone` is an IANA name. `source` optionally references a note action item.
- `GET /api/reminders` returns the caller's `{ reminders, nextCursor }`, up to 100 per page. Pass `?before=<nextCursor>` for older ones.
- `PATCH /api/reminders/:id` with `{ requestId, revision, text?, dueAt?, timezone?, status?: "canceled" }`.
- A stale revision, or reusing a `requestId` for a different change, returns `409 CONFLICT`.

When a reminder is due, the owner receives a private `reminder.due` message, including on reconnect for any missed while offline. Delivery is at least once: deduplicate by `notificationId` and acknowledge with `reminder.ack`.

## Collaboration and assistant

The integrated frontend also uses these authenticated endpoints. Their payloads are defined in [`shared/src/collaboration.ts`](../shared/src/collaboration.ts) and [`shared/src/office-assistant.ts`](../shared/src/office-assistant.ts).

| Endpoint | Purpose |
| --- | --- |
| `GET /api/collaboration` | Everything the panels need for the caller: directory, profile, tasks, desk notes, notifications, drafts and assistant usage |
| `PATCH /api/collaboration/profile` | Update shared focus/skills |
| `POST /api/collaboration/tasks`, `PATCH /api/collaboration/tasks/:id` | Propose, accept, edit or complete tasks |
| `POST /api/collaboration/tasks/:id/dependencies`, `.../dependencies/remove` | Confirm or remove a dependency |
| `POST /api/collaboration/tasks/:id/link`, `.../unlink` | Link or unlink a duplicate proposal |
| `POST /api/collaboration/drafts`, `PATCH /api/collaboration/drafts/:id` | Save, edit or approve a message draft |
| `POST /api/collaboration/drafts/:id/send` | Send an approved draft as a desk note |
| `POST /api/collaboration/messages`, `.../messages/:id/read` | Send or mark read a desk note |
| `POST /api/collaboration/notifications/:id/read` | Mark a notification read |
| `POST /api/assistant` | Ask the assistant (one model request per call; `429` on quota, `503` on provider failure) |

## Health

- `GET /healthz`: liveness.
- `GET /readyz`: storage readiness plus dependency status. `dependencies.ai` is `disabled`, `up` or `down`; `up` means an authenticated worker request arrived in the last 10 seconds, not that a provider call succeeded.

## Known limitations

- Floor audio is a listening experience, not a confidentiality boundary. A modified client can subscribe to any floor track in its room, and self-hosted LiveKit doesn't revoke issued tokens, so a floor credential can be replayed until it expires.
- Between an epoch rotation and deletion of the old room there is a short window in which the retired room still exists.
- Each departure from a multi-person meeting causes a brief reconnect for the people who stay.
- Video is a placeholder: `videoCallActive` is always false.


## Shared agent assignments

The office now synchronizes a separate `agents` map: `{agentId,x,y,state,badge,sponsorUserId}`. Agents never appear in `players`, meeting rosters or audio policies. State is generic; detailed assignments and inbox items follow authenticated HTTP access checks. A private, availability-gated `agent.request` event carries only `{requestId}` and prompts inbox refresh. Durable inbox access does not depend on that event or on avatar proximity.

See [agent implementation](AGENT_IMPLEMENTATION.md#persistence-and-api) for the versioned browser/worker API, authorization, event cursor, request budgets and exact-revision publication contract.

Agent respondents may voluntarily replace a current unexpired answer through `POST /api/agents/requests/:id/revise` with `{requestId, revision, answer, allowPublication}`. This increments the answer revision and supersedes the draft; only the original respondent may submit it. `GET /api/agents/requests/:id/versions` returns the retained answer history only to that respondent or the assignment requester. Declined requests stay closed, and completed/canceled assignments cannot resume.

A worker result may include both questions and an independent partial draft in one terminal turn. The server persists them together, then releases the lease while requests are open. Each actual response queues one continuation; polling an inbox never queues model work. A response arriving during inference invalidates the older lease. Corrected answers rebuild without superseded artifacts or earlier review comments.
