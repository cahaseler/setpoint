import { HttpError, errorMessage } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:navigate-via-route");

/**
 * Navigate along an explicit, caller-provided sequence of systems.
 *
 * Unlike navigate-to-system, the path is never planned or re-planned by
 * find_route — the caller owns the route (e.g. to dodge patrols while
 * smuggling). On any jump rejection the goal fails hard and reports the
 * ship's current system so the caller can re-plan; a transient HTTP error
 * is retried once on the same hop only.
 *
 * Does NOT refuel en route. A single pre-flight check verifies the whole
 * route fits in the current tank (plus an optional fuelReserve buffer) and
 * fails before the first jump rather than stranding the ship mid-route.
 *
 * Already satisfied if the player is already in the final system.
 * Prerequisites: none (undocks automatically if docked).
 */
export class NavigateViaRoute implements Goal {
	readonly name = "navigate-via-route";
	private readonly route: string[];
	private readonly fuelReserve: number;

	/**
	 * @param route Systems to jump through in order; the last entry is the destination.
	 * @param fuelReserve Fuel units to keep beyond the route's estimated cost; the
	 *   pre-flight check requires hops * fuel_per_jump + fuelReserve. Defaults to 0.
	 */
	constructor(route: string[], fuelReserve = 0) {
		this.route = route;
		this.fuelReserve = fuelReserve;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		const target = this.route[this.route.length - 1];
		if (target === undefined) {
			return failed("Cannot navigate via route: route is empty", 0);
		}

		// Refresh state before routing to avoid acting on a stale position.
		const state = ctx.refreshState ? await ctx.refreshState() : ctx.state;
		const currentSystemId = state.location?.system_id;

		if (currentSystemId === target) {
			return alreadySatisfied(`Already in system ${target}`);
		}

		if (!currentSystemId) {
			return failed("Cannot navigate: current system unknown", 0);
		}

		// Skip leading hops the ship is already at (callers may include the origin).
		let startIndex = 0;
		while (startIndex < this.route.length && this.route[startIndex] === currentSystemId) {
			startIndex++;
		}
		const hops = this.route.slice(startIndex);

		// Pre-flight fuel check: find_route supplies the ship's per-jump fuel
		// cost and current fuel — the path it returns is never used.
		const routeInfo = await ctx.endpoints.findRoute(target);
		const fuelPerJump = routeInfo.structuredContent.fuel_per_jump;
		const fuelAvailable = routeInfo.structuredContent.fuel_available;
		const fuelNeeded = hops.length * fuelPerJump + this.fuelReserve;
		if (fuelNeeded > fuelAvailable) {
			const reserveNote = this.fuelReserve > 0 ? ` (incl. ${this.fuelReserve} reserve)` : "";
			return failed(
				`Insufficient fuel for ${hops.length}-hop route to ${target}: need ${fuelNeeded}${reserveNote}, have ${fuelAvailable}`,
				0,
			);
		}

		let ticksUsed = 0;
		if (state.location?.docked_at) {
			log.info(`Undocking before jump (docked at ${state.location.docked_at})`);
			await ctx.endpoints.undock();
			ticksUsed = 1;
		}

		for (let i = 0; i < hops.length; i++) {
			const hopSystemId = hops[i];
			if (hopSystemId === undefined) continue;

			// Check for external cancellation between jumps — explicit routes can
			// be long, and a force abort must not wait for the full route.
			if (ctx.signal?.aborted) {
				return failed(`Route navigation aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			log.info(`Jumping to ${hopSystemId} (hop ${i + 1}/${hops.length}, explicit route)`);
			try {
				await ctx.endpoints.jump(hopSystemId);
				ticksUsed++;
			} catch (err) {
				const isTransient =
					err instanceof HttpError && (err.statusCode === 0 || err.statusCode >= 500);

				if (isTransient && ctx.refreshState) {
					// The jump may have executed server-side; check actual position.
					// Force a live read — jumps carry no state, so the cached snapshot
					// can't tell us whether this hop landed.
					const fresh = await ctx.refreshState({ force: true });
					if (fresh.location?.system_id === hopSystemId) {
						ticksUsed++;
						continue;
					}
					// Retry the same hop once — never a different path.
					log.warn(
						`Jump to ${hopSystemId} failed transiently (${errorMessage(err)}), retrying hop`,
					);
					try {
						await ctx.endpoints.jump(hopSystemId);
						ticksUsed++;
						continue;
					} catch (retryErr) {
						return this.failAtHop(ctx, hopSystemId, retryErr, ticksUsed);
					}
				}

				return this.failAtHop(ctx, hopSystemId, err, ticksUsed);
			}
		}

		// Sync position after navigation — jump responses carry no V2GameState,
		// so the store lags behind the actual position until refreshed. Force a live
		// read: the store still looks "fresh" by timestamp, so the freshness shortcut
		// would otherwise return the stale pre-navigation position.
		if (ticksUsed > 0 && ctx.refreshState) {
			await ctx.refreshState({ force: true });
		}

		return succeeded(`Navigated explicit route to ${target} in ${ticksUsed} tick(s)`, ticksUsed);
	}

	/**
	 * Fail without re-planning, reporting the ship's actual system so the
	 * caller can choose a new route.
	 */
	private async failAtHop(
		ctx: GoalContext,
		hopSystemId: string,
		err: unknown,
		ticksUsed: number,
	): Promise<GoalResult> {
		// Force a live read so the reported position is the ship's true location,
		// not a cached pre-jump snapshot (jumps carry no state to update the store).
		const state = ctx.refreshState ? await ctx.refreshState({ force: true }) : ctx.state;
		const position = state.location?.system_id ?? "unknown";
		return failed(
			`Route jump to ${hopSystemId} failed (currently in ${position}): ${errorMessage(err)}`,
			ticksUsed,
		);
	}
}
