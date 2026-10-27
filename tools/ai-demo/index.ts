import { createDemoApp } from "./app.js";
const port = Number(process.env.AI_DEMO_PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid AI_DEMO_PORT");
const app = createDemoApp();
const server = app.listen(port, "127.0.0.1", () => console.log(`AI transcript demo: http://127.0.0.1:${port}/ (offline replay by default)`));
server.once("close", () => app.locals.close());
server.on("error", () => { console.error("Cannot start demo. Check whether AI_DEMO_PORT is already in use."); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close(); server.closeAllConnections(); });
