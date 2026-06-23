import { ApiError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:ensure-fueled");

/** Milliseconds to wait between retries when a station has limited fuel supply. */
const SUPPLY_RETRY_DELAY_MS = 60_000;

/** Maximum number of retries when the station fuel supply is limited (60 = ~1 hour). */
const MAX_SUPPLY_RETRIES = 60;

/**
 * Ensure the ship has at least the target amount of fuel.
 *
 * If no target is specified, fills to max fuel.
 * Already satisfied if current fuel >= target fuel.
 * Prerequisites: must be docked at a station.
 *
 * Handles stations with limited fuel supply: if the refuel call returns less
 * than the requested amount, waits SUPPLY_RETRY_DELAY_MS and retries until
 * the tank is filled, the signal is aborted, or MAX_SUPPLY_RETRIES is reached.
 * Uses fuel_now from the RefuelResponse to detect partial fills without an
 * extra get_state call.
 */
export class EnsureFueled implements Goal {
	readonly name = "ensure-fueled";
	private readonly targetFuel: number | undefined;
	private readonly supplyRetryDelayMs: number;

	/**
	 * @param targetFuel Minimum fuel level desired. If undefined, fills to max.
	 * @param supplyRetryDelayMs Milliseconds to wait between retries when the station
	 *   has limited fuel supply. Defaults to SUPPLY_RETRY_DELAY_MS (60s). Pass a smaller
	 *   value in tests.
	 */
	constructor(targetFuel?: number, supplyRetryDelayMs = SUPPLY_RETRY_DELAY_MS) {
		this.targetFuel = targetFuel;
		this.supplyRetryDelayMs = supplyRetryDelayMs;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		const currentFuel = ctx.state.ship?.fuel;
		const maxFuel = ctx.state.ship?.max_fuel;

		if (currentFuel === undefined || maxFuel === undefined) {
			return failed("Cannot refuel: ship state unknown", 0);
		}

		const target = this.targetFuel ?? maxFuel;

		if (currentFuel >= target) {
			return alreadySatisfied(`Fuel already at ${currentFuel}/${maxFuel} (target: ${target})`);
		}

		if (!ctx.state.location?.docked_at) {
			return failed("Cannot refuel: must be docked at a station", 0);
		}

		let ticksUsed = 0;
		let actualFuel = currentFuel;

		for (let attempt = 0; attempt <= MAX_SUPPLY_RETRIES; attempt++) {
			if (ctx.signal?.aborted) break;

			const needed = target - actualFuel;
			if (needed <= 0) break;

			log.info(
				`Refueling: ${actualFuel}/${maxFuel} → target ${target} (need ${needed}${attempt > 0 ? `, retry ${attempt}` : ""})`,
			);

			let response: Awaited<ReturnType<typeof ctx.endpoints.refuel>>;
			try {
				response = await ctx.endpoints.refuel(needed);
				ticksUsed++;
			} catch (err) {
				if (err instanceof ApiError && err.code === "tank_full") {
					return alreadySatisfied("Tank already full");
				}
				// Hard-fail only for errors that indicate a bug in our code.
				// Anything else (most commonly insufficient credits) is a soft failure:
				// log a warning and continue with current fuel. The NavigateToSystem
				// pre-flight check will block departure if the resulting fuel level is
				// truly insufficient for the next trip.
				const isBugError =
					err instanceof ApiError &&
					(err.code === "invalid_params" ||
						err.code === "unknown_command" ||
						err.code === "missing_action" ||
						err.code === "invalid_json");
				if (err instanceof ApiError && !isBugError) {
					log.warn(
						`Refuel skipped (${err.code}: ${err.message}); continuing with ${actualFuel}/${maxFuel} fuel`,
					);
					return succeeded(
						`Refuel skipped (${err.code}: ${err.message}); current fuel ${actualFuel}/${maxFuel}`,
						ticksUsed,
					);
				}
				throw err;
			}

			// Check how much fuel we actually received. fuel_now in the response
			// reflects the actual post-refuel level; use it to detect partial fills
			// caused by limited station supply without an extra get_state call.
			const fuelNow = response.structuredContent.fuel_now;
			actualFuel = fuelNow ?? target; // if fuel_now absent, assume success

			if (actualFuel >= target) break;

			// Station supply was exhausted before we could fill up — wait for resupply.
			if (attempt < MAX_SUPPLY_RETRIES) {
				log.info(
					`Station fuel supply limited (got to ${actualFuel}/${target}), waiting ${this.supplyRetryDelayMs / 1000}s for resupply...`,
				);
				await new Promise<void>((resolve) => {
					if (ctx.signal?.aborted) {
						resolve();
						return;
					}
					const timer = setTimeout(resolve, this.supplyRetryDelayMs);
					ctx.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
			}
		}

		if (actualFuel >= target) {
			return succeeded(`Refueled (${actualFuel}/${maxFuel})`, ticksUsed);
		}

		// Partial fill after retries — station supply still limited or signal aborted.
		// Proceed with what we have; NavigateToSystem pre-flight guards departure.
		log.warn(`Partial refuel: station supply limited, got ${actualFuel}/${target}`);
		return succeeded(
			`Partial refuel (station supply limited): ${actualFuel}/${maxFuel}`,
			ticksUsed,
		);
	}
}
