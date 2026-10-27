# Lucid Virtual Office

Lucid is a pixel-art virtual office where remote teammates can see each other, walk around, and talk the way they would in a real room. Walk up to someone on the open floor and you hear them, with volume fading as you move away. Step into a meeting room and the conversation becomes private. With everyone's consent, an AI assistant can take meeting notes, turn them into reviewed tasks and messages, and answer questions about what the team has decided.

## Features

- **Shared office.** Up to 20 people move around a 2D office in real time. The server is authoritative, so walls, furniture and doorways behave the same for everyone.
- **Proximity audio.** On the open floor you hear people within about six tiles, louder the closer you are. Mute and deafen are always available, and microphones start off.
- **Private meeting rooms.** Walking into a meeting room automatically moves your audio into that room. People outside can't hear in, and people inside can't hear the floor.
- **Consent-based AI meeting notes.** Anyone in a meeting can request notes, but recording only starts once every person in the room has agreed. If someone joins, leaves or withdraws, capture pauses until the new group consents. Audio is processed in memory and never saved.
- **Reviewed tasks and messages.** Notes produce *drafts* only. You decide what becomes a shared task (which the assignee must accept) or a desk-note message (which must be approved and then sent explicitly).
- **Personal reminders.** Create reminders for yourself, including from a meeting action item. They're delivered when due, and you'll catch up on any you missed while offline.
- **AI assistant.** Ask about notes, tasks and teammates' shared skills you already have access to. It can:
  - find relevant conversations
  - suggest who could help
  - spot tasks that block each other (dependency radar)
  - flag duplicate work
  - separate confirmed decisions from assumptions
  - write daily and catch-up briefs
  - prepare meeting questions

  Every answer cites its sources, and nothing changes until you confirm it.
- **Presence.** Set yourself to Available, Away or Do Not Disturb, share a short focus/skills line, and choose whether new messages should interrupt you.

Teams/Slack delivery, video calls and audio playback are not part of this project. Messages are delivered inside the office.

## Quick start: the fictional demo

The quickest way to explore Lucid is the demo mode, which starts with fictional people, notes and tasks already loaded. You need **Node.js 24** (see `.nvmrc`).

```bash
npm ci
```

```bash
npm run setup:local
```

```bash
npm run office:demo
```

Open **http://localhost:2568/** in three separate browser windows or profiles. Choose **Use Demo Nathan**, **Use Demo Cameron** and **Use Demo Maya**, one in each.

- Move with **WASD** or the arrow keys (click the map first), or click anywhere on the floor to walk there.
- Use the side panels for People, Notes, Tasks, Desk notes, Reminders and the Assistant.
- The demo keeps its data in memory, so restarting it resets everything. Your normal office database is never touched.
- Audio capture is turned off in demo mode, and you don't need LiveKit for the data and UI features.

**Using the assistant in the demo.** The assistant uses Google Gemini. Add your key to `.env`:

```dotenv
GEMINI_API_KEY=your-key
```

`setup:local` has already set `AI_PROVIDER=gemini` and generated an `AI_WORKER_SECRET`. A model request is only sent when you click **Ask assistant**. Typing a question or choosing a quick action doesn't send anything. The quota meter tracks this app's own usage. If Google returns a quota error, asking pauses until you run:

```bash
npm run ai:usage -- --clear-pause
```

That clears the local pause only. It doesn't reset Google's quota.

For a guided tour of every feature, including all eight assistant actions, see the [integrated demo checklist](docs/INTEGRATED_DEMO_CHECKLIST.md).

## Running the real office

### Locally with Node.js

```bash
npm run office:dev
```

This starts the persistent office at **http://localhost:2567/**. Sign in with a display name and the `GUEST_INVITE_CODE` from your `.env`. Sessions last seven days.

Some features need extra setup:

- **Voice** needs a [LiveKit](https://livekit.io/) server. The Docker setup below includes one. If you run LiveKit yourself, set `LIVEKIT_INTERNAL_URL`, `LIVEKIT_PUBLIC_URL` and its API key and secret.
- **AI meeting notes** need `AI_ENABLED=true`, a provider key, and the AI worker. Start the server and worker together with:

  ```bash
  npm run office:dev -- --worker
  ```

You can also run the steps one at a time:

```bash
npm run build
```

```bash
npm run migrate
```

```bash
npm start
```

### With Docker Compose

Docker Compose runs the app, the SQLite volume, database migrations and a self-hosted LiveKit server together.

```bash
cp .env.example .env
```

Before anyone else connects, change `SESSION_SECRET`, `GUEST_INVITE_CODE` and `LIVEKIT_API_SECRET` in `.env`. Then start it:

```bash
docker compose up --build
```

To add AI meeting notes, set these in `.env`:

- `AI_ENABLED=true`
- `AI_WORKER_SECRET`: a random value of at least 32 characters, different from your other secrets
- `GEMINI_API_KEY`: your provider key

Then start Compose with the `ai` profile:

```bash
docker compose --profile ai up --build
```

Your data lives in the `office-data` volume and is kept across rebuilds. To wipe it:

```bash
docker compose down && docker volume rm lucidhackathonfall2026_office-data
```

Two endpoints show the server's state: `/healthz` reports liveness, and `/readyz` reports database, media and AI-worker status.

### Sharing with other devices

Other machines can't reach your computer through `localhost`. To let them connect:

- Set `PUBLIC_SERVER_URL`, `ALLOWED_ORIGINS` and `LIVEKIT_PUBLIC_URL` to addresses they can reach.
- Serve the office over HTTPS/WSS with a trusted certificate.
- Open LiveKit's ports: TCP 7880 for signaling, TCP 7881 and UDP 7882 for media. Add a TURN server if the network needs one.
- Run only one server replica, because the live office state is held in memory.

Backups, restores and deploying from registry images are covered in the [operations runbook](docs/M5_REMINDERS_CHECK.md).

## Configuration

All settings live in `.env`. `.env.example` lists every setting with comments, and `npm run setup:local` writes a ready-to-use local version. The main ones:

| Variable | Purpose |
| --- | --- |
| `PORT`, `PUBLIC_SERVER_URL`, `ALLOWED_ORIGINS` | Where the office is served and which origins may connect |
| `SESSION_SECRET`, `GUEST_INVITE_CODE` | Signs guest sessions; the code people use to join |
| `DATABASE_URL` | Path to the SQLite database |
| `OFFICE_LAYOUT` | `prototype` (the default pixel-art map) or the legacy test map |
| `LIVEKIT_*` | LiveKit addresses and API credentials |
| `AI_ENABLED`, `AI_WORKER_SECRET` | Turns on AI meeting notes; shared secret between server and worker |
| `AI_PROVIDER`, `GEMINI_API_KEY` | AI provider (`.env.example` selects `gemini`; OpenAI-compatible APIs are also supported, see the [worker README](worker/README.md)) |
| `AI_TRANSCRIPTION_MODEL`, `AI_SUMMARY_MODEL` | Models used for transcription and note writing |
| `AI_TIMEZONE` | Timezone used to interpret spoken deadlines such as "by Friday" |
| `AI_LOCAL_DAILY_REQUEST_LIMIT` | This app's own daily cap on AI requests |

To check your AI setup without calling the provider, run `node scripts/check-ai-setup.mjs`.

## Standalone AI transcript lab

```bash
npm run ai:demo
```

This opens a separate playground at **http://127.0.0.1:8788/**. It isn't connected to the office. You can paste or edit fictional meeting transcripts and see the task drafts, message drafts and assistant analysis the AI produces, with accuracy, latency and token metrics. Each feature can run against an offline reference answer, so you can try it without using any Gemini quota.

`npm run ai:eval` scores the extraction against built-in fixtures. Add `-- --live --all` to score live Gemini output. See [AI transcript demo](docs/AI_TRANSCRIPT_DEMO.md), [AI panel](docs/AI_PANEL.md) and [knowledge tools](docs/AI_KNOWLEDGE_TOOLS.md).

## Privacy model

- Proximity audio on the open floor makes conversations feel natural, but it doesn't make them confidential. A modified client could listen in on any floor conversation.
- Meeting rooms are isolated. Media credentials expire after 60 seconds and are issued for one room only. When someone leaves a meeting, the people still inside move to a fresh media room, so an old credential can't reach the current meeting.
- AI capture requires consent from everyone in the room. Only people who were present and consented can read the resulting notes.
- The assistant only sees what the person asking can already see. Changing the brief detail level changes what's relevant, not what's accessible.
- Provider keys stay on the server and worker, never in the browser. Raw audio is never written to disk, and transcripts are deleted once the notes are finished.

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Server with hot reload (run `npm run build` once first for browser bundles) |
| `npm run typecheck` | TypeScript checks |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run office:verify` | Typecheck, build, all tests and browser checks, with external network blocked |
| `npm run smoke` | Multiplayer check against a running server, using the Colyseus SDK |
| `npm run smoke:media` | Proximity and meeting audio check with synthetic microphones in Chromium (needs `npx playwright install chromium` and a running stack) |
| `npm run smoke:reminders` | Reminder delivery and offline catch-up check |
| `npm run office:live-check` | A short, quota-limited check against live Gemini using fictional data |

GitHub Actions runs the typecheck, tests, build, Docker Compose startup and all smoke checks on every push and pull request.

### Project layout

```
frontend/   Browser client: office renderer, panels, Colyseus and LiveKit wiring
server/     Colyseus and Express server: auth, rooms, media, notes, tasks, reminders, assistant
shared/     Protocol types, validation, map and collision logic used by server and client
worker/     AI worker: joins meeting audio, transcribes, drafts notes
tools/      Demo servers, AI lab and evaluation, smoke tests, the media test harness
scripts/    Build, setup and verification helpers
deploy/     LiveKit configuration and Compose files for CI and registry images
docs/       Guides, checklists and design notes
```

### Built with

- [Colyseus](https://docs.colyseus.io/) 0.18 for real-time rooms and state sync
- [LiveKit](https://docs.livekit.io/) for WebRTC audio
- Express 5
- SQLite (`better-sqlite3`)
- Zod
- TypeScript
- esbuild
- Vitest and Playwright for testing

To write your own client or integrate with the server, see the [client protocol](docs/PROTOCOL.md): sessions, joining, movement, audio and meeting transitions, AI notes, reminders and the collaboration API.

For a lower-level way to test audio, open `/media-harness/` on a running server. It's a debug client for proximity audio, meetings and AI-notes consent. The [M2](docs/M2_MEDIA_CHECK.md), [M3](docs/M3_MEDIA_CHECK.md) and [M4](docs/M4_AI_CHECK.md) guides walk through manual audio checks with real microphones.
