import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/* Apex's single local database (data/apex.db). Everything the agents know or
 * do lives here: memory, CRM, jobs, proposed actions, loops, the call log.
 * One connection per process - kept on globalThis because Next bundles each
 * route separately and would otherwise open several. */

export const DATA_DIR = process.env.APEX_DATA_DIR || join(process.cwd(), "data");

const MIGRATIONS: string[] = [
  `
  CREATE TABLE memory_facts (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL DEFAULT '',
    fact TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE VIRTUAL TABLE memory_fts USING fts5(subject, fact, content='memory_facts', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER memory_ai AFTER INSERT ON memory_facts BEGIN
    INSERT INTO memory_fts(rowid, subject, fact) VALUES (new.id, new.subject, new.fact);
  END;
  CREATE TRIGGER memory_ad AFTER DELETE ON memory_facts BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, subject, fact) VALUES ('delete', old.id, old.subject, old.fact);
  END;
  CREATE TRIGGER memory_au AFTER UPDATE ON memory_facts BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, subject, fact) VALUES ('delete', old.id, old.subject, old.fact);
    INSERT INTO memory_fts(rowid, subject, fact) VALUES (new.id, new.subject, new.fact);
  END;

  CREATE TABLE clients (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'enquiry' CHECK (stage IN ('enquiry','quote','won','lost')),
    value REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'CZK',
    next_step TEXT NOT NULL DEFAULT '',
    next_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CZK',
    paid_at TEXT NOT NULL DEFAULT (date('now')),
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','done','paused')),
    due_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    due_date TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at TEXT
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    parent_run_id TEXT,
    agent TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
    evidence TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX jobs_agent ON jobs(agent, created_at);

  CREATE TABLE actions (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    agent TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','failed')),
    evidence TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT
  );

  CREATE TABLE loops (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    speak INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE loop_runs (
    id INTEGER PRIMARY KEY,
    loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    UNIQUE (loop_id, period)
  );

  CREATE TABLE llm_calls (
    id INTEGER PRIMARY KEY,
    run_id TEXT,
    provider TEXT NOT NULL,
    agent TEXT NOT NULL,
    ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    cost_usd REAL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE guide_versions (
    id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX messages_conv ON messages(conversation_id, id);
  `,
  // 1: local semantic index (server/semantic.ts) - embedded chunks of vault
  // notes, memory facts and chat history, plus FTS for hybrid keyword scoring.
  `
  CREATE TABLE sem_chunks (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    chunk_no INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    hash TEXT NOT NULL DEFAULT '',
    mtime REAL NOT NULL DEFAULT 0,
    vec BLOB NOT NULL
  );
  CREATE INDEX sem_chunks_ref ON sem_chunks(source, ref);
  CREATE VIRTUAL TABLE sem_fts USING fts5(title, text, content='sem_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER sem_ai AFTER INSERT ON sem_chunks BEGIN
    INSERT INTO sem_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
  END;
  CREATE TRIGGER sem_ad AFTER DELETE ON sem_chunks BEGIN
    INSERT INTO sem_fts(sem_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  END;
  CREATE TRIGGER sem_au AFTER UPDATE OF title, text ON sem_chunks BEGIN
    INSERT INTO sem_fts(sem_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
    INSERT INTO sem_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
  END;
  CREATE TABLE sem_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: owner settings edited in the app (server/settings.ts) - applied over
  // process.env at boot; plus which model served each LLM call.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE llm_calls ADD COLUMN model TEXT;
  `,
  // Native CLI session per chat conversation (short-term memory between turns).
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

function migrate(db: DatabaseSync) {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

function open(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(join(DATA_DIR, "apex.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  // Holds OAuth tokens: owner-only file permissions.
  for (const f of ["apex.db", "apex.db-wal", "apex.db-shm"]) {
    const p = join(DATA_DIR, f);
    if (existsSync(p)) chmodSync(p, 0o600);
  }
  // Work cut off by a restart can't still be running.
  db.exec(`
    UPDATE jobs SET status = 'failed', output = CASE WHEN output = '' THEN 'Přerušeno restartem serveru.' ELSE output END,
      finished_at = datetime('now') WHERE status = 'running';
    UPDATE actions SET status = 'failed', error = 'Přerušeno restartem serveru během provádění – ověř u poskytovatele, zda se akce neprovedla, než ji zopakuješ.'
      WHERE status = 'approved';
  `);
  return db;
}

const g = globalThis as { __apexDb?: DatabaseSync };

/* A hot-reloaded module reuses the cached connection; still apply any
 * migrations appended since it was opened. */
let migrated = false;

export function db(): DatabaseSync {
  if (!g.__apexDb) g.__apexDb = open();
  else if (!migrated) migrate(g.__apexDb);
  migrated = true;
  return g.__apexDb;
}

export type Row = Record<string, unknown>;

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}
export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}
export function run(sql: string, ...params: unknown[]) {
  return db().prepare(sql).run(...(params as never[]));
}

export function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
