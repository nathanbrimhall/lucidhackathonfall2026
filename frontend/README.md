# Integrated Lucid Office frontend

This is the approved pixel-office design connected to authenticated Colyseus movement, LiveKit media, saved private notes, durable in-app collaboration and the Gemini assistant. It replaces the disconnected prototype simulation.

Run npm run office:demo from the repository root and open http://localhost:2568 for seeded fictional accounts and data. Run npm run office:dev and open http://localhost:2567 for the persistent office using its configured invite. Both commands build the frontend first; do not open index.html directly or serve it with a standalone static server.

See ../docs/INTEGRATED_DEMO_CHECKLIST.md for the manual acceptance checklist and real-audio setup.

- index.html preserves the approved layout and styling.
- renderer.js draws the office artwork and actual replicated players.
- client.ts owns authenticated sessions, movement input, Colyseus events and LiveKit lifecycle.
- main.ts owns panels and explicit review/approval actions. It never keeps the provider key in the browser.
- scripts/build-frontend.mjs bundles browser code into dist/server/frontend; the server serves that directory at /.

The server uses OFFICE_LAYOUT=prototype by default. Its 45x32 map, walls and doorway match the artwork; the legacy map remains available for existing transport regression fixtures. Desk notes select an authenticated recipient through People or the compose dialog; physical desk ownership is not assigned by join order.

The assistant reads only saved notes the caller can access, shared tasks, and shared focus/skills. It submits only on Ask assistant. Daily and catch-up brief detail never elevates permissions. Reviewed task proposals require owner acceptance; approved message drafts require a separate explicit in-app send. Teams/Slack external delivery is not connected. Personal reminders remain separate from shared tasks.

The fixture demo uses real HTTP/WebSocket services and an isolated in-memory database with clearly fictional notes. It does not capture audio. Normal office media capture requires real LiveKit, a running worker, AI_ENABLED=true and unanimous meeting-roster consent. No audio clips are retained.
Frontend refreshes share one in-flight queue. Shared work and inbox data refresh every 15 seconds; private notes/reminders refresh only while their panels are visible, and immediately when those panels open. A write during a refresh queues one follow-up so updated data is not lost. Successful form submissions perform one completion refresh. This reduces idle requests from 12 to 4 per minute outside the notes/reminders panels without changing provider calls or server permissions.
