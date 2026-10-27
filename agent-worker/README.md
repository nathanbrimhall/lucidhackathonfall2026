# Bounded office agent worker

Default `fixture` mode is deterministic and visibly fictional. It makes zero model calls. It asks each authorized contact once, ends the turn, and builds a structured brief using real stored answers on the next authorized turn. Required labeled scenario fields (Office URL, Join instructions, Near audio, Far audio, Private-room audio, Known issues) remain unknown until supplied; arbitrary replies cannot silently mark the brief complete. Conflicts remain partial for review. Supported fixture edits are applied; unsupported instructions are retained and labeled partial for review. It does not establish live autonomous reasoning.

The explicit live alternate is `gemini`: one direct Gemini JSON request per claimed turn, no provider fallback, tools, auxiliary models, automatic model retries, history, memory, scheduling or delegation. The office reserves one model request atomically on claim (including failure/crash); the existing `UsageTracker` reserves the shared daily credential budget before dispatch. Use the same absolute `AI_USAGE_DATABASE` path, Gemini credential and daily limit as the office and transcription worker. Different working directories/databases would split local accounting. Provider usage outside this shared tracker is excluded.

Run from the repository root with Node 24+ and dependencies installed:

```sh
# Existing server must expose authenticated /internal/agents/jobs endpoints.
# Set AGENT_WORKER_SECRET to the server's matching dedicated agent-worker token.
# Start the normal office server with AGENT_RUNTIME=fixture.
# It runs the fixture internally; no separate fixture HTTP worker is needed.

# Explicit live alternate; incurs a paid request only when a live job is claimed.
# Existing loadWorkerConfig also requires AI_WORKER_SECRET (at least 32 chars).
AGENT_RUNTIME=gemini AI_PROVIDER=gemini npx tsx --env-file-if-exists=.env agent-worker/src/index.ts
```

`AGENT_SERVER_URL` (alias `AGENT_OFFICE_URL`) defaults to `http://127.0.0.1:2567`. Non-loopback office endpoints require HTTPS. Set `GEMINI_API_KEY`, existing `AI_SUMMARY_MODEL`, `AI_USAGE_DATABASE`, `AI_LOCAL_DAILY_REQUEST_LIMIT` and `AI_PROVIDER_TIMEOUT_MS` through the environment. Keys and tokens belong only in server/worker environments.

Each new or continued turn reconstructs context from the office `/:id/context` endpoint under its lease. Questions return from the runtime; the office persists them and releases the lease. Human waiting makes zero provider calls. A permitted reply can queue bounded continuation for independent work while other questions remain open; waiting itself never queues inference. Idle queue polling does not invoke the model. Stop the assignment in the office to cancel; the worker checks its lease/cancellation every second during model work and immediately before applying results. SIGINT/SIGTERM aborts the current request. The worker execution limit is 45 seconds, provider timeout defaults to 30 seconds, HTTP control requests time out at 10 seconds, and responses are size bounded. The office rejects late effects atomically even if cancellation races a completed model response. No uncertain execution is blindly retried by this worker.

`executeAgentJob(port,runtime,options)` and `FixtureAgentRuntime` are also usable in-process. `AgentJobPort` supports synchronous service methods or the authenticated `HttpAgentJobPort`; `claim(workerId,mode,runtime)` must atomically reserve live request count and filter the configured runtime. HTTP claims carry `runtime: "gemini" | "hermes"`; omitted runtime defaults to `gemini` for existing direct-adapter clients. A Gemini worker cannot claim a server configured for Hermes. HTTP completion uses `{leaseToken,result}`; failure uses `{leaseToken,message}`.

## Pinned Hermes adapter

`AGENT_RUNTIME=hermes` selects the real programmatic `AIAgent` API at [NousResearch/hermes-agent commit 74885f997bece88c1393bd174b25b32338336cb6](https://github.com/NousResearch/hermes-agent/tree/74885f997bece88c1393bd174b25b32338336cb6). The adapter checks the exact commit and a clean checkout before every turn. It never substitutes another release or a direct Gemini runtime. The [pinned AIAgent source](https://github.com/NousResearch/hermes-agent/blob/74885f997bece88c1393bd174b25b32338336cb6/run_agent.py) and [HTTP API documentation](https://github.com/NousResearch/hermes-agent/blob/74885f997bece88c1393bd174b25b32338336cb6/website/docs/user-guide/features/api-server.md) were inspected; this implementation uses the programmatic API instead of an unrestricted gateway.

Each turn gets a fresh Python process, temporary home, working directory and session ID. Shared memory, user profile, context files, background review, title generation, compression, plugins, streaming, trajectories, checkpoints and fallback are disabled. A Python audit policy permits network connections only to a unique one-use loopback provider proxy, blocks external DNS/datagrams and subprocess tools, and the child inherits no provider key or office token. This policy relies on clean trusted runtime code and is not an operating-system sandbox for hostile Python extensions.

The only model-visible tool is `office_submit_turn`. Its strict schema stages authorized questions and/or an evidence-linked draft. Readable tasks, allowed contacts and current answers arrive in the freshly authorized context; no additional read tools are needed. The tool ends the Hermes loop immediately, rather than returning a pending answer to the model. The office server then validates and atomically persists the submission. A later turn reconstructs office state; no Hermes transcript or live clarification promise is resumed. Approval and publication remain server-controlled human review actions and are never runtime tools.

The local proxy sends exactly one request through the existing Gemini provider and shared `UsageTracker`. It translates a validated structured JSON response into the OpenAI-compatible tool-call envelope consumed by Hermes; it does not use Gemini native function calling. Any extra inference request, retry or unsupported tool is rejected, with no provider fallback. Hermes model metadata probes receive local responses without provider dispatch. A consumed office claim remains reserved after uncertain failure, while the shared usage tracker records each actual provider attempt and available token counts. Use the same credential, absolute usage database path and daily cap across the server and all workers.

### Installation and selection

Install outside this repository, with Python 3.14 and `uv` available:

```sh
HERMES_CHECKOUT="$HOME/.local/share/lucid-office/hermes-source"
HERMES_VENV="$HOME/.local/share/lucid-office/hermes-venv"
mkdir -p "$HOME/.local/share/lucid-office"
git clone https://github.com/NousResearch/hermes-agent.git "$HERMES_CHECKOUT"
git -C "$HERMES_CHECKOUT" checkout 74885f997bece88c1393bd174b25b32338336cb6
uv venv --python 3.14 "$HERMES_VENV"
UV_PROJECT_ENVIRONMENT="$HERMES_VENV" uv sync --frozen --no-dev --project "$HERMES_CHECKOUT"
```

Configure the existing persistent office and worker environment with matching settings:

```dotenv
AGENT_RUNTIME=hermes
AI_PROVIDER=gemini
AGENT_HERMES_SOURCE_ROOT=/absolute/path/to/hermes-source
AGENT_HERMES_PYTHON=/absolute/path/to/hermes-venv/bin/python
```

Retain the dedicated matching `AGENT_WORKER_SECRET`, required `AI_WORKER_SECRET`, Gemini key/model and shared usage settings described above. Do not put credentials into the Hermes checkout or its home. Start the office normally, then `npm run agent:dev` from the repository root. A live assignment incurs a model request only after a worker successfully claims it. Fixture mode remains available inside the server with zero provider calls.

### Verification and limits

With the source and Python paths configured, run:

```sh
npm run agent:verify:hermes
```

This command requires the pinned installation and fails if paths/dependencies are missing, tests fail, or any test skips. It uses real pinned `AIAgent` execution with intercepted synthetic Gemini responses and fake credentials; it makes zero paid requests. Its report is `data/ai-eval/hermes-verification-latest.json` (local, ignored by Git), including source commit, Python/dependency versions, test totals and synthetic dispatch count.

On October 27, 2026, the dedicated check passed seven tests with zero skips, six synthetic provider dispatches and zero paid provider requests, using Python 3.14.8, OpenAI SDK 2.54.0, Pydantic 2.14.1 and HTTPX 0.28.1 from the frozen upstream lock. It exercised real question/end-turn/independent-draft/authorized-resume behavior, isolated tool and memory configuration, omitted credentials, blocked network/subprocess attempts, shared daily cap, failure without extra provider dispatch and stop during a request.

The normal suite runs the dependency-free scope/pin checks and skips the five real-runtime tests unless `AGENT_HERMES_TEST_SOURCE_ROOT` and `AGENT_HERMES_TEST_PYTHON` are provided. Use the dedicated command to establish the dependency gate. `npx vitest run agent-worker/test/runtime.test.ts server/test/agent-integration.test.ts` also checks worker cancellation and that a mismatched live runtime cannot claim work.

The synthetic verifier establishes the pinned runtime’s integration boundaries. The subsequent bounded live check below separately established actual Gemini question/answer/title-edit behavior through Hermes. Separate-device usability, audio isolation and two-human rehearsal remain open. Runtime status continues to report `liveVerified: false` because a configured office or new assignment does not inherit acceptance from this isolated synthetic-account check.

### Bounded live Hermes verification

On October 27, 2026 at 15:51 MDT, `npm run agent:live-check -- --live --runtime hermes --edits` passed with exactly three real `gemini-3.6-flash` requests. The pinned runtime asked a scoped question, paused without inference, incorporated the supplied answer, applied the requested title on a fresh evidence-linked draft, and rejected approval of the old revision. This used two synthetic authenticated accounts and no separate devices. The local report is `data/ai-eval/agent-live-check-latest.json`; it does not close human/LAN acceptance. The optional `--edits` raises the live check cap from two to three requests; it never retries or resets quota.
