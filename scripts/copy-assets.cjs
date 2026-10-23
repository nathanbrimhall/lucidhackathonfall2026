const { cpSync, mkdirSync } = require("node:fs");
mkdirSync("dist/server", { recursive: true });
cpSync("server/migrations", "dist/server/migrations", { recursive: true });
