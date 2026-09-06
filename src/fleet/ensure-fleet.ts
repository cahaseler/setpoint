import type { FleetStatusResponse } from "@spacemolt/lib";
import type { ReconcileResult, ReconcileSubject } from "../dispatcher/goals.js";
import { reconciled } from "../dispatcher/goals.js";
import type { LibGoalContext } from "../dispatcher/lib-goal-context.js";
import {
	acceptFleetInvite,
	createFleet,
	disbandFleet,
	fleetStatus,
	inviteToFleet,
	kickFromFleet,
} from "../dispatcher/lib-primitives/fleet-ops.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import type { FleetAccess } from "./fleet-access.js";

const log = createLogger("fleet:ensure-fleet");

export interface EnsureFleetOptions {
	/** Exactly the members the fleet should contain, excluding the leader. Empty disbands it. */
	members: string[];
}

interface MemberPosition {
	systemId: string | undefined;
	poiId: string | undefined;
	inTransit: boolean;
}

function positionOf(ctx: LibGoalContext): MemberPosition {
	const location = ctx.state.location;
	return {
		systemId: location?.system_id,
		poiId: location?.poi_id,
		inTransit: location?.in_transit === true,
	};
}

function samePlace(a: MemberPosition, b: MemberPosition): boolean {
	return !a.inTransit && !b.inTransit && a.systemId === b.systemId && a.poiId === b.poiId;
}

/**
 * Reconcile the game fleet led by this account to exactly `members`.
 *
 * Deliberately does NOT move ships. An invite only lands if the invitee is
 * already at the leader's POI, so a member elsewhere is reported `not_at_poi`
 * rather than quietly flown in — positioning is `fleet-move`'s job, and keeping
 * them separate lets a caller order the two itself.
 *
 * Two rules of the game's fleet model shape the result: only the leader may
 * invite or kick, and a leader cannot leave, so emptying the fleet disbands it.
 */
export async function ensureFleet(
	leader: LibGoalContext,
	access: FleetAccess,
	options: EnsureFleetOptions,
): Promise<ReconcileResult> {
	const status = await fleetStatus(leader);
	const leaderPosition = positionOf(leader);
	const currentMembers = (status.members ?? []).filter((m) => !m.is_leader).map((m) => m.player_id);

	const desired = [...new Set(options.members.map((m) => access.resolve(m) ?? m))];
	const sizeBefore = currentMembers.length + (status.in_fleet ? 1 : 0);

	if (desired.length === 0) {
		return disbandIfNeeded(leader, status, currentMembers, sizeBefore);
	}

	if (status.in_fleet && status.is_leader === false) {
		// A refusal is not a reconciliation. Returning an empty subject list here
		// would derive success:true — a caller would read "fleet reconciled" for
		// an account that is somebody else's follower.
		return notLeader(status, sizeBefore, "cannot reconcile a fleet this account does not lead");
	}

	let ticksUsed = 0;
	let created = false;
	let fleetId = status.fleet_id;

	if (!status.in_fleet) {
		fleetId = await createFleet(leader);
		ticksUsed++;
		created = true;
	}

	const subjects: ReconcileSubject[] = [];
	// The leader occupies a slot, so a fleet of max_size holds max_size-1 others.
	const capacity = status.max_size === undefined ? undefined : status.max_size - 1;
	let occupied = currentMembers.length;

	// Kick first. Unwanted members hold slots the desired ones may need, so
	// admitting first would report fleet_full for members that are about to have
	// room made for them, and spend the ticks anyway.
	for (const playerId of currentMembers.filter((m) => !desired.includes(m))) {
		try {
			await kickFromFleet(leader, playerId);
			ticksUsed++;
			occupied--;
			subjects.push({ id: playerId, kind: "member", ok: true, action: "removed" });
		} catch (err) {
			subjects.push({
				id: playerId,
				kind: "member",
				ok: false,
				action: "none",
				message: `kick_failed: ${errorMessage(err)}`,
				before: { inFleet: true },
			});
		}
	}

	for (const playerId of desired) {
		if (currentMembers.includes(playerId)) {
			subjects.push({ id: playerId, kind: "member", ok: true, action: "none" });
			continue;
		}
		const outcome = await admitMember(leader, access, playerId, leaderPosition, {
			full: capacity !== undefined && occupied >= capacity,
		});
		ticksUsed += outcome.ticksUsed;
		if (outcome.subject.ok) occupied++;
		subjects.push(outcome.subject);
	}

	return reconciled(subjects, ticksUsed, {
		context: {
			fleet: {
				id: fleetId,
				leader: status.leader ?? leader.state.player?.id,
				sizeBefore,
				// Derived from what actually happened, kicks included — a caller
				// diffing two runs against context relies on this being real.
				sizeAfter: occupied + 1,
				created,
				disbanded: false,
			},
		},
	});
}

/** A refusal to touch someone else's fleet, reported as a failure rather than an empty success. */
function notLeader(
	status: FleetStatusResponse,
	sizeBefore: number,
	detail: string,
): ReconcileResult {
	return reconciled(
		[
			{
				id: status.fleet_id ?? "fleet",
				kind: "fleet",
				ok: false,
				action: "none",
				message: "not_leader",
				before: { inFleet: true, leader: status.leader, isLeader: false },
			},
		],
		0,
		{
			message: `not_leader: ${detail}`,
			context: { fleet: { id: status.fleet_id, leader: status.leader, sizeBefore } },
		},
	);
}

async function disbandIfNeeded(
	leader: LibGoalContext,
	status: FleetStatusResponse,
	currentMembers: string[],
	sizeBefore: number,
): Promise<ReconcileResult> {
	if (!status.in_fleet) {
		return reconciled([], 0, { message: "Not in a fleet; nothing to disband" });
	}
	if (status.is_leader === false) {
		return notLeader(status, sizeBefore, "cannot disband a fleet this account does not lead");
	}
	// A leader cannot `leave` — disbanding is the only way out.
	await disbandFleet(leader);
	log.info(`Disbanded fleet ${status.fleet_id ?? "?"}`);
	return reconciled(
		currentMembers.map((id) => ({
			id,
			kind: "member" as const,
			ok: true as const,
			action: "removed" as const,
		})),
		1,
		{
			context: {
				fleet: {
					id: status.fleet_id,
					leader: status.leader,
					sizeBefore,
					sizeAfter: 0,
					created: false,
					disbanded: true,
				},
			},
		},
	);
}

async function admitMember(
	leader: LibGoalContext,
	access: FleetAccess,
	playerId: string,
	leaderPosition: MemberPosition,
	limits: { full: boolean },
): Promise<{ subject: ReconcileSubject; ticksUsed: number }> {
	const base = { id: playerId, kind: "member" as const, desired: { inFleet: true } };

	if (limits.full) {
		return {
			ticksUsed: 0,
			subject: {
				...base,
				ok: false,
				action: "none",
				message: "fleet_full",
				before: { inFleet: false },
			},
		};
	}

	const memberCtx = access.contextFor(playerId);
	if (memberCtx === undefined) {
		return {
			ticksUsed: 0,
			subject: {
				...base,
				ok: false,
				action: "none",
				message: "not_connected",
				before: { inFleet: false, connected: false },
			},
		};
	}

	// No preemption: an account already working is reported, never taken over.
	const busy = access.busyReason(playerId);
	if (busy !== undefined) {
		return {
			ticksUsed: 0,
			subject: {
				...base,
				ok: false,
				action: "none",
				message: busy,
				before: { inFleet: false, ...positionOf(memberCtx) },
			},
		};
	}

	const memberPosition = positionOf(memberCtx);
	if (!samePlace(memberPosition, leaderPosition)) {
		// The likeliest cause is that the caller's model is stale — the ship is
		// already inbound, not stray. Report where it actually is so the caller
		// reconciles rather than re-planning around a phantom.
		return {
			ticksUsed: 0,
			subject: {
				...base,
				ok: false,
				action: "none",
				message: "not_at_poi",
				desired: { systemId: leaderPosition.systemId, poiId: leaderPosition.poiId },
				before: { inFleet: false, ...memberPosition },
			},
		};
	}

	try {
		await inviteToFleet(leader, playerId);
	} catch (err) {
		return {
			ticksUsed: 1,
			subject: {
				...base,
				ok: false,
				action: "none",
				message: `invite_failed: ${errorMessage(err)}`,
				before: { inFleet: false, ...memberPosition },
			},
		};
	}

	try {
		await acceptFleetInvite(memberCtx);
	} catch (err) {
		return {
			ticksUsed: 2,
			subject: {
				...base,
				ok: false,
				action: "none",
				message: `accept_failed: ${errorMessage(err)}`,
				before: { inFleet: false, invited: true, ...memberPosition },
			},
		};
	}

	return {
		ticksUsed: 2,
		subject: { ...base, ok: true, action: "created", after: { inFleet: true } },
	};
}
