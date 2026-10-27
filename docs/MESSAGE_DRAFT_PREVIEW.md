# Message and task proposal preview

The transcript demo now includes **3. Review messages and tasks**. Start `npm run ai:demo`, open http://127.0.0.1:8788/, choose the participant you are reviewing as, and run a fictional case in offline or live mode. The commitment case produces two task proposals and one message draft to Cameron when reviewing as Nathan.

## Generation

This stage turns the existing AI-extracted action items into deterministic, editable message wording and task proposals. It makes **no additional Gemini calls**. Offline replay tests the complete preview without an API key. Live mode uses the existing single extraction request, quota tracking, and failure handling. The wording source is recorded as `templates-from-extracted-actions`; this is not a second AI-authored composition request.

Each action becomes a task proposal. Actions owned by someone other than the reviewer also produce a message draft. A reviewer's own task does not produce a self-addressed message. Unassigned actions retain a null owner/recipient until a person is selected. Suggestions refer only to authorized participants in this conversation; these IDs are not verified Slack/Teams accounts.

Messages quote the action and ask for an update, with an agreed deadline only when extraction supplied one. They never invent a due date. Evidence links use the existing source segment IDs and show the cited excerpts.

## Review and export

- Edit message text/recipient or task title/owner/deadline.
- Save edits, then approve. Approval can also save the current edits in one action.
- Choose a recipient or task owner before approval. Messages cannot be addressed to their own sender.
- Editing an approved item returns it to draft status and requires approval again.
- Discard unwanted proposals or explicitly restore them as drafts.
- Export approved items as JSON. Draft/discarded items and uncited excerpts are omitted from export.
- Reload the page and use **Load saved review** to resume saved edits and approvals.

Unsaved edits block export and loading another review. Reset edits returns a card to its last saved state. Revision checks reject stale updates rather than overwriting a newer review. Approval, export, and editing make no provider requests.

Approval is a **local review state**. No message is sent, and no Slack/Teams/Planner task is created. There is no delivery adapter, token, send endpoint, or external account mapping in this preview.

## Data and modules

Local demo reviews are stored in `data/ai-followups.sqlite` (Git-ignored; configurable with `AI_REVIEW_DATABASE`). It stores proposal text, participant IDs/names, statuses/revisions, and cited excerpts, not the complete transcript or API credentials. History is capped at the latest 50 review bundles. This is a single-user localhost development tool; shared deployment needs the office's authentication/readership checks.

- `shared/src/followups.ts`: separate proposal/review contracts, leaving the existing AI note contract compatible.
- `worker/src/followups.ts`: reusable post-extraction composition and evidence mapping.
- `tools/ai-demo/review-store.ts`: persistent local review state, optimistic revisions, approved-only export.
- `tools/ai-demo/review.js`: message/task editor and saved review UI.
- `tools/ai-eval/runner.ts`: fixture/live extraction now returns the same proposal bundles.

The standalone transcript path is wired end-to-end. Integrating this preview with the full office/LiveKit UI is still separate work; create follow-ups while the authorized transcript is available, before its existing cleanup step. External delivery must resolve participant IDs to verified destination accounts and enforce the saved approval/revision.

## Verification

234 tests passed across 26 files, including generation, recipient/owner validation, unauthorized IDs, evidence tampering, stale edits, approval invalidation, discard/restore, approved-only export, and persistence across restart. Typecheck, production build, all eight offline fixtures, and Chrome browser checks passed. The browser check edits a message, approves it, downloads the approved-only JSON, reloads the saved review, invalidates approval by editing, and discards/restores a task. It also checks reviewer switching, prevention of unsaved-edit loss, and preservation of message edits after a simulated network failure. No Gemini requests were made for this feature or its verification.

Run `npm run ai:verify` for the offline checks. `--live` is optional and spends extraction quota; it is not needed to test the new review flow.
