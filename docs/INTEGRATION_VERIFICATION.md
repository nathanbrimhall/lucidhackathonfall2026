# Integrated office verification status

Updated October 27, 2026.

| Check | Result |
| --- | --- |
| Latest TypeScript typecheck | Passed before full-suite execution |
| Latest production compilation, assets, media harness and frontend bundle | Passed |
| Earlier full offline suite | 287 tests / 34 files passed, before the latest fixture and negative-test additions |
| Later focused collaboration/integration suite | 18 tests passed before the last seven negative cases |
| Earlier integrated browser | Passed real HTTP/Colyseus movement, unanimous consent, synthetic worker transcript, private notes, reviewed task, approved message and dependency urgency; model was mocked |
| Final full suite and seeded-demo browser | Blocked by automatic approval review; no final pass claimed |
| Official Gemini transport, no key sent | Reachable, HTTP 404 at host root |
| Live Gemini decision verification | Passed valid output/citation checks |
| Live relevant-conversation discovery | Passed valid output/citation checks |
| Remaining live assistant actions and extraction smoke | Not completed; live run terminated by approval review |
| Fictional demo startup | Started on loopback port 2568; health ok and three personas confirmed |
| Real microphones, RTP audio and actual speech transcription | Not verified by these checks |

Automatic approval review repeatedly reported attempted telemetry to dc.services.visualstudio.com with an unknown payload. Local network guard self-checks demonstrate that external HTTP/HTTPS are blocked; minimal inherited environments are also used. Review still terminated the full verification and later live run. Those commands were not repeatedly rerun after the final rejections. No authorization to disclose data to the telemetry endpoint was assumed.

Offline command: npm run office:verify. Explicit bounded Gemini command: npm run office:live-check. Run only after resolving the review block or manually in the local development environment. Model calls use fictional data, the configured Gemini endpoint, persistent local accounting, and no automatic retries/fallback. Unknown or interrupted requests remain counted. Google's remaining project quota is not known.
