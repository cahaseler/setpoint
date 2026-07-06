import { ConnectionClosedError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import type { LocationWaitOptions } from "../wait-for-location.js";
import { waitForLocation } from "../wait-for-location.js";

const log = createLogger("goal:navigate-via-route");

/**
 * Navigate along an explicit, caller-provided sequence of systems.
 *
 * Unlike navigate-to-system, the path is never planned or re-planned by
 * find_route — the caller owns the route (e.g. to dodge patrols while
 * smuggling). On any jump rejection the goal fails hard and reports the
 * ship's current system so the caller can re-plan; a transient connection
 * error is retried once on the same hop only.
 *
 * Does NOT refuel en route. A single pre-flight check verifies the whole
 * route fits in the current tank (plus an optional fuelReserve buffer) and
 * fails before the first jump rather than stranding the ship mid-route.
 *
 * Already satisfied if the player is already in the final system.
 * Prerequisites: none (undocks automatically if docked).
 */
export class LibNavigateViaRoute implements LibGoal {
	readonly name = "navigate-via-route";
	private readonly route: string[];
	private readonly fuelReserve: number;
	private readonly waitOpts: LocationWaitOptions;

	/**
	 * @param route Systems to jump through in order; the last entry is the destination.
	 * @param fuelReserve Fuel units to keep beyond the route's estimated cost; the
	 *   pre-flight check requires hops * fuel_per_jump + fuelReserve. Defaults to 0.
	 * @param waitOpts Tuning for how long to wait out an unresolved position (mid-transit)
	 *   before the first hop. Defaults are production-sane; overridable mainly for tests.
	 */
	constructor(route: string[], fuelReserve = 0, waitOpts: LocationWaitOptions = {}) {
		this.route = route;
		this.fuelReserve = fuelReserve;
		this.waitOpts = waitOpts;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		const target = this.route[this.route.length - 1];
		if (target === undefined) {
			return failed("Cannot navigate via route: route is empty", 0);
		}

		// Refresh state before routing to avoid acting on a stale position.
		let state = await ctx.refreshState();
		let currentSystemId = state.location?.system_id;

		if (currentSystemId === target) {
			// Known limitation: doesn't check in_transit here, so a ship whose stale
			// cached system_id still equals the target while it's actually mid-jump
			// away from it would be misreported as already satisfied.
			return alreadySatisfied(`Already in system ${target}`);
		}

		if (!currentSystemId || state.location?.in_transit) {
			// Unknown position (or an explicit in_transit flag, even if system_id
			// still reads as the stale pre-jump value) most commonly means
			// mid-transit from a jump that hasn't settled yet — wait it out before
			// attempting the first hop. This only guards the precondition check;
			// it does not change the no-replan, fail-hard behavior on a rejected
			// jump mid-route (see failAtHop).
			log.info("Current system unknown or mid-transit — waiting for it to resolve");
			state = await waitForLocation(
				ctx,
				(s) => s.location?.system_id !== undefined && !s.location.in_transit,
				this.waitOpts,
			);
			currentSystemId = state.location?.system_id;

			if (currentSystemId === target) {
				return alreadySatisfied(`Already in system ${target}`);
			}
			if (!currentSystemId || state.location?.in_transit) {
				return failed("Cannot navigate: still mid-transit or current system unknown", 0);
			}
		}

		// Skip leading hops the ship is already at (callers may include the origin).
		let startIndex = 0;
		while (startIndex < this.route.length && this.route[startIndex] === currentSystemId) {
			startIndex++;
		}
		const hops = this.route.slice(startIndex);

		// Pre-flight fuel check: find_route supplies the ship's per-jump fuel
		// cost and current fuel — the path it returns is never used.
		const routeInfo = await ctx.account.commands.spacemolt.find_route({ id: target });
		const fuelPerJump = routeInfo.structuredContent?.fuel_per_jump ?? 0;
		const fuelAvailable = routeInfo.structuredContent?.fuel_available ?? 0;
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
			await ctx.account.commands.spacemolt.undock();
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
				await ctx.account.commands.spacemolt.jump({ id: hopSystemId });
				ticksUsed++;
			} catch (err) {
				const isTransient = err instanceof ConnectionClosedError;

				if (isTransient) {
					// The jump may have executed server-side; check actual position.
					// Force a live read — jumps carry no reliable position in the cache
					// (delta rarely includes location for transit actions), so the
					// cached snapshot can't tell us whether this hop landed.
					const fresh = await ctx.refreshState({ force: true });
					if (fresh.location?.system_id === hopSystemId) {
						ticksUsed++;
						continue;
					}
					// Retry the same hop once — never a different path.
					log.warn(
						`Jump to ${hopSystemId} failed transiently (${err instanceof Error ? err.message : String(err)}), retrying hop`,
					);
					try {
						await ctx.account.commands.spacemolt.jump({ id: hopSystemId });
						ticksUsed++;
						continue;
					} catch (retryErr) {
						return this.failAtHop(ctx, hopSystemId, retryErr, ticksUsed);
					}
				}

				return this.failAtHop(ctx, hopSystemId, err, ticksUsed);
			}
		}

		// Sync position after navigation — jump responses carry no reliable position,
		// so the store lags behind the actual position until refreshed. Force a live
		// read: the store still looks "fresh" by timestamp, so the freshness shortcut
		// would otherwise return the stale pre-navigation position.
		if (ticksUsed > 0) {
			await ctx.refreshState({ force: true });
		}

		return succeeded(`Navigated explicit route to ${target} in ${ticksUsed} tick(s)`, ticksUsed);
	}

	/**
	 * Fail without re-planning, reporting the ship's actual system so the
	 * caller can choose a new route.
	 */
	private async failAtHop(
		ctx: LibGoalContext,
		hopSystemId: string,
		err: unknown,
		ticksUsed: number,
	): Promise<GoalResult> {
		// Force a live read so the reported position is the ship's true location,
		// not a cached pre-jump snapshot (jumps carry no reliable position to update
		// the store).
		const state = await ctx.refreshState({ force: true });
		const position = state.location?.system_id ?? "unknown";
		const message = err instanceof Error ? err.message : String(err);
		return failed(
			`Route jump to ${hopSystemId} failed (currently in ${position}): ${message}`,
			ticksUsed,
		);
	}
}
