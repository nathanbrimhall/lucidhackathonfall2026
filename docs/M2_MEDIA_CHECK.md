# M2 browser media check

This harness verifies microphone capture, WebRTC transport, authoritative movement, and client proximity playback. Run it with three real browser users; SDK/server tests alone do not establish audible media behavior. Meeting zones are drawn only as future private audio and do not provide M3 isolation.

## Start

1. Configure `.env`, including the guest invite, session signing key, LiveKit keys, internal/public LiveKit URLs, and webhook secret/configuration described in the repository runbook. Start the application and self-hosted LiveKit. Configure the webhook callback to the server before testing participant lifecycle.
2. `npm ci`, then `npm run build`. The build calls `node scripts/build-media-harness.mjs`; it bundles `@colyseus/sdk` and `livekit-client` into `dist/server/media-harness/main.js` and copies HTML/CSS. The browser uses local assets without CDN requests. For harness-only edits, run that script directly.
3. Open `/media-harness/` on the application origin. Use localhost for local capture or trusted HTTPS/WSS for separate machines. LiveKit signaling and advertised ICE/UDP/TCP/TURN endpoints must also be reachable; HTTP health alone does not establish WebRTC connectivity.
4. Use three devices or separate browser profiles, preferably with headphones. Each user creates a distinct guest with the invite. A saved guest token is kept in per-tab `sessionStorage`; “Resume saved guest” reuses it after reload. Some browsers copy sessionStorage when duplicating a tab: use fresh profiles/tabs and create separate guests. Duplicate active guests should be rejected.
5. Each user explicitly clicks **Enable microphone** and **Resume audio playback**. Microphones are off on initial join. Denying capture must not stop map movement or remote listening. Do not paste credentials into screenshots or logs.

Focus the map to move with WASD/arrows. Coordinates are server owned; the browser sends sequenced direction input at 10 Hz. Dark geometry should stop avatars. Outlined meeting zones are M3 placeholders. The policy panel shows only public media identities, distance, gain, revision, and the count of successful LiveKit connections on this page; it never shows tokens or invite codes.

## Three-person procedure

Record browser/device, network, thresholds from the current server configuration, and pass/fail evidence below. Speak distinctive short phrases to distinguish the three voices.

| Check | Procedure | Expected result |
| --- | --- | --- |
| Nearby conversation | A and B approach while both speak. Keep C far away. | A and B hear one another at policy-directed gain; C does not hear them. Remote avatars agree. |
| Independent distances | Keep A near B, move C near B but beyond A's exit radius; adjust positions until the policy panel confirms these distances. | B hears A and C independently; A and C do not hear one another. Moving C changes C's gain without changing A's gain at B. |
| Falloff | Walk A away from B slowly, then return. | B hears A fade with policy gain; A is unsubscribed beyond the exit boundary and resubscribed on entry. The LiveKit connection counter remains unchanged. |
| Hysteresis | Start with A out of range. Hover between configured entry and exit radii; cross entry, hover in that band again, then cross exit. Repeat several times. | No subscription before entry; subscription persists in the band after entry; it ends after exit. No repeated LiveKit joins and no boundary chatter. |
| Microphone denial | Fresh profile: deny permission when clicking Enable microphone. | Clear denial/unavailable feedback; no microphone publication, movement and listening still work. Reallow and click Enable microphone to retry. |
| Mute | With A and B near, A clicks Mute microphone, speaks, then enables it again. | B cannot hear muted A; other voices remain audible. Unmuting resumes A. |
| Deafen | B clicks Deafen while A and C speak; then undeafens. | B immediately hears neither and unsubscribes. B's microphone preference remains independent; undeafening restores only currently eligible microphone tracks. |
| Republish | A clicks Republish microphone while near B; repeat after moving out and back into range. | B receives A's new microphone publication only when policy permits, at the current gain. Connection counter stays unchanged. No camera/screen subscription occurs. |
| Office drop | Interrupt A's application WebSocket/network (or stop the application). | A stops movement, local capture, and remote playback; harness reports the drop. Retry manually after recovery; a held seat may need its reconnect reservation to expire. |
| Media drop | Interrupt LiveKit signaling/media connectivity or stop LiveKit, leaving application reachable. | On detected media interruption/disconnection A stops media and office participation. Restore service and retry manually. No background reconnect loop or stale microphone continues. |
| Reload/resume | Reload A, click Resume saved guest, then enable microphone explicitly. Also retry after a server restart. | Same guest identity resumes using a fresh authorized seat and media credential. Stored deafen and mic intent remain visible; microphone still requires a click. No old seat identity is reused. |
| Access rejection | Use an invalid/expired guest token or an already connected guest; test media token authorization with the automated endpoint tests. | Clear generic connection failure; no credentials appear in UI/console and no media starts. |

## Evidence record

- Date / commit / deployment:
- A, B, C browsers and devices:
- App HTTPS and media connectivity across devices verified:
- Configured entry / exit / maximum-gain distances:
- Pass/fail for each table row, observed latency, and issue links:
- LiveKit connection counts before/after repeated boundary crossing:
- Separate-network result, if tested:

Do not mark M2's real-audio exit check complete until the three-person check has actually run. Browser support, permission prompts, autoplay rules, and ICE connectivity require real devices. The harness deliberately fails closed on detected office/media drops and exposes manual retry; its proximity subscriptions are client playback policy and do not provide private-room confidentiality.

SDK API references: [Room.connect and startAudio](https://docs.livekit.io/reference/client-sdk-js/classes/Room.html), [RemoteTrackPublication.setSubscribed](https://docs.livekit.io/reference/client-sdk-js/classes/RemoteTrackPublication.html), and [RemoteAudioTrack.setVolume](https://docs.livekit.io/reference/client-sdk-js/classes/RemoteAudioTrack.html).

## Automated synthetic browser check

Install dependencies with `npm ci`, then install the matching browser with `npx playwright install chromium`. Start the configured application/LiveKit stack and run `npm run smoke:media` in an otherwise empty demo office. Run one smoke check at a time; its exact speaker-count assertions assume no additional guests. The script reads the invite from `.env` using Node's environment loader and does not print it. `PUBLIC_SERVER_URL` selects the application origin. Optional `CHROMIUM_EXECUTABLE` selects a preinstalled Chromium executable; `PLAYWRIGHT_MODULE` can select a Playwright module path in a managed runtime.

`tools/media-smoke.mjs` launches three isolated headless Chromium contexts with fake microphones. It intercepts browser peer connections for `getStats()` evidence and observes rendered avatars for keyboard navigation. It checks nonzero inbound RTP bytes/audio energy, full and distance-dependent audio-element volume, independent A–B/B–C subscriptions with A–C out of range, mute/deafen, republishing a new inbound RTP track, entry/exit hysteresis including zero gain, one LiveKit connection throughout movement, and fail-closed peer-connection/playback cleanup after network loss. It also checks removal of detached DOM audio elements. Credentials are neither printed nor included in the collected evidence.

This is synthetic audio on one machine. It complements the three-person procedure; it does not establish human audibility, real microphone quality, mobile browser behavior, or separate-device/network ICE reachability.

## Recorded automated validation — October 23, 2026

Passed 95 server/domain/HTTP tests, TypeScript checks, the production build, Docker Compose build/start/health, the two-client movement smoke, and the isolated three-context synthetic media smoke against self-hosted LiveKit. The browser smoke verified inbound RTP audio energy, full/distance/zero gain, independent subscriptions, mute/deafen, republishing, hysteresis without reconnecting, detached-element cleanup, and network-drop cleanup. Local browser execution used the documented `CHROMIUM_EXECUTABLE` override for an installed Chromium headless shell.

Physical microphone listening, actual browser permission prompts/denial, and separate-device/network connectivity remain manual checks.
