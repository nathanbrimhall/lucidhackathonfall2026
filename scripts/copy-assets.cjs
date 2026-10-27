const { cpSync, mkdirSync } = require("node:fs");
mkdirSync("dist/server", { recursive: true });
cpSync("server/migrations", "dist/server/migrations", { recursive: true });
cpSync("server/maps", "dist/server/maps", { recursive: true });
mkdirSync("dist/tools/ai-demo", { recursive: true });
for (const name of ["index.html", "main.js", "review.js", "discovery-ui.js", "interruptions.js", "ai-panel.js"]) cpSync(`tools/ai-demo/${name}`, `dist/tools/ai-demo/${name}`);
