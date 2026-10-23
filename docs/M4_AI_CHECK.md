# M4 AI notes verification

This guide covers the opt-in AI notes flow in `/media-harness/`. A request never starts capture by itself. The server must receive explicit consent from every current meeting occupant before the worker subscribes to audio. The controls and statuses are verification UI, not a product frontend.

## Configure and start

1. Copy `.env.example` to `.env` if needed. Keep `AI_ENABLED=false` until the worker is configured.
2. To enable notes, set `AI_ENABLED=true`. Replace `AI_WORKER_SECRET` with a random value of at least 32 characters. Use the same value for the server and worker, and keep it distinct from `SESSION_SECRET` and `LIVEKIT_API_SECRET`.
3. Set `OPENAI_API_KEY` in the worker environment, or configure a compatible provider with `AI_PROVIDER_BASE_URL`, `AI_TRANSCRIPTION_MODEL`, and `AI_SUMMARY_MODEL`. The provider must support the configured transcription endpoint and structured JSON-schema summaries. Provider credentials stay in the worker environment.
4. Optionally adjust `AI_CHUNK_SECONDS` (1–20, default 10), `AI_PROVIDER_TIMEOUT_MS` (default 30 seconds), and the server limits `AI_MAX_DURATION_SECONDS` (default 600 seconds), `AI_MAX_TRANSCRIPT_CHARS` (default 100,000), and `AI_MAX_CONCURRENT_SESSIONS` (default 2).
5. Start the application, LiveKit, and worker:

   ```sh
   docker compose --profile ai up --build
   ```

   Compose gives the worker the internal `AI_SERVER_URL` and waits for the server health check. Without `AI_ENABLED=true` or a valid provider key, notes cannot run. The ordinary `docker compose up --build` leaves the worker stopped and AI disabled. When AI is enabled, `/readyz` reports `dependencies.ai` as `disabled`, `up`, or `down`; `up` only means the server saw an authenticated worker request within 10 seconds.

## Two-person consent and notes

Use two independent browser profiles or devices, and follow [M3 media verification](M3_MEDIA_CHECK.md) to enter the same private meeting. Keep the test focused on meeting audio; do not use the public floor. Use ordinary spoken test content and headphones.

| Check | Procedure | Expected result |
| --- | --- | --- |
| Request | One occupant selects **Request AI notes**. | Status becomes `requesting_consent`; no capture starts yet. The request uses a UUID and repeated requests for the active meeting resolve to its existing session. |
| Unanimous consent | Each occupant selects **I consent for this roster**. Before the last consent, no audio is captured. | Only after every listed occupant consents does status become `capturing`. The private roster shows each occupant's current decision. |
| Stop and finalize | Both occupants speak for at least 15 seconds. Watch the capturing status until it shows at least **1 speech excerpt transcribed**, then one selects **Stop and finalize**. Allow extra time for provider latency. | New capture stops. The worker summarizes only transcript segments already committed to the server. A `notes.ready` event is sent to authorized readers when the draft completes. If no segment was committed, status fails with `NO_TRANSCRIPT` and no note is created. |
| Read the draft | Both occupants refresh notes and open the draft. | Each authorized guest can retrieve the draft. It is marked partial and contains summary, decisions, and action items with source segment IDs; uncertain owners and dates are unset. |
| Third-party access | A third guest joins the same office after the draft is saved, then requests the note through the harness or `GET /api/notes/:id` with that guest's bearer token. | The third guest does not see the note in `GET /api/notes`; direct retrieval returns not found. Room membership alone does not grant access to old notes. |

`GET /api/notes` returns only drafts whose readership snapshot contains the authenticated guest. `GET /api/notes/:id` applies the same check. Both routes require a guest bearer token. A later occupant does not inherit access to an earlier draft.

## Roster change, decline, and withdrawal

Test these with a fresh meeting session so an earlier finalized note does not affect the result.

| Check | Procedure | Expected result |
| --- | --- | --- |
| Decline | Request notes; have one occupant select **Decline for this roster**. | The request is canceled and capture never begins. The human meeting audio continues. |
| New entrant | Start a new request and get both current occupants to consent. While status is `capturing`, have a third guest enter the meeting. | Capture pauses before the new occupant is admitted to the meeting media epoch. The previous roster's transcript context is cleared; the status shows a new revision and all occupants must decide again. The worker is removed and the room epoch rotates when capture was active. |
| Withdrawal | Start capture with a fully consenting roster; have one consenting user select **Withdraw my consent**. | The active job and lease are invalidated, the assistant is removed, and stored transcript segments are deleted. Audio already buffered in the worker is discarded as cancellation propagates; pending provider work is aborted. No draft from that canceled session should be saved. |
| Late result | If feasible, delay a provider response, then withdraw or change the roster before it returns. | A result for the stale revision/lease is rejected and cannot create a note or notify readers. |
| Stop while waiting | Request notes but do not get unanimous consent; select **Stop and finalize**. | The request is canceled. There is no transcript to summarize and no note is created. |

Stopping during capture is different from withdrawal: it ends capture and finalizes the authorized, already-committed transcript for summarization. Declining or withdrawing cancels the session and deletes its pending transcript instead. If no transcript segment was committed before stop, the server reports a failure and no note is created.

Every saved note is currently marked `partial`. Stop and meeting exit abort the worker and discard any unfinished in-memory PCM chunk or in-flight transcription rather than waiting for that tail to finish. Audio is transcribed in 10-second chunks by default; speak for at least 15 seconds and wait until the capturing status shows at least one speech excerpt transcribed before stopping. Leave additional time for provider latency. This is a known M4 limitation, not evidence that the notes contain a complete transcript.

## Failure and privacy checks

- Stop or withdraw while the provider is working. Verify the worker stops on lease cancellation and no late note is stored.
- Interrupt LiveKit during capture. The worker fails closed; reconnecting requires a new consented capture.
- Use an invalid/slow provider configuration. Confirm provider calls time out, failures are surfaced in `ai.status`, and the office and meeting audio remain usable.
- Confirm server and worker logs do not contain API credentials, media tokens, raw audio, or transcript text.
- Check an action item with uncertain owner/date. The structured draft should leave those fields null; each note claim should reference source `segmentIds`.

The session-duration limit starts when notes are first requested, so initial consent and any re-consent time count against the same budget as capture. The server renews 15-second job leases while a worker heartbeats every 2 seconds. A capture that is not claimed/attached within 15 seconds fails; processing is canceled after 120 seconds. Each summary job attempt makes at most two provider calls (one in-worker retry), and a failed or expired summary job gets at most two durable attempts, for up to four provider calls total. Provider calls have configured timeouts and provider responses are capped at 1 MB. Capture duration, transcript size, and concurrent sessions are bounded. Raw audio is processed in memory and not written to disk; completed/canceled sessions clear their transcript segments. The worker subscribes only to the authorized meeting microphones and never publishes audio.

## Evidence record

- Date / commit / deployment:
- Provider and model configuration (never record secrets):
- Devices and browser profiles used:
- Two-user consent, capture, stop, and note retrieval:
- Third-user list and direct-read result:
- Decline, withdrawal, roster change, and delayed-result observations:
- Provider timeout or media interruption result:
- Issues and follow-up:

## Status

The current automated suite (161 tests), production build, synthetic browser media smoke, and worker PCM/native-image checks passed. These checks do not exercise credentialed provider transcription or summary generation, or establish human audibility and end-to-end consent behavior on separate devices. Those real-provider and real-device checks are still pending; record the evidence above before marking the M4 manual acceptance check complete. No live-provider verification is claimed.
