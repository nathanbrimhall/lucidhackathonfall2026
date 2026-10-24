# M5 reminders and demo readiness

This guide records the reminder API contract and the remaining end-to-end demo checks. Reminders are private to the authenticated guest who owns them. An AI-generated action item is only a proposal: creating it requires an explicit user confirmation in the application.

## Reminder contract

All HTTP routes require the guest bearer token. Reminder contents and notification state stay private to the owner; they are not part of public office room state.

| Operation | Contract |
| --- | --- |
| `POST /api/reminders` | Create the authenticated guest's reminder. Body: `{ "requestId": "UUID", "text": "...", "dueAt": "2026-10-25T16:30:00Z", "timezone": "America/Denver", "source"?: { "noteId": "UUID", "actionItemIndex": 0 } }`. `dueAt` is an ISO timestamp with an explicit offset and represents UTC; use `Z` for UTC. `timezone` is a valid IANA time zone. `source` is optional and, when present, identifies a note UUID and non-negative action-item index. |
| `GET /api/reminders` | List only the authenticated guest's reminders. Response: `{ "reminders": [...], "nextCursor": null }` (or a UUID cursor), up to 100 records in descending due-time/ID order. Pass `?before=<nextCursor>` for the next page; inaccessible cursors return `NOT_FOUND`. |
| `PATCH /api/reminders/:id` | Edit or cancel an owned reminder. Body: `{ "requestId": "UUID", "revision": 1, "text"?: "...", "dueAt"?: "2026-10-25T16:30:00Z", "timezone"?: "America/Denver", "status"?: "canceled" }`. `revision` is a positive integer. |

Use a new UUID `requestId` for each distinct mutation and reuse it only when retrying that same request. A retry with the same key and mutation returns its original result without creating a second reminder. A stale revision or reusing a request key for a different mutation returns `409 CONFLICT`. Read the reminder's current revision from `GET /api/reminders` before a `PATCH`. A canceled reminder is not delivered. Changing its text, due time, or time zone invalidates work for its previous revision.

When a reminder becomes due, the server sends the owner a private `reminder.due` room message with `{ "notificationId": "...", "reminder": { ... } }`. The client acknowledges it with `reminder.ack { "notificationId": "..." }`. Acknowledgment marks the reminder acknowledged and advances its revision. Delivery is at least once: clients deduplicate notifications by `notificationId` and acknowledge them. An unacknowledged reminder remains available for delivery when its owner rejoins after being offline. Do not promise exactly-once delivery across a network failure. A note/action-item `source` can only be used for a note the guest may read, and only for an action item assigned to that guest or left unassigned. The reminder still belongs to the guest who explicitly confirms it.

## Local setup

Start with a fresh or known demo environment. Keep secrets out of this evidence record.

1. Copy `.env.example` to `.env`. Set distinct random values for `SESSION_SECRET`, `LIVEKIT_API_SECRET`, and `AI_WORKER_SECRET`; configure a guest invite code and AI provider credentials for the notes part of the demo.
2. Use the normal build-based stack for local work:

   ```sh
   docker compose --profile ai up --build -d --wait
   ```

   AI is opt-in. Set `AI_ENABLED=true` in `.env` and provide a valid worker secret and provider key for notes. Reminder operations do not require the AI worker.
3. Check `http://localhost:2567/healthz` and `http://localhost:2567/readyz`, then open `/media-harness/` in independent browser profiles. The harness is for verification, not the product UI.

## Acceptance checklist

Record observed results and the deployed image tags or digests. Do not mark manual checks complete based on unit tests or a synthetic browser smoke alone.

| Check | Procedure | Expected result | Status |
| --- | --- | --- | --- |
| Create and list | Create a reminder with an explicit UTC `dueAt`, an IANA time zone, and a unique `requestId`; call `GET /api/reminders`. | The owner sees the new reminder. A second guest cannot list or retrieve it. | Pending manual check |
| Retry and key misuse | Retry the same creation with the same `requestId` and identical body, then try that key for different content. | The retry does not create a duplicate; key misuse returns `409 CONFLICT`. | Pending manual check |
| Edit and cancel | Update a reminder using its current revision, then try an old revision. Cancel another reminder before it is due. | The update advances its revision; the stale update returns `409 CONFLICT`; the canceled reminder does not fire. | Pending manual check |
| Due while online | Keep the owner connected until a short reminder becomes due. Receive the private room event and send `reminder.ack` with its `notificationId`. | The owning guest receives `reminder.due`; another guest receives no reminder content. The client can deduplicate by notification ID and acknowledge delivery. | Pending manual check |
| Offline catch-up | Create a reminder, disconnect its owner before the due time, let it become due, then reconnect as that guest. | The unacknowledged notification is delivered after reconnect. Repeated delivery with the same ID does not create a second client-side notification. | Pending manual check |
| Container replacement | Seed an offline reminder, recreate the server container while retaining `office-data`, and run `smoke:reminders verify` as described below. | The reminder survives replacement, the private event retries under the same ID, the harness renders it once, and its acknowledgment survives reload. | Automated check added; passing CI result pending |
| Backup and restore | Follow the quiesced volume procedure below, restore into an empty volume, start the stack, and inspect reminders. | SQLite opens cleanly and the restored reminders/outbox records are present. | Verified locally with a new Docker volume, 2026-10-24 |
| Image-only host | On a second Docker host, pull the same server and worker image tag or digests using `deploy/compose.images.yaml`, configure that host, and start the demo. | The deployment runs without building from source or installing Node.js; the same image artifacts work on the second compatible host. | Pending manual check |
| Separate-machine demo | Use separate physical machines and browser sessions to complete join/movement, proximity audio, private meeting audio, consented notes, and a confirmed reminder. | The full demo path works through the deployed trusted HTTPS/WSS address and LiveKit media ports. | Pending manual check |

## Consistent SQLite backup and restore

There is no application backup command. Make a consistent archive by quiescing database access first. Stop the worker and server and confirm that no migration job is running; then archive the entire `/data` directory, including any SQLite `-wal` and `-shm` files. Do not copy only `office.sqlite` while the server is running.

From the repository root, with the default Compose project name, the data volume is `lucidhackathonfall2026_office-data`:

```sh
docker compose --profile ai stop worker server
mkdir -p backups
docker run --rm \
  -v lucidhackathonfall2026_office-data:/data:ro \
  -v "$PWD/backups:/backup" \
  busybox:1.37.0 tar -czf /backup/office-data.tgz -C /data .
docker compose --profile ai start server worker
```

If the Compose project name was changed, substitute the actual volume name. Store the archive securely because it contains guest identities, notes, and reminders.

For restore, stop the stack and extract the archive into an empty data volume, then restore ownership for the runtime user (`1000:1000`) before starting the migration and server services. Do not extract over a volume containing data you need to preserve. For the default project volume:

```sh
docker compose --profile ai stop worker server
docker run --rm \
  -v lucidhackathonfall2026_office-data:/data \
  -v "$PWD/backups:/backup:ro" \
  busybox:1.37.0 sh -c 'tar -xzf /backup/office-data.tgz -C /data && chown -R 1000:1000 /data'
docker compose --profile ai up -d --wait
```

The archive and image are separate deployment artifacts. Copying or pulling the images does not move SQLite data to another host.

## Image-only deployment on another host

The example [image-only Compose file](../deploy/compose.images.yaml) uses `SERVER_IMAGE` for both the server and migration job and `WORKER_IMAGE` for the optional AI worker. Compose requires both image variables to be set even when the `ai` profile is not started; the worker container itself starts only with `--profile ai`. The file reads runtime settings from the repository-root `.env` file. Run it from the repository root so `../.env` and the LiveKit config bind mount resolve correctly. Set both image references to a published version tag or, preferably for a recorded demo, an immutable digest:

```sh
SERVER_IMAGE=registry.example/lucid/server:release \
WORKER_IMAGE=registry.example/lucid/worker:release \
docker compose --profile ai -f deploy/compose.images.yaml pull

SERVER_IMAGE=registry.example/lucid/server:release \
WORKER_IMAGE=registry.example/lucid/worker:release \
docker compose --profile ai -f deploy/compose.images.yaml up -d --wait
```

Replace the example image references with the registry and digest published for the release. Set the same references on each command or export them in the shell. Configure `.env` on the host with its own secrets and externally reachable addresses. Use a distinct database volume on a new host and restore a consistent archive only when the demo needs the existing guest/reminder state. Keep the worker secret distinct from the session and LiveKit secrets; the worker receives no SQLite volume.

The Compose example starts LiveKit, server, migrations, and (with `--profile ai`) the worker. It does not provision TLS, a reverse proxy, DNS, firewall rules, or TURN. Configure `PUBLIC_SERVER_URL` as the trusted `https://` address, `ALLOWED_ORIGINS` for the browser origin, and `LIVEKIT_PUBLIC_URL` as the browser-reachable `wss://` address. Provide trusted certificates and WebSocket upgrade support at the external proxy. Route LiveKit signaling and the configured ICE paths; the checked-in single-port example uses TCP `7880`, ICE/TCP `7881`, and ICE/UDP `7882`. Add TURN and the network's required firewall/router rules when direct connectivity cannot work. Never expose the development `devsecret` values to a shared host.

Run one application server replica: it owns the SQLite database and in-memory office rooms. For upgrades, keep the data volume, pull the selected image references, and let the migration service finish before the server starts. Keep a known-good image digest and consistent data backup for recovery; check migration compatibility before rolling back an image.

## Automated reminder/container replacement smoke

The repository includes `npm run smoke:reminders` for local and CI verification of a confirmed offline reminder across a server-container replacement. It uses the guest API, a headless browser, the media harness, and the same named Compose volume. Install its browser first with `npx playwright install chromium`. Run this only against a demo instance with local data. The state file contains a guest bearer token; choose a private path, keep it out of source control, and remove it after verification.

With the build-based Compose stack running and `.env` configured:

```sh
npm run smoke:reminders -- seed /tmp/lucid-reminder-smoke.json
docker compose up -d --force-recreate --no-deps --wait server
npm run smoke:reminders -- verify /tmp/lucid-reminder-smoke.json
rm -f /tmp/lucid-reminder-smoke.json
```

The verify phase checks that the reminder survived replacement, the private notification is retried with the same ID, the harness renders it once, acknowledgment persists, and the notification remains deduplicated after a page reload and guest resume. It also creates, edits, reschedules, and cancels a reminder through the browser, checking selected-timezone conversion to UTC. This smoke does not verify separate physical devices, external TLS, or LiveKit connectivity across a second host.

## Evidence record and current status

- Date / commit / image tags or digests:
- Host OS and architecture:
- Reminder contract checks and observations:
- Container replacement with the same volume:
- Backup archive and restore result:
- Second-host image-only deployment:
- Separate machines, browsers, and networks used:
- Trusted TLS/WSS, signaling, ICE/TCP, ICE/UDP, and TURN result:
- Issues and follow-up:

The API contract and this runbook define the acceptance target. A quiesced backup was restored into a new local Docker volume and passed SQLite integrity and reminder/acknowledgment checks on 2026-10-24. No second-host deployment, trusted-TLS shared deployment, or full separate-machine demo is recorded here as passed. Complete the evidence record before calling M5 demo readiness verified.

Local automated evidence on 2026-10-24: 179 tests passed; TypeScript checks and production build passed. The browser smoke passed against image-only Compose startup on native Linux arm64 after replacing the server with the same volume. It covered retry deduplication, offline delivery, durable acknowledgment, reload/resume, and browser create/edit/reschedule/cancel with IANA-zone conversion. Production migration, SQLite, and RTC native-module checks passed on native arm64 and emulated amd64; CI now includes native runners for both architectures. These runtime checks do not establish cross-device media connectivity.

The existing SDK multiplayer smoke and full synthetic three-browser media smoke also passed against the M5 container: proximity, mute/deafen, meeting isolation, exit rotation, and disconnect cleanup. Physical microphones and separate devices/networks remain unverified.
