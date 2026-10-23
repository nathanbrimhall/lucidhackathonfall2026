import { createApplication } from "./app.config.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

async function main() {
  const config = loadConfig();
  const app = createApplication(config);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("server.stopping");
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    try { await app.stop(); log("server.stopped"); }
    catch { log("server.shutdown_failed"); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  try { await app.start(); log("server.started", { port: config.port }); }
  catch { await app.stop(); throw new Error("Server failed to start"); }
}

void main().catch((error: unknown) => {
  log("server.startup_failed", { message: error instanceof Error ? error.message : "Startup failed" });
  process.exitCode = 1;
});
