import type { FleetOperationResult, GoalResult } from "../dispatcher/goals.js";
import { failed, fleetOperation, succeeded } from "../dispatcher/goals.js";
import type { LibGoalContext } from "../dispatcher/lib-goal-context.js";
import { LibDockAt } from "../dispatcher/lib-primitives/dock-at.js";
import { LibEnsureFueled } from "../dispatcher/lib-primitives/ensure-fueled.js";
import { LibEnsureRepaired } from "../dispatcher/lib-primitives/ensure-repaired.js";
import { fleetStatus } from "../dispatcher/lib-primitives/fleet-ops.js";
import { LibGoToPoi } from "../dispatcher/lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../dispatcher/lib-primitives/navigate-to-system.js";
import { waitForLocation } from "../dispatcher/wait-for-location.js";
import { createLogger } from "../util/logger.js";
import type { FleetAccess } from "./fleet-access.js";

const log = createLogger("fleet:fleet-move");

export interface FleetMoveOptions {
	systemId: string;
	poiId: string;
	/** Dock every member here on arrival. Omit to stop at the POI. */
	baseId?: string;
	/**
	 * Top up fuel on arrival. Defaults to whether `baseId` was given, because
	 * refuelling requires being docked — defaulting it on for a move to a bare
	 * POI would fail every ship for not being somewhere it was never asked to
	 * dock.
	 */
	refuel?: boolean;
	/** Repair hull on arrival. Same default and the same reason as `refuel`. */
	repair?: boolean;
	/** How long to wait for the leader to settle and for members to arrive. */
	maxWaitMs?: number;
}

/**
 * Move a fleet by moving its leader, then bring every member up to readiness.
 *
 * Waits for a leader that is mid-jump rather than refusing. Mid-transit the
 * leader reports no POI, so every member measured against it looks like a
 * stray — classifying before the leader has settled produces a result that is
 * confidently wrong. Waiting first is what makes the per-member verdicts mean
 * anything.
 *
 * Fuel and repair do not cascade from the leader, so they are run per member
 * once everyone has arrived.
 */
export async function fleetMove(
	leader: LibGoalContext,
	access: FleetAccess,
	options: FleetMoveOptions,
): Promise<FleetOperationResult> {
	const settle: SettleOptions = {
		systemId: options.systemId,
		poiId: options.poiId,
		...(options.baseId !== undefined ? { baseId: options.baseId } : {}),
		refuel: options.refuel ?? options.baseId !== undefined,
		repair: options.repair ?? options.baseId !== undefined,
	};

	const waitOpts = options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs };
	let waitedForLeader = false;

	if (leader.state.location?.in_transit === true) {
		log.info("Leader is mid-transit — waiting for it to settle before moving the fleet");
		waitedForLeader = true;
		await waitForLocation(leader, (s) => s.location?.in_transit !== true, waitOpts);
	}

	const status = await fleetStatus(leader);
	const memberIds = (status.members ?? []).filter((m) => !m.is_leader).map((m) => m.player_id);

	const leaderResult = await moveLeader(leader, settle);
	// Keyed by player_id like every other entry: a caller diffing this map
	// against its own roster must not find a row named "leader" matching nothing.
	// Prefer our own account's player id: FleetStatusResponse.leader is a bare
	// string that may be a username, and this map is documented as player-keyed.
	const leaderId = leader.state.player?.id ?? status.leader ?? "leader";
	const accounts: Record<string, GoalResult> = { [leaderId]: leaderResult };

	if (!leaderResult.success) {
		// Members are not asked to arrive somewhere the leader never reached.
		for (const id of memberIds) {
			accounts[id] = failed(`leader_did_not_arrive: ${leaderResult.message}`, 0);
		}
		return fleetOperation(accounts, leaderResult.ticksUsed);
	}

	let ticks = leaderResult.ticksUsed;

	for (const id of memberIds) {
		const result = await settleMember(access, id, settle, waitOpts);
		ticks += result.ticksUsed;
		accounts[id] = result;
	}

	const operation = fleetOperation(accounts, ticks);
	return {
		...operation,
		message: waitedForLeader
			? `${operation.message} (waited for the leader to arrive first)`
			: operation.message,
	};
}

/** The resolved per-ship work, after defaults are applied once for the whole move. */
interface SettleOptions {
	systemId: string;
	poiId: string;
	baseId?: string;
	refuel: boolean;
	repair: boolean;
}

async function moveLeader(leader: LibGoalContext, options: SettleOptions): Promise<GoalResult> {
	const navigate = await new LibNavigateToSystem(options.systemId).execute(leader);
	if (!navigate.success) return navigate;

	const toPoi = await new LibGoToPoi(options.poiId).execute(leader);
	if (!toPoi.success) return toPoi;

	let ticks = navigate.ticksUsed + toPoi.ticksUsed;

	if (options.baseId !== undefined) {
		const dock = await new LibDockAt(options.baseId).execute(leader);
		ticks += dock.ticksUsed;
		if (!dock.success) return { ...dock, ticksUsed: ticks };
	}

	// The leader is readied on the same terms as everyone else. Skipping it here
	// meant one request treated the leader and the members differently.
	const ready = await readyShip(leader, options);
	ticks += ready.ticksUsed;
	if (!ready.success) return { ...ready, ticksUsed: ticks };

	return succeeded(
		`Leader at ${options.systemId}/${options.poiId}${ready.message === "" ? "" : ` (${ready.message})`}`,
		ticks,
	);
}

async function settleMember(
	access: FleetAccess,
	playerId: string,
	options: SettleOptions,
	waitOpts: { maxWaitMs?: number },
): Promise<GoalResult> {
	const ctx = access.contextFor(playerId);
	if (ctx === undefined) {
		return failed("not_connected", 0);
	}

	// Same rule as ensure-fleet: report, never preempt. Docking and refuelling a
	// member that is mid-loop or mid-combat would put two things in charge of
	// one ship, which is exactly what the busy check exists to prevent.
	const busy = access.busyReason(playerId);
	if (busy !== undefined) {
		return failed(busy, 0);
	}

	// The fleet move carries members along, so this waits for arrival rather
	// than issuing travel per member.
	const arrived = await waitForLocation(
		ctx,
		(s) =>
			s.location?.system_id === options.systemId &&
			s.location?.poi_id === options.poiId &&
			s.location?.in_transit !== true,
		waitOpts,
	);

	if (
		arrived.location?.system_id !== options.systemId ||
		arrived.location?.poi_id !== options.poiId
	) {
		return failed(
			`did_not_arrive: at ${arrived.location?.system_id ?? "unknown"}/${arrived.location?.poi_id ?? "unknown"}${arrived.location?.in_transit === true ? " (in transit)" : ""}`,
			0,
		);
	}

	let ticks = 0;

	if (options.baseId !== undefined) {
		const dock = await new LibDockAt(options.baseId).execute(ctx);
		ticks += dock.ticksUsed;
		if (!dock.success) return { ...dock, ticksUsed: ticks };
	}

	const ready = await readyShip(ctx, options);
	ticks += ready.ticksUsed;
	if (!ready.success) return { ...ready, ticksUsed: ticks };

	return succeeded(`Arrived${ready.message === "" ? "" : ` (${ready.message})`}`, ticks);
}

/**
 * Top up fuel and hull, if this move asked for it.
 *
 * Neither cascades from the leader in the game, so every ship pays its own way.
 */
async function readyShip(ctx: LibGoalContext, options: SettleOptions): Promise<GoalResult> {
	let ticks = 0;
	const notes: string[] = [];

	if (options.refuel) {
		const fuel = await new LibEnsureFueled().execute(ctx);
		ticks += fuel.ticksUsed;
		if (!fuel.success) return { ...fuel, ticksUsed: ticks };
		notes.push(fuel.alreadySatisfied ? "fuel ok" : "refueled");
	}

	if (options.repair) {
		const repair = await new LibEnsureRepaired().execute(ctx);
		ticks += repair.ticksUsed;
		if (!repair.success) return { ...repair, ticksUsed: ticks };
		notes.push(repair.alreadySatisfied ? "hull ok" : "repaired");
	}

	return succeeded(notes.join(", "), ticks);
}
