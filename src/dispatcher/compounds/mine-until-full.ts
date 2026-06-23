import { ApiError, SessionExpiredError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

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
}

/**
 * Mine repeatedly at the current location until cargo is full.
 *
 * Already satisfied if cargo is at or above the full threshold.
 * Prerequisites: must NOT be docked (must be in space at a mining location).
 * Requires ctx.refreshState to track cargo changes between mine calls.
 *
 * Each mine() call costs 1 tick. The goal tracks total ticks consumed.
 */
export class MineUntilFull implements Goal {
	readonly name = "mine-until-full";
	private readonly options: MineUntilFullOptions;

	constructor(options: MineUntilFullOptions = {}) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		const readLocal = ctx.readLocalState;
		const getState = readLocal ? () => Promise.resolve(readLocal()) : (ctx.refreshState ?? null);
		if (!getState) {
			return failed("MineUntilFull requires readLocalState or refreshState", 0);
		}

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
				await ctx.endpoints.mine();
				ticksUsed++;
			} catch (err) {
				if (err instanceof ApiError && !(err instanceof SessionExpiredError)) {
					// Game says cargo is full — trust the server regardless of local state.
					// This handles the case where local cargo count (e.g. 149/150) doesn't
					// hit our threshold but the game rejects the mine as full.
					if (err.code === "cargo_full") {
						log.info(`Mine rejected (cargo full): ${err.message}`);
						return succeeded(`Cargo full after ${ticksUsed} attempt(s)`, ticksUsed);
					}
					// Other game errors (not at a mine, etc.) — return as failure so the
					// loop engine can retry after re-navigating.
					log.warn(`Mine rejected: ${err.message}`);
					return failed(`Mine rejected: ${err.message}`, ticksUsed);
				}
				throw err;
			}

			currentState = await getState();

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
