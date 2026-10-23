import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { migrateDatabase } from "./repositories/Storage.js";

try {
  migrateDatabase(loadConfig().databasePath);
  log("database.migrated");
} catch {
  log("database.migration_failed");
  process.exitCode = 1;
}
