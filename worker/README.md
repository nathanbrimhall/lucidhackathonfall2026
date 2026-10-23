# AI worker

This independent TypeScript process claims leased jobs from the application's bearer-authenticated internal API. A capture job joins only its specified isolated LiveKit room, publishes nothing, and subscribes only to the supplied consenting identities' microphone tracks. Each speaker is transcribed separately with segment IDs and session-relative millisecond timestamps.

Copy `.env.example` to `.env`, set `AI_ENABLED=true`, a separate random `AI_WORKER_SECRET` of at least 32 characters, and `OPENAI_API_KEY`. Run `docker compose --profile ai up --build`. The worker has no persistent volume and needs no microphone hardware or GPU. For local development, set `AI_SERVER_URL=http://localhost:2567` and run `npm run worker:dev` alongside the application and LiveKit. The application supplies the internal media URL in capture jobs; browser media URLs must not be used inside Compose.

`AI_PROVIDER_BASE_URL` selects an OpenAI-compatible HTTP API; `AI_TRANSCRIPTION_MODEL` and `AI_SUMMARY_MODEL` configure models independently. The defaults are `gpt-4o-mini-transcribe` and `gpt-4o-mini`. The provider must implement multipart `/audio/transcriptions` and strict JSON Schema `/chat/completions`. Provider credentials remain in the worker environment. References: [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

The worker holds PCM16 mono 16 kHz audio in memory in bounded 10-second chunks (configurable 1–20 seconds); it never writes raw audio to disk. Incomplete chunks are discarded on stop, roster change, failure, or shutdown. Only finalized authorized segments reach the application. A full chunk may be processing while one next chunk fills per speaker; if processing falls behind, capture fails closed rather than building an audio queue. At most one microphone per allowed identity is processed. One worker handles one active job; run additional replicas for concurrent sessions.

Heartbeats run every 2 seconds. Authorization is checked again before every chunk is sent to the provider and before each finalized segment or draft is submitted. Revocation aborts media readers, disconnects the room, and aborts pending HTTP calls; the application's revision and lease checks reject late results. A native RTC connection handshake has no cancellation API; an already pending handshake is allowed to finish with automatic subscription disabled and is immediately disconnected after cancellation. Media reconnection fails closed. Capture duration, transcript characters, chunk size, provider response size, provider timeouts, and summary output tokens are bounded. Each summary job attempt makes at most two provider calls; the application allows two durable job attempts, for at most four calls. Invalid output, invented segment IDs, non-reader owners, refusals, and truncated model responses fail validation. Suggested due dates remain null unless an absolute timestamp is unambiguous.

No provider request bodies, transcripts, audio, or credentials are logged. Transcripts live on the application only for its processing window; worker memory is released after each job. Notes are drafts; the worker never creates reminders or invokes model-generated tools. Stopped/cancelled capture is not resumed or silently retried with the old consent revision. Application lease expiry handles worker loss.

`npm test -- worker/test` checks capture allowlisting, cancellation, bounded audio handling, authorization before chunks, provider validation, real HTTP request formatting with mocked transport, and timeouts. `npm run smoke:ai-media` sends synthetic PCM through a real self-hosted LiveKit microphone track and asserts a decoded speaker-labelled WAV chunk. Run this against an isolated LiveKit without the application's webhook: the application correctly evicts identities it did not authorize. Select that instance with `AI_SMOKE_LIVEKIT_URL`, `AI_SMOKE_API_KEY`, and `AI_SMOKE_API_SECRET`; CI starts a separate instance for this check. Real credentialed transcription and a human two-speaker live conversation must still be verified in the deployment environment; transport tests do not establish that live acceptance criterion.

For a local synthetic transport check, start an isolated instance with the same published/advertised media ports (test secrets only):

```sh
docker run -d --rm --name lucid-ai-smoke \
  -p 17880:17880/tcp -p 17881:17881/tcp -p 17882:17882/udp \
  livekit/livekit-server:v1.13.10 --config-body '
port: 17880
rtc:
  tcp_port: 17881
  udp_port: 17882
  node_ip: 127.0.0.1
  use_external_ip: false
keys:
  devkey: test-only-ai-smoke-secret-at-least-32-characters
logging:
  level: warn'
AI_SMOKE_LIVEKIT_URL=ws://127.0.0.1:17880 \
AI_SMOKE_API_KEY=devkey \
AI_SMOKE_API_SECRET=test-only-ai-smoke-secret-at-least-32-characters \
npm run smoke:ai-media
docker rm -f lucid-ai-smoke
```
