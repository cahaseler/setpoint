import { ApiError, SessionExpiredError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:loot-until-full");

/** Options for the LootUntilFull compound goal. */
export interface LootUntilFullOptions {
	/**
	 * Fraction of cargo capacity at which to consider the hold "full".
	 * Range: 0.0 to 1.0. Defaults to 1.0 (completely full).
	 */
	fullThreshold?: number;
	/**
	 * Maximum loot attempts before stopping. Safety valve to prevent
	 * infinite loops. Defaults to 200.
	 */
	maxAttempts?: number;
}

/**
 * Loot all available wrecks at the current location until cargo is full.
 *
 * Already satisfied if cargo is at or above the full threshold.
 * Prerequisites: must NOT be docked (must be in space at a salvage location).
 * Requires ctx.refreshState to track cargo changes between loot calls.
 *
 * Queries available wrecks first and skips any with empty cargo lists.
 * Iterates through each wreck, calling loot() until wreck_empty or cargo full.
 * Each loot() call costs 1 tick.
 */
export class LootUntilFull implements Goal {
	readonly name = "loot-until-full";
	private readonly options: LootUntilFullOptions;

	constructor(options: LootUntilFullOptions = {}) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		const readLocal = ctx.readLocalState;
		const getState = readLocal ? () => Promise.resolve(readLocal()) : (ctx.refreshState ?? null);
		if (!getState) {
			return failed("LootUntilFull requires readLocalState or refreshState", 0);
		}

		if (ctx.state.location?.docked_at) {
			return failed("Cannot loot while docked", 0);
		}

		const ship = ctx.state.ship;
		if (!ship) {
			return failed("Ship state unknown", 0);
		}

		const threshold = this.options.fullThreshold ?? 1.0;
		const maxAttempts = this.options.maxAttempts ?? 200;

		if (this.isFull(ship.cargo_used ?? 0, ship.cargo_capacity ?? 0, threshold)) {
			return alreadySatisfied("Cargo is already full");
		}

		// Get available wrecks and filter to those with cargo
		const wrecksResult = await ctx.endpoints.getWrecks();
		const allWrecks = wrecksResult.structuredContent.wrecks;
		const targetWrecks = allWrecks.filter((w) => w.cargo && w.cargo.length > 0);

		if (targetWrecks.length === 0) {
			return succeeded("No wrecks with cargo found", 0);
		}

		log.info(`Found ${targetWrecks.length} wreck(s) with cargo`);

		let ticksUsed = 0;
		let currentState = ctx.state;

		for (const wreck of targetWrecks) {
			while (ticksUsed < maxAttempts) {
				// Check for external cancellation between attempts — looting runs can
				// last many ticks, and a force abort must not wait for full cargo.
				if (ctx.signal?.aborted) {
					return failed(`Looting aborted after ${ticksUsed} attempt(s)`, ticksUsed);
				}

				log.info(
					`Looting wreck ${wreck.id} (cargo: ${currentState.ship?.cargo_used ?? 0}/${currentState.ship?.cargo_capacity ?? 0})`,
				);

				let wreckEmpty = false;
				try {
					const lootResult = await ctx.endpoints.lootWreck(wreck.id);
					ticksUsed++;
					wreckEmpty = lootResult.structuredContent.wreck_empty;
				} catch (err) {
					if (err instanceof ApiError && !(err instanceof SessionExpiredError)) {
						if (err.code === "cargo_full") {
							log.info(`Loot rejected (cargo full): ${err.message}`);
							return succeeded(`Cargo full after ${ticksUsed} loot attempt(s)`, ticksUsed);
						}
						log.warn(`Loot failed: ${err.message}`);
						return failed(`Loot failed: ${err.message}`, ticksUsed);
					}
					throw err;
				}

				currentState = await getState();
				const currentShip = currentState.ship;

				if (!currentShip) {
					return failed(`Ship state lost after ${ticksUsed} loot attempt(s)`, ticksUsed);
				}

				if (this.isFull(currentShip.cargo_used ?? 0, currentShip.cargo_capacity ?? 0, threshold)) {
					log.info(`Cargo full after ${ticksUsed} loot attempt(s)`);
					return succeeded(
						`Looted until cargo full (${currentShip.cargo_used}/${currentShip.cargo_capacity}) in ${ticksUsed} attempt(s)`,
						ticksUsed,
					);
				}

				if (wreckEmpty) {
					log.info(`Wreck ${wreck.id} empty, moving to next`);
					break;
				}
			}
		}

		return succeeded(
			`Looted all available wrecks in ${ticksUsed} attempt(s) (cargo: ${currentState.ship?.cargo_used ?? "?"}/${currentState.ship?.cargo_capacity ?? "?"})`,
			ticksUsed,
		);
	}

	private isFull(cargoUsed: number, cargoCapacity: number, threshold: number): boolean {
		if (cargoCapacity === 0) {
			return true;
		}
		return cargoUsed / cargoCapacity >= threshold;
	}
}
