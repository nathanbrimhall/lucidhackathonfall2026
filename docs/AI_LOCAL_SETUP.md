# AI local setup and baseline

## Verified in this pass

- Windows production build fixed using fileURLToPath in scripts/build-media-harness.mjs; npm run build passes from a directory containing spaces.
- Native LiveKit RTC module loads successfully on this Windows host.
- Local Node server starts with SQLite and responds to health/readiness checks.
- SDK smoke passes with two guest identities, shared presence, authoritative movement and rejected coordinate injection.
- Office AI capture remains disabled. A Gemini key is now configured for the independent transcript demo; see AI_TRANSCRIPT_DEMO.md for current live verification.
- Docker Desktop startup was attempted, but its engine remains unavailable. Real LiveKit transport and human speech acceptance are not verified.

## Local Node workflow

From the repository root:

```powershell
node scripts/setup-local.mjs
npm.cmd run build
npm.cmd start
```

The setup command creates a git-ignored .env only if it does not already exist. It generates distinct secrets and a guest invite code without printing them. The file selects local Node URLs and ./data/office.sqlite. Open http://localhost:2567/media-harness/ and read GUEST_INVITE_CODE from your private .env file when joining. Do not put it into screenshots or commits.

Check setup without calling a paid provider:

```powershell
node scripts/check-ai-setup.mjs
```

It prints booleans and next steps, never credentials. The worker heartbeat check is not proof that a provider call succeeds. The signaling check is not proof of microphone/WebRTC connectivity.

## Remaining live prerequisites

1. Start a working LiveKit server. If using Docker Compose for LiveKit alone, docker compose up -d livekit reads the configured media key and secret from .env.
2. Configure AI_PROVIDER=gemini and GEMINI_API_KEY in .env, with both models set to gemini-3.5-flash-lite and the native Google base URL. The transcript demo runs independently with npm run ai:demo and does not need LiveKit or AI_ENABLED=true.
3. Set AI_ENABLED=true only after the credential and media server are ready. Restart the application server so it reloads .env.
4. In a second terminal run npm.cmd run worker:dev. The local setup already points AI_SERVER_URL to http://localhost:2567.
5. Follow M4_AI_CHECK.md with two consenting human speakers. Test notes, readability, withdrawal and roster changes. Capture only synthetic or approved test speech.

No keys should be pasted into chat, saved in test fixtures or included in git. No encrypted credential store is implemented; this is the previously agreed local prototype configuration.

## Compose versus local Node

The generated .env targets host Node processes. Before running the full server + worker Compose stack, set LIVEKIT_INTERNAL_URL=http://livekit:7880 for server-to-container media access. Compose already overrides its database path and the worker's internal application URL. Do not run the host server and container server on port 2567 simultaneously. The earlier .env.example remains a Compose-oriented template.

## Windows test workaround

The sandbox's default temporary directory caused Vitest rename permission errors. These per-process settings let the tests run without modifying application code:

```powershell
$env:TEMP = 'C:\Users\natha\AppData\Local\Temp\lucid-vitest'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
npm.cmd run typecheck
npm.cmd test
```

For dependency installation on this host, a writable explicit cache worked:

```powershell
npm.cmd ci --no-audit --no-fund --cache 'C:\Users\natha\AppData\Local\Temp\lucid-npm-cache'
```

## Next design direction

Nathan selected the existing compatible AI provider for initial testing, built-in follow-up review as the initial destination, and confirmed Slack is an acceptable messaging destination. Slack integration is not implemented by these setup changes. Keep extraction/review independent from any Teams/Slack delivery adapter.

Gemini provider: set AI_PROVIDER=gemini, GEMINI_API_KEY, AI_PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta, and both AI_TRANSCRIPTION_MODEL and AI_SUMMARY_MODEL to gemini-3.5-flash-lite. Both audio and notes use Google; the worker never falls back to OpenAI. Credentials remain local. Quota errors stop the request without automatic retry. Free-tier eligibility and billing are controlled by the Google project, not the API key or this code. Free-tier data may be used by Google to improve products: use fictional conversations for this demo.
