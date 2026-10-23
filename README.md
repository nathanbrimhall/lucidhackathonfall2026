# Lucid Virtual Office

A virtual office where people can walk up to conversations, with AI notes and reminders planned for later milestones. M2 adds authenticated LiveKit microphone credentials, public-floor proximity audio, verified lifecycle webhooks, and a browser media harness to the shared office and authoritative movement from M1. The AI worker is deferred until M4.

## Run with Docker Compose

Install Docker with the Compose plugin, then prepare local settings:

```sh
cp .env.example .env
```

Change the session secret, guest invite code, and LiveKit API secret before sharing access. Then start the application and self-hosted LiveKit:

```sh
docker compose up --build
```

Compose initializes the named SQLite volume, applies migrations in a one-shot job, then starts the server. Open `http://localhost:2567/healthz` for liveness and `http://localhost:2567/readyz` for storage readiness and LiveKit status. Application readiness is separate from media availability. The server binds to `0.0.0.0:2567`; LiveKit signaling is exposed on `ws://localhost:7880`.

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

SQLite lives at `/data/office.sqlite` in the Compose volume and at the configured path for local Node runs. Back up the database before moving it to another host; images do not contain application data. Run one server replica while office state is in memory and SQLite is the application store. Compose currently includes the server, migration and volume initialization jobs, and LiveKit; there is no worker container yet.

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

After building/starting the server, open [the media harness](http://localhost:2567/media-harness/) in three independent browser contexts, create a distinct guest in each, and explicitly enable microphones. Microphones start off. Use headphones, focus the map, and move with WASD/arrows. The harness bundles its pinned Colyseus and LiveKit SDKs locally; no CDN is required. It supports mute, deafen, playback resume, microphone republishing, and manual connection retry. Browser permission denial preserves listening and movement. Meeting-zone shading is only a map preview in M2: private meeting audio starts with M3.

`POST /api/media/token` requires the guest bearer token and strict JSON `{ "sessionId": "COLYSEUS_SESSION_ID" }`. The session must be a currently connected office seat owned by that guest. The response is `{ url, token, mediaIdentity, roomName, expiresAt }`, where `expiresAt` is an ISO UTC timestamp. Clients cannot choose identities, rooms, zones, or grants. Credentials last 60 seconds for admission, permit microphone publication and subscription, and prohibit camera/screen/data publication. LiveKit uses an opaque floor room per office instance and an opaque participant identity per connection; identities are refreshed after a Colyseus reconnect. Do not log or persist media tokens.

Room clients send `media.preferences` with `{ muted: boolean, deafened: boolean }`. These preferences start muted and stay private. The server sends each listener a private `audio.policy` message at 5 Hz with `{ revision, speakers: [{ mediaIdentity, distance, gain }] }`. Revisions increase for the lifetime of the office. Distances are tiles: gain is 1 through 2 tiles and fades linearly to 0 at 6. Speakers enter the subscription list at distance ≤6 and remain through distance ≤7, with zero gain beyond 6. Hearing is computed independently for each listener; nearby people do not relay each other's conversations. Disconnected, muted, and non-floor speakers are excluded; deafened listeners receive an empty list.

The browser connects to LiveKit once per office connection with automatic subscription disabled. It reconciles microphone publications from policy, smooths playback gain, and handles republished tracks. Moving across a proximity boundary changes subscriptions and volume without reconnecting LiveKit. On an office/media drop, the harness stops media and requires manual retry; production clients may use the SDK reconnect reservation, then request fresh media credentials. The server invalidates the binding immediately on office drop/leave, removes the old media participant, and cleans up floor rooms on disposal. Cleanup failures are logged without taking down office storage readiness.

`POST /api/livekit/webhook` accepts `application/webhook+json` up to 64 KiB, verifies the exact raw-body signature with the configured LiveKit key, deduplicates verified event IDs, and ignores delayed participant events for older SIDs. Media events never create office membership. Old or unbound identities observed joining/publishing are evicted. Compose enables signed callbacks to `http://server:2567/api/livekit/webhook`; update `deploy/livekit.yaml` if changing the application's port or running Node outside Compose (for Docker Desktop, use a reachable host callback such as `http://host.docker.internal:2567/api/livekit/webhook`). `LIVEKIT_WEBHOOK_API_KEY` in Compose follows `LIVEKIT_API_KEY`.

Public-floor proximity controls the listening experience; it is not a confidentiality boundary. A modified client with subscription permission can receive other floor tracks. Self-hosted LiveKit does not revoke previously issued tokens when removing a participant, so short-lived floor credentials can be replayed until expiry; webhook eviction is best effort. M3 must isolate meetings and rotate media-room epochs before claiming private audio or immediate revocation.

The [M2 verification guide](docs/M2_MEDIA_CHECK.md) covers three-person listening, independent distances, hysteresis, microphone denial, mute/deafen, republishing, and disconnects. Automated service/room tests verify token grants and signatures, forged claims, disconnect/reconnect binding changes, private policies, exact webhook signatures, delayed events, and cleanup. Physical microphones and separate-device/network connectivity still require the manual guide.

For automated Chromium/WebRTC verification with synthetic microphones against a running stack:

```sh
npx playwright install chromium
npm run smoke:media
```

This opens three isolated browser contexts, exercises movement and media subscriptions, and checks inbound audio packets/energy. CI runs it after the Compose and SDK smoke checks. It does not establish human audibility or separate-device/network connectivity.

Validated on October 23, 2026: all 95 tests, TypeScript checks, the production build, Docker Compose startup/health, the SDK movement smoke, and the three-context synthetic WebRTC media smoke passed. Physical microphones, permission prompts/denial, and separate-device/network audio still require the manual M2 guide.
