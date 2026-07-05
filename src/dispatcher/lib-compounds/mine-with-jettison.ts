import type { GameState } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibJettisonCargo } from "../lib-primitives/jettison-cargo.js";

const log = createLogger("goal:mine-with-jettison");

/** Options for the MineWithJettison compound goal. */
export interface MineWithJettisonOptions {
	/** Item IDs considered junk — will be jettisoned when cargo is full. */
	junkItemIds: string[];
	/**
	 * Fraction of cargo capacity at which to consider the hold "full".
	 * Range: 0.0 to 1.0. Defaults to 1.0 (completely full).
	 */
	fullThreshold?: number;
	/**
	 * Maximum total mine attempts across all rounds. Safety valve to prevent
	 * infinite loops. Defaults to 200.
	 */
	maxAttempts?: number;
	/**
	 * Maximum jettison-then-mine cycles. After this many jettison rounds,
	 * stop even if junk remains. Defaults to 3.
	 */
	maxJettisonRounds?: number;
}

/**
 * Mine until cargo is full, jettison junk items, then mine again until
 * truly full with only valuable ore.
 *
 * Algorithm:
 * 1. Mine until cargo reaches fullThreshold
 * 2. Check cargo for items in junkItemIds
 * 3. If junk found and jettisonRounds < maxJettisonRounds: jettison junk, go to 1
 * 4. If no junk found or maxJettisonRounds reached: done
 *
 * Prerequisites: must NOT be docked (must be in space at a mining location).
 */
export class LibMineWithJettison implements LibGoal {
	readonly name = "mine-with-jettison";
	private readonly options: MineWithJettisonOptions;

	constructor(options: MineWithJettisonOptions) {
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
		const maxJettisonRounds = this.options.maxJettisonRounds ?? 3;

		let ticksUsed = 0;
		let totalMined = 0;
		let jettisonRounds = 0;
		let currentState: Readonly<GameState> = ctx.state;

		// Outer loop: mine → jettison → mine again
		while (jettisonRounds <= maxJettisonRounds) {
			// Phase 1: Mine until full
			const mineResult = await this.mineUntilFull(
				ctx,
				currentState,
				threshold,
				maxAttempts - totalMined,
			);
			ticksUsed += mineResult.ticksUsed;
			totalMined += mineResult.ticksUsed;

			if (!mineResult.success) {
				return failed(`Mining failed: ${mineResult.message}`, ticksUsed);
			}

			// Read updated cargo from the push-fed cache (mutation delta already applied)
			currentState = await ctx.refreshState();

			// Phase 2: Check for junk
			const junkInCargo = this.findJunkInCargo(currentState);

			if (junkInCargo.length === 0 || jettisonRounds >= maxJettisonRounds) {
				if (junkInCargo.length > 0) {
					log.info(
						`Max jettison rounds (${maxJettisonRounds}) reached, ${junkInCargo.length} junk type(s) remain`,
					);
				}
				break;
			}

			// Phase 3: Jettison junk
			log.info(`Jettison round ${jettisonRounds + 1}: removing ${junkInCargo.length} junk type(s)`);

			for (const junkItem of junkInCargo) {
				const jettison = new LibJettisonCargo({
					itemId: junkItem.itemId,
					quantity: junkItem.quantity,
				});

				const jettisonResult = await jettison.execute(ctx);

				ticksUsed += jettisonResult.ticksUsed;

				if (!jettisonResult.success) {
					return failed(
						`Failed to jettison ${junkItem.itemId}: ${jettisonResult.message}`,
						ticksUsed,
					);
				}

				log.info(`Jettisoned: ${jettisonResult.message}`);
			}

			// Read updated cargo from the push-fed cache (jettison delta already applied)
			currentState = await ctx.refreshState();
			jettisonRounds++;

			// Check if we've hit the total mine attempt limit
			if (totalMined >= maxAttempts) {
				log.info(`Reached max total mine attempts (${maxAttempts})`);
				break;
			}
		}

		const cargoUsed = currentState.ship?.cargo_used ?? 0;
		const cargoCapacity = currentState.ship?.cargo_capacity ?? 0;

		return succeeded(
			`Mined with jettison: ${totalMined} mine attempt(s), ${jettisonRounds} jettison round(s), cargo ${cargoUsed}/${cargoCapacity}`,
			ticksUsed,
		);
	}

	private async mineUntilFull(
		ctx: LibGoalContext,
		initialState: Readonly<GameState>,
		threshold: number,
		remainingAttempts: number,
	): Promise<GoalResult> {
		let currentState = initialState;
		let ticksUsed = 0;

		if (this.isFull(currentState, threshold)) {
			return succeeded("Cargo already full", 0);
		}

		while (ticksUsed < remainingAttempts) {
			// Check for external cancellation between attempts — mining runs can
			// last hundreds of ticks, and a force abort must not wait for full cargo.
			if (ctx.signal?.aborted) {
				return failed(`Mining aborted after ${ticksUsed} attempt(s)`, ticksUsed);
			}

			log.info(
				`Mining attempt ${ticksUsed + 1} (cargo: ${currentState.ship?.cargo_used ?? 0}/${currentState.ship?.cargo_capacity ?? 0})`,
			);

			const cargoBeforeAttempt = currentState.ship?.cargo_used ?? 0;

			try {
				await ctx.account.commands.spacemolt.mine();
				ticksUsed++;
				currentState = await ctx.refreshState();
			} catch (err) {
				if (!(err instanceof SpacemoltError)) throw err;

				if (err.code === "cargo_full") {
					log.info(`Mine rejected (cargo full): ${err.message}`);
					return succeeded(`Cargo full after ${ticksUsed} attempt(s)`, ticksUsed);
				}

				if (err.code === "mutation_timeout") {
					// The ack means this mine WAS queued — only its outcome frame
					// arrived too late (or not at all) to match the mutate() call
					// still awaiting it. The push-fed cache updates from that
					// frame regardless of whether anyone was still listening for
					// it, so a live re-check can reveal the mine actually landed
					// before this attempt is written off as a failure.
					const refreshed = await ctx.refreshState({ force: true });
					if ((refreshed.ship?.cargo_used ?? 0) > cargoBeforeAttempt) {
						log.info(
							`Mine timed out but cargo increased (${cargoBeforeAttempt} -> ${refreshed.ship?.cargo_used}) — treating as a successful attempt`,
						);
						ticksUsed++;
						currentState = refreshed;
					} else {
						log.warn(`Mine rejected: ${err.message}`);
						return failed(`Mine rejected: ${err.message}`, ticksUsed);
					}
				} else {
					log.warn(`Mine rejected: ${err.message}`);
					return failed(`Mine rejected: ${err.message}`, ticksUsed);
				}
			}

			if (!currentState.ship) {
				return failed(`Ship state lost after ${ticksUsed} mine attempt(s)`, ticksUsed);
			}

			if (this.isFull(currentState, threshold)) {
				log.info(`Cargo full after ${ticksUsed} mine attempt(s)`);
				return succeeded(
					`Mined until full (${currentState.ship.cargo_used}/${currentState.ship.cargo_capacity}) in ${ticksUsed} attempt(s)`,
					ticksUsed,
				);
			}
		}

		return succeeded(
			`Reached attempt limit, cargo at ${currentState.ship?.cargo_used ?? "?"}/${currentState.ship?.cargo_capacity ?? "?"}`,
			ticksUsed,
		);
	}

	private isFull(state: Readonly<GameState>, threshold: number): boolean {
		const cargoUsed = state.ship?.cargo_used ?? 0;
		const cargoCapacity = state.ship?.cargo_capacity ?? 0;
		if (cargoCapacity === 0) {
			return true;
		}
		return cargoUsed / cargoCapacity >= threshold;
	}

	private findJunkInCargo(state: Readonly<GameState>): Array<{ itemId: string; quantity: number }> {
		const cargo = state.cargo;
		if (!cargo || cargo.length === 0) {
			return [];
		}

		const junk: Array<{ itemId: string; quantity: number }> = [];
		for (const item of cargo) {
			if (
				item.item_id &&
				this.options.junkItemIds.includes(item.item_id) &&
				(item.quantity ?? 0) > 0
			) {
				junk.push({ itemId: item.item_id, quantity: item.quantity ?? 0 });
			}
		}
		return junk;
	}
}
