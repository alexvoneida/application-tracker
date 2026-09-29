import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type {
  Application,
  Event,
  Action,
  Source,
  Snapshot,
  ImportRecord,
} from "../shared/model.ts";

export type Tables = {
  applications: Application;
  events: Event;
  actions: Action;
  sources: Source;
  snapshots: Snapshot;
  imports: ImportRecord;
};
const names = [
  "applications",
  "events",
  "actions",
  "sources",
  "snapshots",
  "imports",
] as const;
export class Store {
  db: DatabaseSync;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, "tracker.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    for (const table of names)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)))`,
      );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS application_url ON applications(json_extract(data, '$.canonicalUrl')); CREATE INDEX IF NOT EXISTS source_app ON sources(json_extract(data, '$.applicationId'));",
    );
  }
  all<K extends keyof Tables>(table: K): Tables[K][] {
    return this.db
      .prepare(`SELECT data FROM ${table}`)
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  get<K extends keyof Tables>(table: K, id: string): Tables[K] | undefined {
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE id = ?`)
      .get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  put<K extends keyof Tables>(table: K, value: Tables[K]) {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
    return value;
  }
  remove(table: keyof Tables, id: string) {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }
  setting<T>(id: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT data FROM settings WHERE id = ?")
      .get(id);
    return row ? JSON.parse(row.data as string) : fallback;
  }
  set(id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(id, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  backup() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      tables: Object.fromEntries(names.map((n) => [n, this.all(n)])),
    };
  }
  close() {
    this.db.close();
  }
}

// Portable fallback: authenticated encryption, private directory and 0600 key/file.
// Both files are local-only and intentionally omitted from export/backup APIs.
export class Vault {
  private key: Buffer;
  private values: Record<string, string> = {};
  constructor(
    private directory: string,
    protectedKey?: Buffer,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (protectedKey) {
      if (protectedKey.length !== 32) throw new Error("Invalid vault key.");
      this.key = Buffer.from(protectedKey);
    } else {
      const keyPath = join(directory, "secrets.key");
      if (!existsSync(keyPath))
        writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
      chmodSync(keyPath, 0o600);
      this.key = readFileSync(keyPath);
    }
    const path = join(directory, "secrets.enc");
    if (existsSync(path)) {
      const data = readFileSync(path);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        data.subarray(0, 12),
      );
      decipher.setAuthTag(data.subarray(12, 28));
      this.values = JSON.parse(
        Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
    }
  }
  get(name: string) {
    return this.values[name] || "";
  }
  set(name: string, value: string) {
    if (value) this.values[name] = value;
    else delete this.values[name];
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(this.values)),
      cipher.final(),
    ]);
    const temporary = join(this.directory, "secrets.enc.tmp");
    writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), body]), {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(this.directory, "secrets.enc"));
  }
}
