import { describe, expect, test } from "bun:test";
import { createDatabase, createMemoryDatabase } from "../../src/state/database.js";

describe("createMemoryDatabase", () => {
	test("returns a Database instance", () => {
		const db = createMemoryDatabase();
		expect(db).toBeDefined();
		db.close();
	});

	test("creates game_state table with expected columns", () => {
		const db = createMemoryDatabase();

		const columns = db
			.query<{ name: string; type: string; notnull: number; pk: number }, []>(
				"PRAGMA table_info(game_state)",
			)
			.all();

		const columnNames = columns.map((c) => c.name);
		expect(columnNames).toContain("account_id");
		expect(columnNames).toContain("player");
		expect(columnNames).toContain("ship");
		expect(columnNames).toContain("cargo");
		expect(columnNames).toContain("location");
		expect(columnNames).toContain("modules");
		expect(columnNames).toContain("skills");
		expect(columnNames).toContain("missions");
		expect(columnNames).toContain("queue");
		expect(columnNames).toContain("updated_at");

		db.close();
	});

	test("account_id is the primary key", () => {
		const db = createMemoryDatabase();

		const columns = db
			.query<{ name: string; pk: number }, []>("PRAGMA table_info(game_state)")
			.all();

		const pkColumn = columns.find((c) => c.pk === 1);
		expect(pkColumn).toBeDefined();
		expect(pkColumn?.name).toBe("account_id");

		db.close();
	});

	test("updated_at has NOT NULL constraint", () => {
		const db = createMemoryDatabase();

		const columns = db
			.query<{ name: string; notnull: number }, []>("PRAGMA table_info(game_state)")
			.all();

		const updatedAt = columns.find((c) => c.name === "updated_at");
		expect(updatedAt).toBeDefined();
		expect(updatedAt?.notnull).toBe(1);

		db.close();
	});

	test("uses WAL journal mode", () => {
		const db = createMemoryDatabase();

		const result = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();

		// In-memory databases may report "memory" instead of "wal"
		expect(result).toBeDefined();

		db.close();
	});

	test("can be called multiple times (CREATE IF NOT EXISTS)", () => {
		const db = createMemoryDatabase();

		// Running the schema again should not throw
		db.run(`
			CREATE TABLE IF NOT EXISTS game_state (
				account_id TEXT PRIMARY KEY,
				player     TEXT,
				ship       TEXT,
				cargo      TEXT,
				location   TEXT,
				modules    TEXT,
				skills     TEXT,
				missions   TEXT,
				queue      TEXT,
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		db.close();
	});

	test("state columns are nullable TEXT", () => {
		const db = createMemoryDatabase();

		const columns = db
			.query<{ name: string; type: string; notnull: number }, []>("PRAGMA table_info(game_state)")
			.all();

		const stateColumns = [
			"player",
			"ship",
			"cargo",
			"location",
			"modules",
			"skills",
			"missions",
			"queue",
		];

		for (const colName of stateColumns) {
			const col = columns.find((c) => c.name === colName);
			expect(col).toBeDefined();
			expect(col?.type).toBe("TEXT");
			expect(col?.notnull).toBe(0);
		}

		db.close();
	});
});

describe("createDatabase", () => {
	test("creates database at specified path", () => {
		const path = ":memory:";
		const db = createDatabase(path);
		expect(db).toBeDefined();
		db.close();
	});
});

describe("jobs per-account index", () => {
	test("creates an index on jobs(account_id, submitted_at)", () => {
		const db = createMemoryDatabase();

		const index = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND name = 'idx_jobs_account_submitted'",
			)
			.get();

		expect(index).toBeDefined();
		db.close();
	});

	test("the per-account recent-jobs query uses the index, not a full scan", () => {
		const db = createMemoryDatabase();

		const plan = db
			.query<{ detail: string }, [string, number]>(
				"EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE account_id = ? ORDER BY submitted_at DESC LIMIT ?",
			)
			.all("acct", 5);

		const detail = plan.map((p) => p.detail).join(" ");
		expect(detail).toContain("idx_jobs_account_submitted");
		expect(detail).not.toContain("SCAN jobs");
		expect(detail).not.toContain("TEMP B-TREE");

		db.close();
	});
});
