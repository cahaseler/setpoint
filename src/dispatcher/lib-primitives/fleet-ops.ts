import type { FleetCreateResponse, FleetStatusResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:fleet-ops");

/**
 * The game's fleet commands, one call each.
 *
 * Two asymmetries in the game's model drive every caller above this layer:
 * only the leader may invite or kick, and the leader cannot leave — a leader
 * removing itself disbands the fleet. Nothing here compensates for that; the
 * callers are expected to know it.
 */

/** Read the account's current fleet, or `undefined` when it is not in one. */
export async function fleetStatus(ctx: LibGoalContext): Promise<FleetStatusResponse> {
	const response = await ctx.account.commands.spacemolt_fleet.status();
	return response.structuredContent as FleetStatusResponse;
}

/** Create a fleet with this account as leader. Returns the new fleet id. */
export async function createFleet(ctx: LibGoalContext): Promise<string> {
	log.info("Creating fleet");
	const response = await ctx.account.commands.spacemolt_fleet.create();
	const details = response.delta.details as FleetCreateResponse | undefined;
	return details?.fleet_id ?? "";
}

/** Invite a player to this account's fleet. Leader only. */
export async function inviteToFleet(ctx: LibGoalContext, playerId: string): Promise<void> {
	log.info(`Inviting ${playerId}`);
	await ctx.account.commands.spacemolt_fleet.invite({ id: playerId });
}

/** Accept the pending invite on this account. Runs on the INVITEE, not the leader. */
export async function acceptFleetInvite(ctx: LibGoalContext): Promise<void> {
	log.info("Accepting fleet invite");
	await ctx.account.commands.spacemolt_fleet.accept();
}

/** Remove a member from this account's fleet. Leader only. */
export async function kickFromFleet(ctx: LibGoalContext, playerId: string): Promise<void> {
	log.info(`Kicking ${playerId}`);
	await ctx.account.commands.spacemolt_fleet.kick({ id: playerId });
}

/** Disband this account's fleet. The only way for a leader to leave one. */
export async function disbandFleet(ctx: LibGoalContext): Promise<void> {
	log.info("Disbanding fleet");
	await ctx.account.commands.spacemolt_fleet.disband();
}
