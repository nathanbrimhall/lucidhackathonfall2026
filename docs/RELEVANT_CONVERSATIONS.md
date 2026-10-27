# Relevant conversation discovery

Restart `npm run ai:demo` and open http://127.0.0.1:8788/. Use **Discover relevant conversations**, enter a fictional work problem, and click **Find relevant conversations with Gemini**.

The fixed four-conversation catalog covers speaker attribution, message approval/deduplication, optional interruptions, and lunch. Browse source conversations before searching. Each search makes one Gemini request using the existing summary model, shared cooldown/session budget and persistent usage tracker. No automatic retries, polling for relevance, extra extraction, or OpenAI fallback. No matches is a valid result. Results are not persisted.

Gemini selects up to three discussions and explains their relevance with excerpt IDs. The server validates the response shape, known conversation IDs, unique matches and evidence IDs. This validates references, not semantic truth; users should check quoted evidence. The interest text and catalog are treated as untrusted data in the prompt. All displayed strings use textContent.

Only fictional demo content is sent. There is no connection to office notes, recording, availability, notifications, employee analytics, or external delivery. The deliberately shared demo catalog does not establish real access permissions. Office integration must obtain authorization from existing server readership checks before sending any candidate content to a model. Do not implement access filtering only in the browser.

Modules:
- tools/ai-demo/discovery.ts: fixed catalog, input/output contracts, relevance prompt and validation.
- tools/ai-demo/discovery-ui.js: search, result explanations, source excerpts, empty/error states.
- tools/ai-demo/app.ts: localhost/origin-protected discovery endpoints sharing demo request limits.
- worker/src/providers.ts: optional Gemini JSON generation method reusing bounded requests, timeout, usage and error handling.

Office backend files are unchanged by this feature. Further office backend work requires Nathan's approval.

Verification uses mocked provider responses and no live Gemini calls. Run the focused Vitest discovery/demo/provider tests and `node --import tsx tools/ai-demo/discovery-browser-smoke.mjs`. Live semantic relevance still needs acceptance; one fictional query is sufficient for an initial manual check.

## Helper discovery and optional interruptions

Use the **Find** selector to switch between relevant conversations and the right helper. Both modes use the same work description and one Gemini call per click, with shared request limits. Helper suggestions use a fixed fictional directory of stated focus areas plus shared discussion excerpts. Known person IDs, linked discussions and real excerpt references are validated. Attending a conversation alone is not treated as proof of expertise. Suggestions do not establish availability or willingness.

Each helper card includes an editable local question draft. Nothing is sent. **Simulate an invitation in my inbox** demonstrates the recipient experience in the current browser; it does not contact that helper.

**Make interruptions optional** saves only availability and the immediate-notice preference in browser localStorage. Available plus an explicit opt-in displays an immediate inline notice. Away, In a Meeting and Do Not Disturb keep invitations in the quiet inbox. Default is quiet. Switching back to Available does not announce old invitations. No OS notifications, sounds or recording changes occur. Invitation text stays in memory and disappears on refresh. Preferences are local to this browser and are not enforced across devices or office sessions.

### Combined manual acceptance

1. Restart `npm run ai:demo` and refresh http://127.0.0.1:8788/.
2. In conversation mode, search: "I need to identify who said what so we can assign tasks." Check the attribution discussion and cited excerpts.
3. Wait at least 15 seconds. Switch to helper mode and repeat. Check whether Cameron is suggested with speaker-mapping evidence. This uses another Gemini request.
4. Expand **Prepare a question** and edit the draft. Confirm nothing is sent.
5. Click **Simulate an invitation in my inbox**. With the default quiet preference, open the quiet inbox to inspect it.
6. Set Available and enable immediate notices. Simulate another invitation; check the inline notice.
7. Repeat with Away, In a Meeting and Do Not Disturb. Invitations should remain quiet even with the checkbox checked.
8. Refresh. Availability/preference should persist, while invitations disappear. Switching to Available should not replay old notices.
9. Optionally search an unrelated fictional problem after the cooldown; an empty result is valid. Check the usage meter before further live searches.

Automated mocked checks cover helper source validation, unknown/duplicate people, unrelated source links, interruption policy, malformed stored preferences, helper endpoint routing, UI rendering, quiet delivery, DND and refresh behavior. No live semantic-quality acceptance is claimed.
