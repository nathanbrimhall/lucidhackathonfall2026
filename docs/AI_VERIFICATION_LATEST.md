# AI verification

Generated: 2026-10-25T02:52:23.389Z

Mode: offline. Result: PASS.

| Check | Result | Time |
| --- | --- | --- |
| typecheck | PASS | 12.6 s |
| automated-tests | PASS | 68.0 s |
| production-build | PASS | 10.3 s |
| offline-fixtures | PASS | 2.8 s |
| browser-smoke | PASS | 6.5 s |

Detailed results and usage status: data/ai-eval/verification-latest.json.

Offline runs make no provider calls. Live mode uses the configured model and records requests before sending them. Provider quota errors pause further requests; no automatic retry or model fallback occurs. This report cannot establish remaining Google quota or usage from other applications.

Supplemental browser checks passed after the final UI updates: reviewer switching, network-failure recovery preserving unsaved text, unsaved-edit navigation guard, message editing/approval/approved-only download, reload of saved review, approval invalidation after editing, and task discard/restore. No JavaScript errors or Gemini calls.

## Targeted dependency fix after the user-provided live run

The eight-case Flash run saved in `data/ai-eval/live-1792896319829.json` completed every request and extracted all expected actions, owners, and deadlines. Its planning summary omitted the relationship between missing speaker IDs and blocked attribution/draft-preview work. The checker correctly reported one missing note fact; this was not a provider failure or a quota response.

Prompt `meeting-actions-v5` now explicitly preserves stated blockers and dependencies in the summary without creating extra actions. The actual omitted-context output is retained as a regression fixture at `worker/test/fixtures/planning-blocker-omission.json`; evaluation expectations were not relaxed.

A single targeted Flash retest of `planning-handoff` passed both action checks and all five note facts. It took 12,672 ms and reported 1,969 tokens. Report: `data/ai-eval/live-1792897480931.json`. No other live cases were rerun with v5 to conserve quota, so this is not a full v5 live-suite pass. Typecheck and 29 extraction regression tests passed. The verifier now identifies quality-check failures separately from provider/extraction failures.
