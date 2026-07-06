import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import type { LocationWaitOptions } from "../wait-for-location.js";
import { waitForLocation } from "../wait-for-location.js";

const log = createLogger("goal:mine-until-full");

/** Options for the MineUntilFull compound goal. */
export interface MineUntilFullOptions {
	/**
	 * Fraction of cargo capacity at which to consider the hold "full".
	 * Range: 0.0 to 1.0. Defaults to 1.0 (completely full).
	 */
	fullThreshold?: number;
	/**
	 * Maximum mine attempts before stopping. Safety valve to prevent
	 * infinite loops. Defaults to 200.
	 */
	maxAttempts?: number;
	/** Tuning for how long to wait out a mid-travel rejection before failing. */
	waitOpts?: LocationWaitOptions;
}

/**
 * Mine repeatedly at the current location until cargo is full.
 *
 * Already satisfied if cargo is at or above the full threshold.
 * Prerequisites: must NOT be docked (must be in space at a mining location).
 *
 * Each mine() call costs 1 tick. The goal tracks total ticks consumed.
 */
export class LibMineUntilFull implements LibGoal {
	readonly name = "mine-until-full";
	private readonly options: MineUntilFullOptions;

	constructor(options: MineUntilFullOptions = {}) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (ctx.state.location?.docked_at) {
			return failed("Cannot mine while docked", 0);
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

		let ticksUsed = 0;
		let currentState = ctx.state;

		while (ticksUsed < maxAttempts) {
			// Check for external cancellation between attempts — mining runs can
			// last hundreds of ticks, and a force abort must not wait for full cargo.
			if (ctx.signal?.aborted) {
				return failed(`Mining aborted after ${ticksUsed} attempt(s)`, ticksUsed);
			}

			log.info(
				`Mining attempt ${ticksUsed + 1} (cargo: ${currentState.ship?.cargo_used ?? 0}/${currentState.ship?.cargo_capacity ?? 0})`,
			);

			try {
				await ctx.account.commands.spacemolt.mine();
				ticksUsed++;
			} catch (err) {
				if (!(err instanceof SpacemoltError)) throw err;

				// Game says cargo is full — trust the server regardless of local state.
				// This handles the case where local cargo count (e.g. 149/150) doesn't
				// hit our threshold but the game rejects the mine as full.
				if (err.code === "cargo_full") {
					log.info(`Mine rejected (cargo full): ${err.message}`);
					return succeeded(`Cargo full after ${ticksUsed} attempt(s)`, ticksUsed);
				}

				// A prior travel() can resolve successfully before the ship has
				// actually arrived, so mine() can still be rejected as mid-transit
				// even after the travel step reported success. Wait it out and
				// retry once instead of failing the whole run on what the server
				// itself says is a transient, resolving condition.
				const fresh = await ctx.refreshState({ force: true });
				if (!fresh.location?.in_transit) {
					log.warn(`Mine rejected: ${err.message}`);
					return failed(`Mine rejected: ${err.message}`, ticksUsed);
				}

				log.info("Mine rejected mid-transit — waiting for arrival before retrying");
				const settled = await waitForLocation(
					ctx,
					(s) => !s.location?.in_transit,
					this.options.waitOpts,
				);
				if (settled.location?.in_transit) {
					log.warn(`Mine rejected: ${err.message}`);
					return failed(`Mine rejected: ${err.message}`, ticksUsed);
				}

				try {
					await ctx.account.commands.spacemolt.mine();
					ticksUsed++;
				} catch (retryErr) {
					const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
					log.warn(`Mine rejected on retry: ${msg}`);
					return failed(`Mine rejected: ${msg}`, ticksUsed);
				}
			}

			// The mine delta has been applied to the push-fed cache, so the fresh
			// cargo level is readable via ctx.state without an extra query.
			currentState = await ctx.refreshState();

			const currentShip = currentState.ship;
			if (!currentShip) {
				return failed(`Ship state lost after ${ticksUsed} mine attempt(s)`, ticksUsed);
			}

			if (this.isFull(currentShip.cargo_used ?? 0, currentShip.cargo_capacity ?? 0, threshold)) {
				log.info(`Cargo full after ${ticksUsed} mine attempt(s)`);
				return succeeded(
					`Mined until cargo full (${currentShip.cargo_used}/${currentShip.cargo_capacity}) in ${ticksUsed} attempt(s)`,
					ticksUsed,
				);
			}
		}

		return succeeded(
			`Reached max attempts (${maxAttempts}), cargo at ${currentState.ship?.cargo_used ?? "?"}/${currentState.ship?.cargo_capacity ?? "?"}`,
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
