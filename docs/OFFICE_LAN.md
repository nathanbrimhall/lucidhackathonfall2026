# Host the persistent office on your laptop over LAN

Use `office:lan` when collaborators will connect to this laptop on the same network. The office runs as a normal persistent Node process; Docker Desktop runs LiveKit. The launcher serves HTTPS and WSS, advertises the laptop’s LAN address for media, and leaves `.env` unchanged. It does not seed fictional accounts or use an in-memory database.

Separate-device audio and the human agent rehearsal remain **OPEN**. A successful launcher or TLS probe does not establish those results. Record the observations in [AGENT_ACCEPTANCE.md](AGENT_ACCEPTANCE.md).

## 1. Choose the laptop address and prepare a certificate

Use Node 24+, installed project dependencies, Docker Desktop, and Docker Compose with `!override` support (2.24.4+). Stop an existing office on the selected ports first. Keep the laptop awake and connect collaborators to the same LAN; guest Wi-Fi isolation may prevent device-to-device traffic.

Run the setup helper. It lists private LAN IPv4 candidates (ignoring loopback and VPN/tunnel interfaces such as `utun*`, `wg*`), creates or reuses an [mkcert](https://github.com/FiloSottile/mkcert) certificate in `data/office-lan/certs`, writes the collaborator sheet `data/office-lan/JOIN.md`, and prints the exact launch and verification commands:

```sh
brew install mkcert && mkcert -install   # once
npm run office:lan:setup                 # add --ip <address> when several candidates are listed
```

With several candidates the helper refuses to guess and requires `--ip`; a VPN interface is not the LAN address. Other options: `--hostname`, `--cert-dir`, `--office-port`, and `--force` to regenerate a certificate whose SAN no longer covers the address. A reachable address is not proven by the helper; recheck Wi-Fi settings. Send collaborators `JOIN.md` and the `rootCA.pem` it names; never send `rootCA-key.pem` or `office-key.pem`. The sheet contains no invite code.

### Manual fallback

Without the helper, create the certificate for the actual LAN IP (example placeholder shown):

```sh
brew install mkcert
mkcert -install
mkdir -p data/office-lan/certs
OFFICE_LAN_IP=192.168.1.50   # replace with your laptop's LAN address
mkcert -cert-file data/office-lan/certs/office.pem \
  -key-file data/office-lan/certs/office-key.pem "$OFFICE_LAN_IP"
```

If using `--hostname`, include that resolvable hostname in the certificate command as well. The certificate must have matching IP/DNS subject alternative names; the launcher checks them and the validity dates before starting services.

On each collaborator device, install and trust **only the host’s `rootCA.pem`**, found in the directory printed by `mkcert -CAROOT`. Follow mkcert’s [instructions for other systems](https://github.com/FiloSottile/mkcert#installing-the-ca-on-other-systems). Keep both `rootCA-key.pem` and `office-key.pem` on the host. Firefox may require its own trust-store setup. Reopen browsers after installing trust.

## 2. Preserve the office and usage counter

Run `npm run setup:local` if `.env` does not exist. Existing configuration is preserved. Use the existing host-readable `DATABASE_URL` and **the same `AI_USAGE_DATABASE`, Gemini credential and daily limit in the office, agent worker and transcription worker**. The launcher resolves the configured paths and prints the database locations, without printing credentials.

Container paths such as `/data/office.sqlite` and `/usage/ai-usage.sqlite` are not host paths. The launcher rejects them and `:memory:`. If migrating from a container, first choose or restore a persistent host database; do not assume a new empty file contains the old office. `--database` and `--usage-database` are explicit path overrides. A usage override must identify the existing shared counter used by every process, rather than introduce a new daily allowance.

## 3. Start and join

From the repository root (the setup helper prints this command filled in; `OFFICE_LAN_IP` is your address):

```sh
npm run office:lan -- --ip "$OFFICE_LAN_IP" \
  --cert data/office-lan/certs/office.pem \
  --key data/office-lan/certs/office-key.pem
```

The launcher builds the frontend, starts/reconfigures the project’s LiveKit container, starts the persistent office on loopback, then opens these default listeners:

| Port | Use |
| --- | --- |
| TCP 8443 | Office HTTPS and Colyseus WSS, bound to the selected LAN IP |
| TCP 8444 | LiveKit WSS, bound to the selected LAN IP |
| TCP 7881 / UDP 7882 | LiveKit media, advertised at the selected LAN IP |
| TCP 7883 | Only `POST /api/livekit/webhook`; the office validates signed LiveKit callbacks |
| Loopback TCP 2567 / 7880 | Office and LiveKit upstream services |

Allow the required listeners through the laptop firewall. The HTTP callback listener exposes only the signed callback route; user APIs remain behind TLS. Docker Desktop reaches it through `host.docker.internal`, its [documented host-service address](https://docs.docker.com/desktop/features/networking/networking-how-tos/). The generated LiveKit configuration sets `rtc.node_ip` to the selected LAN IP and disables external-IP discovery, following the [pinned LiveKit configuration](https://github.com/livekit/livekit/blob/v1.13.10/config-sample.yaml).

Collaborators open the printed office address, for example `https://192.168.1.50:8443`, enter their display name, and use the existing invite code supplied privately by the host. Each person permits their own microphone. Use the same office URL on the host laptop. Do not use `localhost` on collaborator devices.

Ctrl+C stops the host office and TLS proxies. The persistent database is retained, and the LiveKit container remains running. Do not run a second office process against the same active office/database. Re-run the launcher if the laptop address changes, and regenerate its certificate if needed.

For live agents, select the same explicit runtime on the server and `npm run agent:dev` worker; see [agent-worker setup](../agent-worker/README.md). The worker can use `http://127.0.0.1:2567` on this laptop and must use the same absolute usage-counter path. Fixture mode needs no separate agent worker or provider calls.

## 4. Verify, then rehearse

Node probes also need to trust the development CA. From a machine that can reach the laptop:

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
  npm run agent:deployment-check -- --allow-lan \
  --office-url "https://$OFFICE_LAN_IP:8443" \
  --livekit-url "wss://$OFFICE_LAN_IP:8444"
```

The preflight checks HTTPS health/readiness and the WSS host’s TLS certificate. It does not create a room, request a model response, verify WebRTC, or attest for people. Readiness reports media dependencies separately; inspect them and test audio even when storage readiness is green.

Have two people on separate devices test near/far audio and private-room isolation, then assign a real goal, answer a real question and review the evidence-linked brief. Rehearse the failure cases listed in the acceptance record, following the step-by-step [rehearsal runbook](AGENT_REHEARSAL.md). Copy `docs/agent-acceptance-template.json` to a private evidence location, fill it from observations, then run:

```sh
npm run agent:acceptance-check -- /absolute/path/to/rehearsal-record.json
```

The validator checks completeness and consistency of recorded attestations. It cannot independently verify that a claimed human observation occurred. `OPEN` and `FAIL` results must remain visible; mark M5/M6 accepted only after the corresponding real observations are recorded.
