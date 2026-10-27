# Integrated demo: manual acceptance checklist

## Start and sign in

From the repository root in PowerShell:

~~~powershell
npm run office:demo
~~~

Keep that terminal open and visit **http://localhost:2568/**. This is the integrated frontend and real local backend, with fictional saved data. Choose **Use Demo Nathan** in one window, **Use Demo Cameron** in a second, and **Use Demo Maya** in a third. Use separate browser profiles or independently opened tabs; duplicated tabs can copy session storage. Each persona can occupy only one office seat. Use Leave before changing accounts. If a stale session remains after restarting, choose a demo persona again.

The FICTIONAL DEMO badge identifies this mode. Its in-memory office resets on Ctrl+C/restart; the normal office database is untouched. Gemini usage accounting persists across restarts. Notes and tasks are seeded; no speech was recorded to create them. Live capture controls are disabled in this mode. LiveKit is optional for these data/UI checks; an audio connection error does not prevent movement or saved-data features.

No Microsoft/Slack account is required: messages below are delivered inside this office. External Teams/Slack/Planner delivery is not connected. Video, employee-role permissions, audio retention, automatic daily delivery, and floor-conversation recording are not implemented.

## Check the integrated office without spending Gemini quota

- [ ] **Multiplayer and artwork:** see both connected people; move using WASD/arrows with the canvas focused, and click the floor. The other window sees movement. Walls, furniture and the meeting-room doorway block/pass movement consistently. Walk to meeting room should route through the door. Returning to the floor changes the location label.
- [ ] **People and focus:** see real online/offline states. Save a short shared focus/skill in Office and refresh People in another window; the update appears.
- [ ] **Private meeting notes:** Nathan and Cameron see two fictional meeting drafts. Maya sees no meeting notes, while still seeing shared task titles. The audio-only scope, stated reason, unverified video assumption, conditional Teams proposal, later local-preview draft, and unresolved retention question are visible.
- [ ] **Reviewed tasks:** from Nathan's notes, Review task proposal. Change the title to a unique test task, select Cameron, and publish. It is proposed, not active. Cameron accepts; only Cameron can edit/complete it. Nathan refreshes and sees the change. Publishing a title makes that title office-visible, not the source note.
- [ ] **Message approval:** Nathan prepares a message from a note, selects Cameron and saves it. Cameron receives nothing yet. Approve saved wording; still nothing is sent. Edit it; approval is removed. Approve again, then Send approved desk note. Cameron refreshes Desk notes, reads/replies. Maya sees neither message nor private draft.
- [ ] **Personal reminders:** Nathan clicks Remind me on an action, sets a future local date/time with the correct IANA timezone, and saves. It appears only under Nathan's Reminders. Also create/cancel a separate reminder and check the due notification with the window connected. Shared task completion and personal reminder cancellation are separate actions.
- [ ] **Optional interruptions:** immediate inbox notices default off. Enable them while Available on the floor, refresh once, then send a new desk note from another account. A short toast should appear after refresh/poll (up to 15 seconds). Repeat while Do Not Disturb, Away, or in a meeting: the message stays in the inbox without a new-item toast. Returning to Available must not replay the backlog. Availability never grants recording consent.
- [ ] **Session isolation:** reload and Resume my session; saved changes remain until demo restart. Leave and choose another persona; old notes/drafts/assistant results must disappear. Restart the demo to restore all fixtures. Persistent production-office storage is tested separately from this in-memory reset.

## Test the eight AI actions

Only **Ask assistant** submits a model request. Typing and quick buttons merely prepare a request. Wait at least **15 seconds between asks**. Read the local quota meter first: it covers calls tracked by this app, not Google's full project quota. Stop on a quota or provider error; do not repeatedly click. These eight checks normally require eight calls; Maya's privacy check and the second dependency check are optional extra calls. Set timezone **America/Denver**, today for daily briefs, and yesterday through today for catch-up, matching the seeded notes' dates.

| Action | Suggested question | Expected review |
| --- | --- | --- |
| Find relevant conversations | What notes relate to the speaker-ID export blocking task previews? | Only readable saved-note/task citations; no claim of live eavesdropping. |
| Find the right helper | Who has relevant experience with LiveKit speaker-ID exports? | Cameron, supported by shared skills or assigned work; no invented expertise or authority. |
| Dependency radar | Which existing task blocks my task preview? | Suggest Nathan's preview depends on Cameron's active export. Nothing changes until Confirm my task dependency. |
| Check duplicate work | Does my proposed speaker-ID export duplicate accepted work? | Suggest linking Nathan's proposal to Cameron's export, preserving Cameron's ownership. Confirm explicitly. |
| Verify decisions / assumptions | Was video approved, why was audio-only chosen, and what happened to Teams delivery? | Distinguish the recorded audio-only draft and its reason from the unverified video assumption; acknowledge conditional/later drafts without inventing approval. |
| Daily brief | Summarize my saved notes and current blockers for today. | Today's readable notes plus clearly identified current task snapshots; unresolved retention remains unresolved. |
| Catch-up brief | What changed in the saved meeting drafts while I was away? | Include yesterday's conditional Teams draft and today's local-preview draft with citations and uncertainty; no invented message/activity history. |
| Meeting preparation | What questions should we clarify about retention, video scope and speaker IDs? | Proposed agenda/questions grounded in notes; no booking meetings or assigning tasks. |

- [ ] **Dependency review and priority:** confirm Nathan's dependency; Cameron's export shows one distinct person waiting and medium coordination priority. As Maya, optionally ask dependency radar about attribution tests and confirm her dependency: two distinct people produce high coordination priority. Base priority stays intact. Removing dependencies reverses the count. Multiple dependent tasks owned by Nathan count Nathan only once.
- [ ] **Duplicate review:** leave Nathan's seeded export in proposed state until this check. Confirm duplicate and link: it becomes linked, the existing owner receives a quiet notice, and urgency counts the requester once. If Nathan already has a dependency, linking must not count him a second time. Undo duplicate link restores the proposal; it does not transfer Cameron's work.
- [ ] **Read-only answers:** assistant suggestions do not silently send messages or change task states. Citations are saved AI-note statements, not verbatim transcript proof. Unsupported questions should produce uncertainty/no supported evidence.
- [ ] **Maya privacy (optional extra call):** ask Maya about why the private meeting chose audio-only. She may see shared tasks/focus, but must not receive Nathan/Cameron's note text, rationale, or private message content.
- [ ] **Brief detail:** My work and blockers vs Project context I can access changes relevance over the same permissions. It does not simulate manager privileges.
- [ ] **Quota and failures:** meter advances after requests. A provider quota response pauses calls; Google's remaining allowance is unknown. No automatic model fallback, OpenAI call, or quota reset occurs. An offline/malformed/provider failure should show an error while office data remains usable.

## Real microphone, proximity and consent checks (separate setup)

The fictional demo does not verify real audio. For a real capture test, use the normal office:

1. Start/configure LiveKit and its webhooks as documented in README and docs/M4_AI_CHECK.md. Use headphones/two devices to avoid feedback.
2. Set AI_PROVIDER=gemini and a valid GEMINI_API_KEY/AI_WORKER_SECRET in the ignored .env. Enable AI_ENABLED=true only when ready to capture fictional speech. Keep the configured session/invite and LiveKit secrets; do not share them in screenshots.
3. Run **npm run office:dev -- --worker**, then open **http://localhost:2567/**. Join two different named guests with the configured invite. The demo personas exist only on port 2568.
4. Turn microphones on explicitly. Check near/far floor audio, mute/deafen, meeting-room audio isolation, leave/rejoin and Retry audio after a media failure. Movement and saved data should remain usable when media is unavailable.
5. Walk both people into the meeting room. Request notes: no capture before both consent for the current roster. Decline/withdrawal must stop capture; a new entrant requires renewed consent before capture continues. Availability is unrelated.
6. Once capturing, speak a short fictional commitment and explicit scope/reason. Speak for at least 15 seconds with the default 10-second chunk interval; wait for **Transcribed excerpts saved** to exceed zero before Stop and finalize. Very short/unfinalized tails may be missing; review partial notes.
7. Wait for Meeting notes, check ownership/dates/summary, then review a task and approve/send a message. A guest outside the meeting must not gain private notes. No retained audio playback is available.
8. Watch Gemini usage: transcription plus summarization can use multiple calls per meeting. Stop capture before reaching the local budget. Do not record real/private workplace speech for this hackathon check.

## Automated checks and reporting

- **npm run office:verify** runs guarded typecheck, production build, full automated tests, integrated multiplayer/consent/task/message browser tests, and seeded-demo browser checks. Model responses/audio are synthetic in offline checks; no provider quota is spent.
- **npm run ai:usage** reads the persistent local request ledger without calling Gemini.
- **npm run office:live-check** explicitly runs a bounded fictional-data real Gemini check. It is separate from offline verification, never retries automatically, and stops on the first provider/quota failure. It reserves manual-test quota when possible; no test should deliberately exhaust the allowance.

For failures, record persona, panel/action, expected/actual behavior, error text, and the local time. Never include API keys, bearer tokens, real conversation data or the full .env. Check off features only after observing the stated behavior; a passing mocked test does not establish live model accuracy.
