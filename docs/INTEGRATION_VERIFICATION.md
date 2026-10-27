# Integrated office verification status

Updated October 27, 2026.

| Check | Latest evidence |
| --- | --- |
| Full application suite in the user's normal PowerShell terminal | **303 tests / 34 files passed** in data/ai-eval/office-verification.log, October 27 at 07:36 America/Denver |
| Typecheck, production compilation, assets, media harness and frontend | Passed in that same complete run |
| Integrated browser | Movement, unanimous consent, private saved notes, reviewed tasks, approved in-app messages and dependency urgency completed; timed out waiting for the final Decision Q&A answer |
| Seeded demo browser | Not reached in the original run; no pass claimed |
| New request-reduction regression tests | **6 tests passed**: visible-panel reads, current data, merged triggers, a required follow-up after concurrent writes, overlapping polling, and recovery from read failure |
| Typecheck and frontend bundle after request reduction | Passed |
| Final browser recheck after request reduction | Pending; this managed execution session still blocks localhost connections with EACCES |
| Live Gemini matrix | Earlier decision and conversation checks passed; remaining live actions and extraction remain pending |
| Real microphones and actual speech transcription | Not established by mocked tests |

The earlier 38 failures were followed by a complete 303/303 pass outside the managed execution sandbox. They are not outstanding application-test failures. The Colyseus unregistered-handler/reconnect warnings in that run did not fail the tests.

The browser timeout did not preserve the final assistant HTTP response, so its precise cause is not proven. The browser harness now logs API failures and checks the assistant response before waiting for rendered text. It respects the existing per-user HTTP budget; production limits are unchanged.

The frontend now fetches shared work/inbox/usage on each refresh, and notes or reminders only for their visible panels. Background requests on the other panels fall from 12 to 4 per minute. Duplicate form-completion reads are removed. Concurrent refreshes are merged; a mutation arriving during a read still schedules one fresh follow-up. Notes/reminders are refreshed on opening their panels. No backend files or Gemini prompts were changed for this optimization.

Run only the remaining browser checks from a normal terminal:

```powershell
npm run office:verify:browser 2>&1 | Tee-Object -FilePath data/ai-eval/office-browser-verification.log
```

This rebuilds the frontend and runs both isolated browser checks with mocked Gemini. It saves a machine-readable report at data/ai-eval/office-browser-verification-latest.json and does not spend provider quota. The full npm run office:verify command also remains available. Its runner now attempts both independent browser scripts even if the first fails.

Live checks remain separate: npm run office:live-check uses fictional data, existing persistent usage accounting, the configured Gemini endpoint, no automatic provider retries/fallback, and a reserve for manual calls. This session currently cannot resolve/connect to that endpoint; no credentialed live calls were attempted in this request.

All fixes remain local. Git terminal networking failed; the connected GitHub integration returned 403 for a repository write after destination authorization was verified. No remote upload succeeded. Do not claim the changed CI workflow is running.
