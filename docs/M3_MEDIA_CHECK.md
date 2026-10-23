# M3 browser meeting-room check

This guide verifies automatic private meeting audio in the browser harness: zone entry and exit, transition acknowledgement, mute preservation, epoch rotation, and drop/reconnect. Run it with three real browser users after completing the M2 setup in [M2_MEDIA_CHECK.md](M2_MEDIA_CHECK.md). SDK and server tests do not establish audible behavior.

## Start

1. Follow the M2 start steps: configure `.env`, start the application and self-hosted LiveKit with the webhook callback, `npm ci`, `npm run build`, and open `/media-harness/` in three independent profiles or devices. Each user creates a distinct guest, enables the microphone, and resumes audio playback.
2. The shipped map has one meeting zone, `meeting-east`, at x 21.5 to 30, y 2 to 12, with a wall segment at x 21 to 21.5 and a doorway gap between wall segments. Locate the doorway on the harness map before testing. Zones own their left/top edges and exclude right/bottom.
3. Use headphones and distinctive short phrases per speaker. The harness follows the client transition procedure on `media.transition` (stop, ack, fetch credentials with `transitionRevision`, reconnect) and shows the current room on its meeting status line. A brief audio gap during transitions is expected. Do not paste credentials into screenshots or logs.

## Three-person procedure

| Check | Procedure | Expected result |
| --- | --- | --- |
| Doorway entry | A walks through the doorway into the zone. | A receives a transition, reconnects once to the meeting room, and the shared state shows the zone occupied. A no longer hears floor speakers. |
| Private conversation | A and B are inside the zone and speak. C stands just outside the wall, close in tile distance to both. | A and B hear each other at full gain. C hears nothing from A or B (and A/B hear nothing from C), despite short tile distance. |
| Mute preserved | B mutes, then A walks into the zone while B is inside; also mute A before A crosses the doorway. | The muted state is unchanged after each entry; muted users stay silent; the microphone is only re-published if the user's preference is unmuted. The server never unmutes. |
| Exit restores floor | A walks out of the zone back toward C. | A transitions back to the floor, hears and is heard by C by normal proximity (gain 1 through 2 tiles, fading to 0 at 6), and no longer hears B. |
| Epoch rotation | A, B, and C are inside; C walks out. | A and B briefly reconnect (an `epoch_rotation` transition) and keep talking in the new room. C is on the floor and cannot hear them. |
| Rapid crossing | A crosses the doorway in and out repeatedly. | No stuck audio, no duplicate connections, and the final mode matches A's final position. Exits are immediate; re-entry within 1 second of an exit is deferred until the cooldown passes, so B (inside) sees at most about one rotation per second. `TRANSITION_PENDING`/`STALE_TRANSITION` retries resolve without user action. |
| Disconnect in meeting | With A, B, C inside, close C's tab or cut its network. | C's media stops; A and B rotate rooms and continue. If C was last occupant, the meeting ends and the zone's indicator disappears. |
| Reconnect inside zone | Reconnect C within the 30-second reservation (or rejoin) while standing in the zone. | C receives a `reconnect` transition, acks, and rejoins the meeting with a fresh media identity. C remains muted unless they previously chose otherwise. |
| Room to room | Not manually testable: the shipped map has one meeting zone. | Covered by automated tests only. Add a second zone to exercise it in a browser. |
| Replay | Automated-test coverage, not a browser step. | Credentials issued for an old epoch or zone target a retired, deleted room; rejoin attempts are evicted by the webhook, and the current meeting is unreachable. |

## Evidence record

- Date / commit / deployment:
- A, B, C browsers and devices:
- Doorway location and zone bounds observed:
- Pass/fail for each table row, observed reconnect latency, and issue links:
- Rotation gap observed when someone leaves (seconds):
- Separate-network result, if tested:

## Status

Automated coverage is 117 server/domain tests plus the synthetic `npm run smoke:media` meeting checks (private A/B audio with floor listener C excluded; exit and epoch rotation), which passed three consecutive runs on October 23, 2026. The tests cover the meeting state machine, token and transition-revision errors, epoch rotation, drop/reconnect, and replay against retired rooms. Physical-device and real-audio checks in this guide are manual and have not yet been recorded. Do not mark the M3 real-audio exit check complete until the three-person procedure has actually run. Self-hosted LiveKit does not revoke issued tokens, so privacy relies on 60-second credentials, epoch rotation, and webhook eviction; a short window exists between rotation and old-room deletion.
