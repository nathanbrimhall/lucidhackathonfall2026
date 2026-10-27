# AI conversation demo and evaluation

## Run the app

From the repository folder, run `npm run ai:demo`, then open http://127.0.0.1:8788/.
Alternatively, double-click `scripts/start-ai-demo.cmd` on Windows.
Node 24 and `npm ci` are required for a fresh checkout. `npm run setup:local` creates a local configuration without overwriting an existing `.env`.

The transcript demo runs independently of the office server, Docker, microphone, and LiveKit. It does not require `AI_ENABLED=true`. Offline replay works without an API key. For real extraction choose **Live Gemini**. Edit the transcript/context JSON to try your own fictional input; edited input is not scored against the original fixture's labels. Restart the demo after changing `.env` or server source files.

The app displays evidence-backed action drafts, owners, deadlines, summary/decisions, latency, token usage, and estimated free-tier cost. It does not send messages or create external tasks. The full office remains at `/media-harness/` on port 2567 and still needs LiveKit for microphone/audio features.

## Gemini-only configuration

Keep `GEMINI_API_KEY` in `.env` (never source control or browser JavaScript), with:

```dotenv
AI_PROVIDER=gemini
AI_PROVIDER_BASE_URL=https://generativelanguage.googleapis.com/v1beta
AI_TRANSCRIPTION_MODEL=gemini-3.5-flash-lite
AI_SUMMARY_MODEL=gemini-3.6-flash
AI_TIMEZONE=America/Denver
AI_GEMINI_OUTPUT_MODE=json
```

Google rejected Gemini 2.5 Flash for this new account. Gemini 3.8 Flash structured requests returned errors/timeouts during testing. The earlier verified default was Gemini 3.5 Flash-Lite in JSON mode. Nathan subsequently selected the fuller Gemini Flash model: the current summary/extraction default is Gemini 3.6 Flash, with the same prompt and JSON validation. Historical Flash-Lite results below do not establish Flash accuracy. It is listed as free-tier eligible in Google's pricing documentation. The worker uses Google's native REST API. The complete Zod validation still runs locally after the provider responds. AI_GEMINI_OUTPUT_MODE=json uses JSON mode with the schema in the system prompt; schema mode optionally requests native constrained output. Both validate responses locally. Native schema mode is covered by mocks but has not passed live acceptance on this account. The report records which mode was used.

No OpenAI fallback is used in this demo. A quota error stops the request and the suite; the office worker also does not automatically requeue a quota-failed job. The demo serializes live requests, waits at least 15 seconds between starts, imposes a 10-request session cap, and blocks further requests for at least 60 seconds after a 429. These are local safeguards, not claims about your actual Google quota. The CLI stops at the first failed live request. There are no automatic model changes or upgrades to a paid service.

`estimatedUsd: 0` is based on your stated free tier; this app cannot verify your Google billing configuration. Actual provider-reported tokens are recorded when supplied; missing usage is explicitly counted. Free-tier content may be used by Google for product improvement; use fictional conversations here.

## Repeatable evaluation

```powershell
npm run ai:eval                              # All offline reference fixtures; no provider calls
npm run ai:eval -- --live                    # One live Gemini case
npm run ai:eval -- --live --case corrections # One specific case
npm run ai:eval -- --live --case commitments --repeat 3
npm run ai:eval -- --live --all              # Seven live cases, spaced 15 seconds apart
```

Reports are saved in `data/ai-eval/` (ignored by Git). Reports contain notes, case IDs, prompt version, input SHA-256, model, timestamps, latency, tokens, estimated cost, per-case errors, and scores. Repeated runs share the same input hash and prompt version but live inference is not guaranteed bit-for-bit deterministic, even at temperature zero. No raw provider error bodies or credentials are logged. Failed runs are counted as failures, not assigned fabricated accuracy scores. Nonzero exit means a provider failure or at least one labeled action/owner/deadline mismatch.

Fixtures cover explicit commitments, tentative ideas/unaccepted requests, completed work, corrections/reassignment/cancellation, relative and vague deadlines, daylight-saving time, irrelevant break-room chat, ambiguous ownership, and quoted prompt injection. Each fixture uses the existing `AiSummaryJob` / `AiDraftNotes` contracts. The application now supplies a participant snapshot and recording start time to actual office summary jobs, too. The office timezone is configured with `AI_TIMEZONE`; legacy jobs without context remain readable and get conservative deadline rules.

Scores use fixture-specific concept terms plus evidence IDs, matched one-to-one. They report missed actions, extra/invented actions (including duplicates), owner errors, deadline errors, precision, and recall. This heuristic can flag a valid paraphrase as a mismatch and cannot prove an extracted claim is true. Inspect the saved draft/evidence when a score fails. Summary/decision prose is not automatically graded. Offline replay validates the runner/scorer and shows a reference response; it is **not** a model-quality evaluation.

## Tests

`npm run typecheck`, `npm test -- --maxWorkers=2`, and `npm run build` validate the implementation. Provider tests use fake HTTP responses and cover malformed JSON/schema, invented evidence, unauthorized owners, prompt placement/injection boundaries, truncation, safety blocks, oversized bodies, quota/auth/server failures, network errors, request timeout, stalled-body timeout, and cancellation. HTTP tests cover replay without credentials, bad payloads, and cross-origin protection. These mocked tests supplement the live fixture evaluation.

On Windows, if Vitest or the browser encounters sandbox temporary-directory rename errors:

```powershell
$env:TEMP = 'C:\Users\natha\AppData\Local\Temp\lucid-vitest'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
npm test -- --maxWorkers=2
```

Optional browser smoke: `node tools/ai-demo/browser-smoke.mjs` while the demo is running. It uses a local Chromium-based browser, makes no live provider calls, verifies two commitment cards and zero tentative actions, and checks JavaScript errors.

## Modules

- `shared/src/ai-worker.ts`: existing job/note contracts, plus validated extraction context.
- `worker/src/extraction-prompt.ts`: shared versioned extraction rules and input formatting.
- `worker/src/gemini-schema.ts`: Google-compatible projection of the existing notes schema.
- `worker/src/providers.ts`: bounded requests, native Gemini adapter, response validation, usage reporting.
- `tools/ai-eval/fixtures.ts`, `scoring.ts`, `runner.ts`, `cli.ts`: labels, transparent scoring, execution, reports.
- `tools/ai-demo/`: local transcript review application.

Sources: https://ai.google.dev/gemini-api/docs/pricing, https://ai.google.dev/gemini-api/docs/generate-content/structured-output, https://ai.google.dev/gemini-api/docs/rate-limits.

## Current verification results

- Full automated suite: 214 tests passed across 24 files. After selecting the final Gemini defaults and prompt v3, all 52 worker tests passed again. Typecheck and production build passed.
- Chrome browser smoke passed for two commitment cards, zero tentative-action cards, and no JavaScript errors (offline replay).
- Live `meeting-actions-v2` baseline: seven completed cases, one missed unassigned team action, no invented actions, owner errors, or deadline errors. Report: `data/ai-eval/live-1792894193718.json`.
- Live `meeting-actions-v3`, Gemini 3.5 Flash-Lite / JSON mode: seven completed cases; zero missed actions, invented actions, ownership errors, or deadline errors. Average latency 4,602 ms, p95 5,890 ms. Provider reported 4,932 input tokens and 1,189 output tokens (6,121 total). Estimated free-tier cost: $0. Report: `data/ai-eval/live-1792894342191.json`.
- These are small fixture-suite results, not a guarantee of correctness on arbitrary conversations. Scores use the documented terms-and-evidence matcher; review saved evidence and notes.
- Live audio transcription and the full office/LiveKit microphone path are still separate acceptance checks. Native constrained-schema mode did not pass live acceptance; the verified local default is JSON mode with strict local validation.

If the browser says it cannot reach the local demo server, start scripts/start-ai-demo.cmd and refresh. The Windows launcher now starts a hidden background Node process, checks readiness, and reuses an already-running demo. Logs are in data/ai-demo.log and data/ai-demo-error.log. npm run ai:demo remains a foreground option: keep its terminal open.

Run the launcher from your own Windows terminal for continued use. Processes started inside the assistant's managed command environment can be stopped when that command/session ends, even if the browser tab remains open. The foreground alternative is npm run ai:demo with its terminal left open.

After changing AI_SUMMARY_MODEL, restart the demo process (Ctrl+C, then npm.cmd run ai:demo) so it reloads .env. The model badge will show the selected model on the next live result. The fixture score measures labeled action matching; it does not grade summary prose or usefulness, and the current tiny conversation has no stated deadlines.

Flash selection check: Gemini 3.8 Flash timed out at 30 seconds. Gemini 3.6 Flash completed the commitments case in 5,592 ms using 927 reported tokens, with both expected actions and owners correct. The selected summary model is now gemini-3.6-flash; audio transcription remains gemini-3.5-flash-lite. Flash's prose quality and performance across the full suite have not been established by this single-case check. Report: data/ai-eval/live-1792894954094.json.

## Automated verification and usage guard

You do not need to click through cases manually:

- `npm run ai:verify` runs typecheck, automated tests, build, all reference fixtures, and an offline browser check. It makes **zero** Gemini requests.
- `npm run ai:verify -- --live` also runs the eight-case live suite and one real browser extraction. At most nine provider calls are planned, spaced between cases; a provider failure stops the suite and skips the live browser request. It requires enough remaining local budget before it starts.
- `npm run ai:usage` reads the persistent local usage database without contacting Gemini. The demo has the same meter plus a refresh button.

Reports: `docs/AI_VERIFICATION_LATEST.md`, `data/ai-eval/verification-latest.json`, and `data/ai-eval/latest-live.json`. Earlier timestamped reports are retained for debugging. The planning-handoff fixture includes decisions, a blocked dependency, missing Teams permissions, a canceled task, and small talk. Its note coverage checks are lexical/evidence heuristics; they do not grade prose or prove semantic support.

Accounting starts when this feature is enabled. Earlier live evaluation reports, earlier browser calls, and other applications are not included in the meter. It records request attempts before sending, HTTP/provider failures, and provider-reported token usage. Pending/crashed or failed requests without token metadata remain visible as unknown usage, not zero-token requests. A received HTTP response can still fail extraction validation. Neither credentials nor conversation content are stored in the usage database.

`AI_USAGE_DATABASE=./data/ai-usage.sqlite` and `AI_LOCAL_DAILY_REQUEST_LIMIT=20` are defaults. The local cap uses UTC days and persists across demo/CLI/host-worker restarts. It is a conservative **local safeguard**, not a statement that Google grants 20 requests or uses UTC resets. Google limits vary by project, model, tier, request rate, and tokens; the app cannot report authoritative remaining Google quota. See https://aistudio.google.com/usage and https://ai.google.dev/gemini-api/docs/rate-limits.

When Google returns 429, the project pauses calls for the current credential across models. If a numeric Retry-After header is present, it permits a later manually initiated request after that time; it does not automatically retry or claim that the daily quota reset. With no known retry-after time, the pause persists until you check Google usage and explicitly clear the local pause in the demo. Clearing it does not reset Google quota or the local daily budget. Service outages, malformed output, and timeouts are recorded separately and do not establish that Google quota was exhausted.

Docker workers use a separate persistent `office-ai-usage` volume, not the application notes database volume. Host processes share their local database; host and Docker meters are separate unless deliberately configured to use the same accounting storage. Local-file accounting is a development safeguard, not a distributed organization-wide quota service.

The usage panel refreshes locally every 10 seconds while visible and after each extraction. These status reads make no Gemini requests. An earlier verification passed 222 automated tests and eight reference fixtures; that earlier live run stopped on its first request with HTTP 503 (service unavailable), not a quota response. No automatic retry was made. This does not establish Flash accuracy across all eight live fixtures.

Message/task review is now available below the notes. Select Reviewing as, then edit/approve/discard proposals and export approved JSON. It adds no model calls. See MESSAGE_DRAFT_PREVIEW.md for saved history, evidence, and delivery boundaries. Restart the demo process once after updating source so the new routes are loaded.

The subsequent eight-case live Flash run completed all requests and passed action extraction, but missed a speaker-export dependency in the planning summary. Prompt meeting-actions-v5 addresses explicit blocker/dependency coverage. One targeted planning-handoff retest passed all five note facts and both actions using one request / 1,969 tokens. See AI_VERIFICATION_LATEST.md for exact saved reports; the full live suite has not been rerun on v5. The verification console now distinguishes quality-check failures from provider failures.
