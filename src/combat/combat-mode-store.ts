/**
 * Persisted per-account override for `CombatReactor`'s response strategy.
 * Accounts default to `"flee"` (setpoint's built-in `FleeCombatStrategy`); an
 * account set to `"external"` is still released from any running loop/goal
 * on combat entry (same as every account — see `forceReleaseAccount`), but
 * gets no automatic `spacemolt_battle.stance` calls, so hand-written combat
 * logic driving the ship from outside setpoint isn't fighting the daemon for
 * control of the ship mid-battle.
 *
 * Persisted to `<configDir>/combat-modes/<playerId>.json`, one file per
 * account — mirrors `LoopManager`'s loop-config persistence — so the setting
 * survives a daemon restart.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CombatMode } from "@setpoint/protocol";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("combat-mode-store");

export const DEFAULT_COMBAT_MODE: CombatMode = "flee";

function isCombatMode(value: unknown): value is CombatMode {
	return value === "flee" || value === "external";
}

export class CombatModeStore {
	private readonly modes: Map<string, CombatMode>;

	private constructor(
		entries: Array<[string, CombatMode]>,
		private readonly configDir: string,
	) {
		this.modes = new Map(entries);
	}

	/** Load all persisted combat-mode overrides from disk. */
	static async load(configDir: string): Promise<CombatModeStore> {
		const dir = join(configDir, "combat-modes");
		let filenames: string[];
		try {
			filenames = await readdir(dir);
		} catch {
			return new CombatModeStore([], configDir);
		}

		const entries: Array<[string, CombatMode]> = [];
		for (const filename of filenames) {
			if (!filename.endsWith(".json")) continue;
			const playerId = filename.replace(/\.json$/, "");
			try {
				const raw = await readFile(join(dir, filename), "utf-8");
				const data = JSON.parse(raw) as Record<string, unknown>;
				if (isCombatMode(data["mode"])) {
					entries.push([playerId, data["mode"]]);
				} else {
					log.warn(`[${playerId}] Invalid combat mode, skipping`);
				}
			} catch (err) {
				log.warn(`[${playerId}] Failed to read combat mode: ${errorMessage(err)}`);
			}
		}
		if (entries.length > 0) {
			log.info(`Loaded ${entries.length} persisted combat mode override(s)`);
		}
		return new CombatModeStore(entries, configDir);
	}

	/** The account's combat mode, or the default (`"flee"`) if never overridden. */
	get(playerId: string): CombatMode {
		return this.modes.get(playerId) ?? DEFAULT_COMBAT_MODE;
	}

	/** Set and persist an account's combat-mode override. */
	async set(playerId: string, mode: CombatMode): Promise<void> {
		this.modes.set(playerId, mode);
		const dir = join(this.configDir, "combat-modes");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${playerId}.json`), JSON.stringify({ mode }, null, 2), "utf-8");
		log.info(`[${playerId}] Combat mode set to "${mode}"`);
	}

	/** Clear an account's override, reverting it to the default (`"flee"`). */
	async clear(playerId: string): Promise<void> {
		this.modes.delete(playerId);
		try {
			await rm(join(this.configDir, "combat-modes", `${playerId}.json`));
			log.info(`[${playerId}] Combat mode override cleared`);
		} catch {
			// File may not exist, that's fine
		}
	}
}
