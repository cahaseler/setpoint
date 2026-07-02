import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../util/logger.js";

const log = createLogger("database");

/**
 * Initialize the SQLite database with the game state schema.
 *
 * Uses a single `game_state` table with JSON columns for each state section.
 * Each row represents one account's current state. Partial updates replace
 * individual columns without touching others.
 */
export function createDatabase(path: string): Database {
	log.info(`Opening database at ${path}`);

	// Ensure parent directory exists for file-based databases
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}

	const db = new Database(path, { create: true });

	// Enable WAL mode for better concurrent read performance
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");

	db.run(`
		CREATE TABLE IF NOT EXISTS game_state (
			account_id         TEXT PRIMARY KEY,
			player             TEXT,
			ship               TEXT,
			cargo              TEXT,
			location           TEXT,
			modules            TEXT,
			skills             TEXT,
			missions           TEXT,
			queue              TEXT,
			updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
			session_id         TEXT,
			session_expires_at TEXT
		)
	`);

	db.run(`
		CREATE TABLE IF NOT EXISTS jobs (
			job_id       TEXT PRIMARY KEY,
			account_id   TEXT NOT NULL,
			submitted_at TEXT NOT NULL,
			status       TEXT NOT NULL DEFAULT 'running',
			completed_at TEXT,
			result       TEXT,
			error        TEXT
		)
	`);

	// Migrate existing databases that predate session columns
	try {
		db.run("ALTER TABLE game_state ADD COLUMN session_id TEXT");
	} catch {}
	try {
		db.run("ALTER TABLE game_state ADD COLUMN session_expires_at TEXT");
	} catch {}

	// Migrate existing databases that predate goal_type column
	try {
		db.run("ALTER TABLE jobs ADD COLUMN goal_type TEXT");
	} catch {}
	// Migrate existing databases that predate goal_options column
	try {
		db.run("ALTER TABLE jobs ADD COLUMN goal_options TEXT");
	} catch {}

	// Index the per-account job lookups (dashboard status, pending-job resume).
	// Without it, "most recent N jobs for an account" full-scans and sorts the
	// entire jobs table once per account — O(accounts × table size) on every
	// dashboard poll. The (account_id, submitted_at DESC) order serves both the
	// WHERE filter and the ORDER BY ... LIMIT without a temp b-tree sort.
	db.run(
		"CREATE INDEX IF NOT EXISTS idx_jobs_account_submitted ON jobs(account_id, submitted_at DESC)",
	);

	log.info("Database schema initialized");
	return db;
}

/**
 * Create an in-memory database (for testing).
 */
export function createMemoryDatabase(): Database {
	return createDatabase(":memory:");
}
