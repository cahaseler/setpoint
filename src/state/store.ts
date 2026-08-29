import type { Database } from "bun:sqlite";
import type { V2GameState } from "@spacemolt/lib";
import { createLogger } from "../util/logger.js";

const log = createLogger("state-store");

/** The state sections present in V2GameState that we track. */
type V2GameStateSectionKey =
	| "player"
	| "ship"
	| "cargo"
	| "location"
	| "modules"
	| "skills"
	| "missions"
	| "queue";

/** The state sections that can be individually updated (includes legacy sections stored separately). */
export type StateSectionKey =
	| "player"
	| "ship"
	| "cargo"
	| "location"
	| "modules"
	| "skills"
	| "missions"
	| "queue";

const V2_STATE_SECTION_KEYS: V2GameStateSectionKey[] = [
	"player",
	"ship",
	"cargo",
	"location",
	"modules",
	"skills",
	"missions",
	"queue",
];

export const STATE_SECTION_KEYS: readonly StateSectionKey[] = [
	"player",
	"ship",
	"cargo",
	"location",
	"modules",
	"skills",
	"missions",
	"queue",
];

/** Full game state for an account, reconstructed from stored sections. */
export interface StoredGameState {
	player: V2GameState["player"] | undefined;
	ship: V2GameState["ship"] | undefined;
	cargo: V2GameState["cargo"] | undefined;
	location: V2GameState["location"] | undefined;
	/** Installed modules data (queried separately via get_ship or install_mod responses). */
	modules: unknown;
	/** Player skills data (queried separately via get_skills). */
	skills: unknown;
	/** Active missions data (queried separately via get_active_missions). */
	missions: unknown;
	/** Action queue data (queried separately via get_queue). */
	queue: unknown;
	updatedAt: string;
}

/** Row shape from the database. */
interface StateRow {
	account_id: string;
	player: string | null;
	ship: string | null;
	cargo: string | null;
	location: string | null;
	modules: string | null;
	skills: string | null;
	missions: string | null;
	queue: string | null;
	updated_at: string;
}

/**
 * Per-account game state store backed by SQLite.
 *
 * Supports partial updates: when the API returns a V2GameState with only
 * some sections populated, only those sections are updated in the database.
 * Sections not present in the update are left unchanged.
 */
export class StateStore {
	private readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	/** Get the full game state for an account, or undefined if no state exists. */
	getState(accountId: string): StoredGameState | undefined {
		const row = this.db
			.query<StateRow, [string]>("SELECT * FROM game_state WHERE account_id = ?")
			.get(accountId);

		if (!row) {
			return undefined;
		}

		return this.rowToState(row);
	}

	/** Get a single state section for an account. */
	getSection<K extends StateSectionKey>(
		accountId: string,
		section: K,
	): StoredGameState[K] | undefined {
		const row = this.db
			.query<Pick<StateRow, "account_id"> & Record<string, string | null>, [string]>(
				`SELECT ${section} FROM game_state WHERE account_id = ?`,
			)
			.get(accountId);

		if (!row) {
			return undefined;
		}

		const raw = row[section] as string | null;
		if (raw === null) {
			return undefined;
		}

		return JSON.parse(raw) as StoredGameState[K];
	}

	/**
	 * Apply a partial game state update for an account.
	 *
	 * Only sections present (non-undefined) in the update are written.
	 * Returns the list of sections that were actually updated.
	 */
	applyUpdate(accountId: string, state: V2GameState): StateSectionKey[] {
		const updatedSections: StateSectionKey[] = [];
		const setClauses: string[] = [];
		const values: unknown[] = [];

		for (const key of V2_STATE_SECTION_KEYS) {
			const value = state[key];
			// Skip null/undefined: some query responses (e.g. get_cargo) return ship: null
			// for sections not relevant to that query. Treating null as a valid update
			// would clobber good existing state in the database.
			if (value !== undefined && (value as unknown) !== null) {
				updatedSections.push(key);
				setClauses.push(`${key} = ?`);
				values.push(JSON.stringify(value));
			}
		}

		if (updatedSections.length === 0) {
			return [];
		}

		// Always update the timestamp
		setClauses.push("updated_at = datetime('now')");

		// Upsert: insert if not exists, update if exists
		const existing = this.db
			.query<{ account_id: string }, [string]>(
				"SELECT account_id FROM game_state WHERE account_id = ?",
			)
			.get(accountId);

		if (existing) {
			const sql = `UPDATE game_state SET ${setClauses.join(", ")} WHERE account_id = ?`;
			values.push(accountId);
			this.db.run(sql, values as (string | number | null)[]);
		} else {
			// Build INSERT with only the sections we have
			const columns = ["account_id", ...updatedSections, "updated_at"];
			const placeholders = columns.map((col) => (col === "updated_at" ? "datetime('now')" : "?"));
			const sql = `INSERT INTO game_state (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
			this.db.run(sql, [accountId, ...values] as (string | number | null)[]);
		}

		log.debug(`Updated state for ${accountId}: ${updatedSections.join(", ")}`);
		return updatedSections;
	}

	/**
	 * Remap skill IDs in the stored skills object for an account.
	 *
	 * Skills are stored as `{ [skill_id: string]: number }`. This replaces any
	 * key that appears in the mapping with its new value, preserving the level.
	 * Returns the list of changes made; an empty list means nothing was changed.
	 */
	migrateSkillIds(
		accountId: string,
		mapping: Record<string, string>,
	): { changed: boolean; changes: Array<{ from: string; to: string }> } {
		const row = this.db
			.query<{ skills: string | null }, [string]>(
				"SELECT skills FROM game_state WHERE account_id = ?",
			)
			.get(accountId);

		if (!row || row.skills === null) {
			return { changed: false, changes: [] };
		}

		const skills = JSON.parse(row.skills) as Record<string, unknown>;
		const changes: Array<{ from: string; to: string }> = [];
		const migrated: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(skills)) {
			const newKey = mapping[key] ?? key;
			if (newKey !== key) {
				changes.push({ from: key, to: newKey });
			}
			migrated[newKey] = value;
		}

		if (changes.length === 0) {
			return { changed: false, changes: [] };
		}

		this.db.run(
			"UPDATE game_state SET skills = ?, updated_at = datetime('now') WHERE account_id = ?",
			[JSON.stringify(migrated), accountId],
		);

		log.debug(
			`Migrated skill IDs for ${accountId}: ${changes.map((c) => `${c.from}→${c.to}`).join(", ")}`,
		);
		return { changed: true, changes };
	}

	/** Delete all state for an account. */
	deleteState(accountId: string): void {
		this.db.run("DELETE FROM game_state WHERE account_id = ?", [accountId]);
		log.debug(`Deleted state for ${accountId}`);
	}

	/** Get all account IDs that have stored state. */
	getAllAccountIds(): string[] {
		const rows = this.db
			.query<{ account_id: string }, []>("SELECT account_id FROM game_state")
			.all();
		return rows.map((row) => row.account_id);
	}

	private rowToState(row: StateRow): StoredGameState {
		return {
			player: this.parseJson(row.player),
			ship: this.parseJson(row.ship),
			cargo: this.parseJson(row.cargo),
			location: this.parseJson(row.location),
			modules: this.parseJson(row.modules),
			skills: this.parseJson(row.skills),
			missions: this.parseJson(row.missions),
			queue: this.parseJson(row.queue),
			updatedAt: row.updated_at,
		};
	}

	private parseJson<T>(raw: string | null): T | undefined {
		if (raw === null) {
			return undefined;
		}
		return JSON.parse(raw) as T;
	}
}
