import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UserRecord {
  userId: string;
  displayName: string;
  createdAt: string;
}

/** SQLite owner for the application process. Workers must use an internal API. */
export class Storage {
  /** Application-owned connection; never shared with workers. */
  readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("journal_mode = WAL");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    // BEGIN IMMEDIATE serializes concurrent migration commands across processes.
    const migrate = this.db.transaction(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const [version, file] of [[1, "001_identity.sql"], [2, "002_ai_notes.sql"]] as const) {
        if (this.db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) continue;
        this.db.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      }
    });
    migrate.immediate();
  }

  healthCheck(): boolean {
    return (this.db.prepare("SELECT 1 AS healthy").get() as { healthy: number }).healthy === 1;
  }

  getUser(userId: string): UserRecord | undefined {
    return this.db.prepare("SELECT user_id AS userId, display_name AS displayName, created_at AS createdAt FROM users WHERE user_id = ?").get(userId) as UserRecord | undefined;
  }

  hasMembership(userId: string, officeId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM office_memberships WHERE user_id = ? AND office_id = ?").get(userId, officeId));
  }

  /** Insert the guest and its initial office membership atomically. */
  createGuest(displayName: string, officeId: string): UserRecord {
    const user: UserRecord = { userId: randomUUID(), displayName, createdAt: new Date().toISOString() };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO users (user_id, display_name, created_at) VALUES (?, ?, ?)").run(user.userId, user.displayName, user.createdAt);
      this.db.prepare("INSERT INTO office_memberships (user_id, office_id, created_at) VALUES (?, ?, ?)").run(user.userId, officeId, user.createdAt);
    })();
    return user;
  }

  close(): void { this.db.close(); }
}

/** Opening storage also applies pending migrations before serving traffic. */
export function openStorage(databasePath: string): Storage { return new Storage(databasePath); }

/** Standalone deployment migration entry point; safely repeatable. */
export function migrateDatabase(databasePath: string): void {
  const storage = openStorage(databasePath);
  storage.close();
}
