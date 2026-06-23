import { ApiError, HttpError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:navigate-to-system");

/**
 * Navigate to a target system via multi-hop jumps.
 *
 * Uses find_route to plan the path (free query), then jumps each hop
 * sequentially. Each jump consumes one tick (~10s).
 *
 * Already satisfied if the player is already in the target system.
 * Prerequisites: none (can jump from anywhere, docked or undocked).
 */
export class NavigateToSystem implements Goal {
	readonly name = "navigate-to-system";
	private readonly targetSystemId: string;

	constructor(targetSystemId: string) {
		this.targetSystemId = targetSystemId;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		// Refresh state before routing to avoid stale location after a failed prior attempt.
		const state = ctx.refreshState ? await ctx.refreshState() : ctx.state;
		const currentSystemId = state.location?.system_id;

		if (currentSystemId === this.targetSystemId) {
			return alreadySatisfied(`Already in system ${this.targetSystemId}`);
		}

		if (!currentSystemId) {
			return failed("Cannot navigate: current system unknown", 0);
		}

		// Undock before jumping — the game API rejects jump while docked.
		let undockTicks = 0;
		if (state.location?.docked_at) {
			log.info(`Undocking before jump (docked at ${state.location.docked_at})`);
			await ctx.endpoints.undock();
			undockTicks = 1;
		}

		const result = await this.jumpRoute(ctx, currentSystemId, undockTicks, false, 10);
		// Sync position after navigation. Jumps return PendingActionResponse (no V2GameState),
		// so the store position lags behind the actual position after multi-hop routes.
		// Without this sync the next goal reads the pre-navigation origin, causing
		// findRoute to return a route that starts at the actual position while fromSystemId
		// is still the old origin — the skip-logic mismatch triggers "already in X" errors.
		if (result.ticksUsed > 0 && ctx.refreshState) {
			await ctx.refreshState();
		}
		return result;
	}

	private async jumpRoute(
		ctx: GoalContext,
		fromSystemId: string,
		ticksUsedSoFar: number,
		transientRerouted: boolean,
		apiReroutesLeft: number,
	): Promise<GoalResult> {
		// Plan the route (free query, no tick cost)
		log.info(`Planning route from ${fromSystemId} to ${this.targetSystemId}`);
		const routeResponse = await ctx.endpoints.findRoute(this.targetSystemId);
		const route = routeResponse.structuredContent;

		if (!route.found || !route.route || route.route.length === 0) {
			return failed(
				`No route found to system ${this.targetSystemId}: ${route.message}`,
				ticksUsedSoFar,
			);
		}

		// Pre-flight fuel check: fail before the first jump rather than stranding
		// mid-route. fuel_available is the game server's current reading for this ship.
		if (route.estimated_fuel > route.fuel_available) {
			return failed(
				`Insufficient fuel to reach ${this.targetSystemId}: need ${route.estimated_fuel}, have ${route.fuel_available}`,
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

			// Check for external cancellation between jumps — multi-hop routes can
			// run for minutes, and a force abort must not wait for the full route.
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
				await ctx.endpoints.jump(hopSystemId);
				ticksUsed++;
			} catch (err) {
				const isApiError = err instanceof ApiError;
				const isTransient =
					err instanceof HttpError && (err.statusCode === 0 || err.statusCode >= 500);

				// ApiErrors carry definitive position info from the game server (e.g.
				// "You are already in X" means the ship IS at X — not a transient fault).
				// Allow up to apiReroutesLeft reroutes so multi-hop routes handle multiple
				// "already in" hops without failing.
				//
				// Transient errors (network timeout, 5xx) may have executed server-side;
				// reroute once to check actual position, then stop to avoid infinite retries.
				const canReroute =
					(isApiError && apiReroutesLeft > 0) || (isTransient && !transientRerouted);

				if (canReroute && ctx.refreshState) {
					log.warn(
						`Jump to ${hopSystemId} failed (${err instanceof Error ? err.message : String(err)}), re-planning from actual position`,
					);
					const freshState = await ctx.refreshState();
					const actualSystemId = freshState.location?.system_id;

					if (actualSystemId === this.targetSystemId) {
						return succeeded(
							`Navigated to system ${this.targetSystemId} in ${ticksUsed} jump(s)`,
							ticksUsed,
						);
					}

					if (!actualSystemId) {
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
