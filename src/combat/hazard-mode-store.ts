/**
 * Persisted per-account hazard response — see `HazardMode` in
 * `@setpoint/protocol`. Accounts default to `"retreat"`.
 *
 * Persisted to `<configDir>/hazard-modes/<playerId>.json`, one file per
 * account, the same way `CombatModeStore` persists combat modes, so the
 * setting survives a daemon restart.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HazardMode } from "@setpoint/protocol";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("hazard-mode-store");

export const DEFAULT_HAZARD_MODE: HazardMode = "retreat";

/** An account's hazard response: the mode, and for `"tolerate"` its hull floor. */
export type HazardSetting =
	| { mode: "retreat" | "external" }
	| { mode: "tolerate"; minHullPct: number };

const DEFAULT_SETTING: HazardSetting = { mode: DEFAULT_HAZARD_MODE };

/**
 * Validate a hazard setting from untrusted input (a request body or a file on
 * disk). Returns the setting, or a message saying what is wrong.
 */
export function parseHazardSetting(value: unknown): HazardSetting | string {
	if (typeof value !== "object" || value === null) return "Body must be a JSON object";
	const { mode, minHullPct } = value as Record<string, unknown>;
	if (mode === "retreat" || mode === "external") {
		if (minHullPct !== undefined) return `minHullPct only applies to "tolerate"`;
		return { mode };
	}
	if (mode === "tolerate") {
		if (
			typeof minHullPct !== "number" ||
			!Number.isFinite(minHullPct) ||
			minHullPct < 0 ||
			minHullPct > 100
		) {
			return `"tolerate" needs minHullPct, a number from 0 to 100`;
		}
		return { mode, minHullPct };
	}
	return 'mode must be "retreat", "tolerate" or "external"';
}

export class HazardModeStore {
	private readonly settings: Map<string, HazardSetting>;

	private constructor(
		entries: Array<[string, HazardSetting]>,
		private readonly configDir: string,
	) {
		this.settings = new Map(entries);
	}

	/** Load all persisted hazard settings from disk. */
	static async load(configDir: string): Promise<HazardModeStore> {
		const dir = join(configDir, "hazard-modes");
		let filenames: string[];
		try {
			filenames = await readdir(dir);
		} catch {
			return new HazardModeStore([], configDir);
		}

		const entries: Array<[string, HazardSetting]> = [];
		for (const filename of filenames) {
			if (!filename.endsWith(".json")) continue;
			const playerId = filename.replace(/\.json$/, "");
			try {
				const parsed = parseHazardSetting(JSON.parse(await readFile(join(dir, filename), "utf-8")));
				if (typeof parsed === "string") {
					log.warn(`[${playerId}] Invalid hazard mode (${parsed}), skipping`);
				} else {
					entries.push([playerId, parsed]);
				}
			} catch (err) {
				log.warn(`[${playerId}] Failed to read hazard mode: ${errorMessage(err)}`);
			}
		}
		if (entries.length > 0) {
			log.info(`Loaded ${entries.length} persisted hazard mode override(s)`);
		}
		return new HazardModeStore(entries, configDir);
	}

	/** The account's hazard setting, or the default (`"retreat"`) if never set. */
	get(playerId: string): HazardSetting {
		return this.settings.get(playerId) ?? DEFAULT_SETTING;
	}

	/** Set and persist an account's hazard setting. */
	async set(playerId: string, setting: HazardSetting): Promise<void> {
		this.settings.set(playerId, setting);
		const dir = join(this.configDir, "hazard-modes");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${playerId}.json`), JSON.stringify(setting, null, 2), "utf-8");
		log.info(
			`[${playerId}] Hazard mode set to "${setting.mode}"${setting.mode === "tolerate" ? ` (retreat below ${setting.minHullPct}% hull)` : ""}`,
		);
	}

	/** Clear an account's setting, reverting it to the default (`"retreat"`). */
	async clear(playerId: string): Promise<void> {
		this.settings.delete(playerId);
		try {
			await rm(join(this.configDir, "hazard-modes", `${playerId}.json`));
		} catch {
			// Already absent.
		}
	}
}
