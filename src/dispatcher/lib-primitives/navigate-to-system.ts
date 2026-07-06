import { ConnectionClosedError, SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import type { LocationWaitOptions } from "../wait-for-location.js";
import { waitForLocation } from "../wait-for-location.js";

const log = createLogger("goal:navigate-to-system");

/**
 * Navigate to a target system via multi-hop jumps.
 *
 * Uses find_route to plan the path (free query), then jumps each hop
 * sequentially. Each jump consumes one tick (~10s). Does NOT refuel en route;
 * a single pre-flight check verifies the whole route fits in the current tank
 * (plus an optional fuelReserve buffer) and fails before the first jump.
 *
 * Already satisfied if already in the target system. Prerequisites: none.
 *
 * @param fuelReserve Fuel units to keep beyond the route's estimated cost.
 * @param waitOpts Tuning for how long to wait out an unresolved position (mid-transit) before failing. Defaults are production-sane; overridable mainly for tests.
 */
export class LibNavigateToSystem implements LibGoal {
	readonly name = "navigate-to-system";
	private readonly targetSystemId: string;
	private readonly fuelReserve: number;
	private readonly waitOpts: LocationWaitOptions;

	constructor(targetSystemId: string, fuelReserve = 0, waitOpts: LocationWaitOptions = {}) {
		this.targetSystemId = targetSystemId;
		this.fuelReserve = fuelReserve;
		this.waitOpts = waitOpts;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		// Refresh state before routing to avoid a stale location after a failed prior
		// attempt. Non-forced: the push-fed cache is force-synced at the end of every
		// navigation (below), so a free read here is accurate.
		let state = await ctx.refreshState();
		let currentSystemId = state.location?.system_id;

		if (currentSystemId === this.targetSystemId) {
			// Known limitation: doesn't check in_transit here, so a ship whose stale
			// cached system_id still equals the target while it's actually mid-jump
			// away from it would be misreported as already satisfied.
			return alreadySatisfied(`Already in system ${this.targetSystemId}`);
		}

		if (!currentSystemId || state.location?.in_transit) {
			// Unknown position (or an explicit in_transit flag, even if system_id
			// still reads as the stale pre-jump value) most commonly means
			// mid-transit from a jump that hasn't settled yet — the game itself
			// says to wait it out and resubmit; waiting here does that without a
			// fresh submission racing the still-in-flight one.
			log.info("Current system unknown or mid-transit — waiting for it to resolve");
			state = await waitForLocation(
				ctx,
				(s) => s.location?.system_id !== undefined && !s.location.in_transit,
				this.waitOpts,
			);
			currentSystemId = state.location?.system_id;

			if (currentSystemId === this.targetSystemId) {
				return alreadySatisfied(`Already in system ${this.targetSystemId}`);
			}
			if (!currentSystemId || state.location?.in_transit) {
				return failed("Cannot navigate: still mid-transit or current system unknown", 0);
			}
		}

		// Undock before jumping — the game API rejects jump while docked.
		let undockTicks = 0;
		if (state.location?.docked_at) {
			log.info(`Undocking before jump (docked at ${state.location.docked_at})`);
			await ctx.account.commands.spacemolt.undock();
			undockTicks = 1;
		}

		const result = await this.jumpRoute(ctx, currentSystemId, undockTicks, false, 10);
		// Sync position after navigation. Jumps may return a delta that does not carry
		// V2GameState location, so the cache can lag the actual position after a route.
		// Force a live read so the next goal sees the true arrival system.
		// VERIFY LIVE: if jump's MutationResult.delta carries `location`, this forced
		// refresh is redundant and can be dropped in Phase 4.
		if (result.ticksUsed > 0) {
			await ctx.refreshState({ force: true });
		}
		return result;
	}

	private async jumpRoute(
		ctx: LibGoalContext,
		fromSystemId: string,
		ticksUsedSoFar: number,
		transientRerouted: boolean,
		apiReroutesLeft: number,
	): Promise<GoalResult> {
		// Plan the route (free query, no tick cost)
		log.info(`Planning route from ${fromSystemId} to ${this.targetSystemId}`);
		const routeResponse = await ctx.account.commands.spacemolt.find_route({
			id: this.targetSystemId,
		});
		const route = routeResponse.structuredContent;

		if (!route || !route.found || !route.route || route.route.length === 0) {
			return failed(
				`No route found to system ${this.targetSystemId}: ${route?.message ?? "no route data"}`,
				ticksUsedSoFar,
			);
		}

		// Pre-flight fuel check: fail before the first jump rather than stranding
		// mid-route. fuelReserve keeps a buffer beyond the jump cost.
		const fuelNeeded = route.estimated_fuel + this.fuelReserve;
		if (fuelNeeded > route.fuel_available) {
			const reserveNote = this.fuelReserve > 0 ? ` (incl. ${this.fuelReserve} reserve)` : "";
			return failed(
				`Insufficient fuel to reach ${this.targetSystemId}: need ${fuelNeeded}${reserveNote}, have ${route.fuel_available}`,
				ticksUsedSoFar,
			);
		}

		const hops = route.route;
		let ticksUsed = ticksUsedSoFar;

		for (let i = 0; i < hops.length; i++) {
			const hop = hops[i];
			if (!hop) continue;

			const hopSystemId = hop.system_id;

			// Skip current system (route may include it as the first entry)
			if (hopSystemId === fromSystemId && i === 0) {
				continue;
			}

			// Check for external cancellation between jumps — multi-hop routes can run
			// for minutes, and a force abort must not wait for the full route.
			if (ctx.signal?.aborted) {
				return failed(
					`Navigation to ${this.targetSystemId} aborted after ${ticksUsed} tick(s)`,
					ticksUsed,
				);
			}

			log.info(
				`Jumping to ${hopSystemId} (hop ${ticksUsed - ticksUsedSoFar + 1}/${route.total_jumps})`,
			);
			try {
				await ctx.account.commands.spacemolt.jump({ id: hopSystemId });
				ticksUsed++;
			} catch (err) {
				const isApiError = err instanceof SpacemoltError;
				const isTransient = err instanceof ConnectionClosedError;

				// SpacemoltErrors carry definitive position info from the game server (e.g.
				// "You are already in X"). Allow up to apiReroutesLeft reroutes. Transient
				// errors (dropped socket) may have executed server-side; reroute once to
				// check actual position, then stop to avoid infinite retries.
				const canReroute =
					(isApiError && apiReroutesLeft > 0) || (isTransient && !transientRerouted);

				if (canReroute) {
					log.warn(
						`Jump to ${hopSystemId} failed (${err instanceof Error ? err.message : String(err)}), re-planning from actual position`,
					);
					// Force a live read: jumps carry no reliable position in the cache, so
					// re-planning from the stale origin is exactly what this guards against.
					let freshState = await ctx.refreshState({ force: true });
					let actualSystemId = freshState.location?.system_id;

					if (!actualSystemId || freshState.location?.in_transit) {
						// The jump error is very often the server itself saying "you're
						// mid-transit, wait ~60s and resubmit" — wait that out here
						// instead of failing the goal, which would just make the caller
						// resubmit and race this same still-settling transit. Checking
						// in_transit explicitly (not just an unknown system_id) covers a
						// ship that still reports its stale pre-jump system while the
						// transit is in progress.
						log.info(
							"Position unknown or mid-transit after jump failure — waiting for it to resolve",
						);
						freshState = await waitForLocation(
							ctx,
							(s) => s.location?.system_id !== undefined && !s.location.in_transit,
							this.waitOpts,
						);
						actualSystemId = freshState.location?.system_id;
					}

					if (actualSystemId === this.targetSystemId) {
						return succeeded(
							`Navigated to system ${this.targetSystemId} in ${ticksUsed} jump(s)`,
							ticksUsed,
						);
					}

					if (!actualSystemId || freshState.location?.in_transit) {
						return failed(
							`Jump failed and cannot determine current location: ${err instanceof Error ? err.message : String(err)}`,
							ticksUsed,
						);
					}

					return this.jumpRoute(
						ctx,
						actualSystemId,
						ticksUsed,
						transientRerouted || isTransient,
						isApiError ? apiReroutesLeft - 1 : apiReroutesLeft,
					);
				}
				throw err;
			}
		}

		return succeeded(
			`Navigated to system ${this.targetSystemId} in ${ticksUsed} jump(s)`,
			ticksUsed,
		);
	}
}
