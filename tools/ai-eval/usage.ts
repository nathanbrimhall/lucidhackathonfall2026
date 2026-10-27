import { UsageTracker } from "../../worker/src/usage.js";
import { loadWorkerConfig } from "../../worker/src/config.js";
const config = loadWorkerConfig();
const tracker = new UsageTracker(config.usageDatabase, config.apiKey, config.localDailyRequestLimit);
try { if (process.argv.includes("--clear-pause")) tracker.allowManualRetry(); console.log(JSON.stringify(tracker.status(), null, 2)); } finally { tracker.close(); }
