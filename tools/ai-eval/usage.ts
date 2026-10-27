import { UsageTracker } from "../../worker/src/usage.js";
import { loadWorkerConfig } from "../../worker/src/config.js";
const config = loadWorkerConfig();
const tracker = new UsageTracker(config.usageDatabase, config.apiKey, config.localDailyRequestLimit);
try {
  if (process.argv.includes("--clear-pause")) {
    const wasPaused = tracker.status().quotaPaused;
    tracker.allowManualRetry();
    console.error(wasPaused ? "Cleared the local quota pause. Google's quota is unchanged; Ask may pause again if it is still exhausted." : "No local quota pause was active.");
  }
  console.log(JSON.stringify(tracker.status(), null, 2));
} finally { tracker.close(); }
