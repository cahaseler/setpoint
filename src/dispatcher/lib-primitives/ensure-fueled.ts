import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:ensure-fueled");

/** Milliseconds to wait between retries when a station has limited fuel supply. */
const SUPPLY_RETRY_DELAY_MS = 60_000;

/** Maximum number of retries when the station fuel supply is limited (60 = ~1 hour). */
const MAX_SUPPLY_RETRIES = 60;

/**
 * Ensure the ship has at least the target amount of fuel.
 *
 * If no target is specified, fills to max fuel. Already satisfied if current
 * fuel >= target. Prerequisites: must be docked at a station.
 *
 * Post-refuel fuel is read from the push-fed cache (`account.state.ship.fuel`)
 * rather than a response field — the refuel delta is applied to the cache before
 * the mutation promise resolves.
 */
export class LibEnsureFueled implements LibGoal {
	readonly name = "ensure-fueled";
	private readonly targetFuel: number | undefined;
	private readonly supplyRetryDelayMs: number;

	constructor(targetFuel?: number, supplyRetryDelayMs = SUPPLY_RETRY_DELAY_MS) {
		this.targetFuel = targetFuel;
		this.supplyRetryDelayMs = supplyRetryDelayMs;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
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

			try {
				await ctx.account.commands.spacemolt.refuel({ quantity: needed });
				ticksUsed++;
			} catch (err) {
				if (err instanceof SpacemoltError && err.code === "tank_full") {
					return alreadySatisfied("Tank already full");
				}
				// Hard-fail only for errors that indicate a bug in our code. Anything
				// else (most commonly insufficient credits) is a soft failure: log and
				// continue with current fuel. NavigateToSystem's pre-flight check blocks
				// departure if the resulting fuel level is truly insufficient.
				const isBugError =
					err instanceof SpacemoltError &&
					(err.code === "invalid_params" ||
						err.code === "unknown_command" ||
						err.code === "missing_action" ||
						err.code === "invalid_json");
				if (err instanceof SpacemoltError && !isBugError) {
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

			// The refuel delta has been applied to the push-fed cache, so the fresh
			// fuel level is readable from account.state without an extra query.
			// VERIFY LIVE: station (credit) refuel fills the tank to full and ignores
			// `quantity`; fuel-cell refuel may partial-fill, which drives the retry below.
			actualFuel = ctx.account.state.ship?.fuel ?? target;

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

		log.warn(`Partial refuel: station supply limited, got ${actualFuel}/${target}`);
		return succeeded(
			`Partial refuel (station supply limited): ${actualFuel}/${maxFuel}`,
			ticksUsed,
		);
	}
}
