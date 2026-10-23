# Lucid Virtual Office

A virtual office where people can walk up to conversations, with AI notes and reminders planned for later milestones. M0 provides guest sessions, an authenticated Colyseus seat reservation, health endpoints, and SQLite persistence. Presence and movement arrive in M1; the AI worker is deferred until M4.

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

`npm run dev` starts the TypeScript server for development. `npm test` runs the tests. `npm run smoke` runs the SDK smoke client and requires a running server. The local Node path does not start LiveKit; use Compose or run LiveKit separately.

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

The server disables Colyseus's public matchmaking endpoints. Clients must use the authenticated application join route above; do not call `joinOrCreate` directly. M0 validates the session, reserves the seat, and emits `session.ready`. It does not yet synchronize player presence or movement. Application HTTP errors use `{ "error": { "code": "...", "message": "..." } }`.

## Runtime and shared access

The checked-in URLs are for local development. For browser access from other devices, set `PUBLIC_SERVER_URL`, `ALLOWED_ORIGINS`, and `LIVEKIT_PUBLIC_URL` to externally reachable addresses and use HTTPS/WSS with a trusted certificate. Other devices cannot use `localhost` to reach the host. The sample maps LiveKit signaling TCP `7880`, ICE/TCP `7881`, and single-port ICE/UDP `7882`; a signaling proxy alone does not carry WebRTC media. Configure reachable advertised addresses, firewall/router forwarding, and TURN for the deployment network as needed.

SQLite lives at `/data/office.sqlite` in the Compose volume and at the configured path for local Node runs. Back up the database before moving it to another host; images do not contain application data. Run one server replica while office state is in memory and SQLite is the application store. Compose currently includes the server, migration and volume initialization jobs, and LiveKit; there is no worker container in M0.

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
