import { makeLibGoalContext } from "../dispatcher/lib-goal-context.js";
import type { FleetAccess } from "./fleet-access.js";

/** The slice of the server's handler context a fleet operation needs. */
export interface FleetAccessDeps {
	manager: {
		getByPlayerId(id: string): unknown;
		getByUsername(name: string): unknown;
	};
	loopManager: { getStatus(playerId: string): { running: boolean; type: string } | undefined };
	jobManager: { getRunningJob(playerId: string): { goalType?: string } | undefined };
	executingGoals: Map<string, { goalType: string }>;
	claimedAccounts: Set<string>;
	isInCombat?: ((playerId: string) => boolean) | undefined;
}

interface ResolvedAccount {
	player?: { id?: string } | undefined;
	id?: string | undefined;
}

/** Mirrors the server's playerIdOf: the game player id, falling back to the store key. */
const playerIdOf = (account: ResolvedAccount): string | undefined =>
	account.player?.id ?? account.id;

/**
 * Build the port `ensureFleet` uses to reach accounts other than the leader.
 *
 * `busyReason` is the whole safety story: it reports, and there is deliberately
 * no counterpart that releases anything. In-combat is checked first and
 * separately because combat already strips an account of its loop and goals, so
 * a ship mid-fight looks idle to every other busy check in the daemon.
 */
export function makeFleetAccess(deps: FleetAccessDeps): FleetAccess {
	const lookup = (idOrName: string): ResolvedAccount | undefined =>
		(deps.manager.getByPlayerId(idOrName) ?? deps.manager.getByUsername(idOrName)) as
			| ResolvedAccount
			| undefined;

	return {
		resolve: (idOrName) => {
			const account = lookup(idOrName);
			return account === undefined ? undefined : playerIdOf(account);
		},

		contextFor: (playerId) => {
			if (lookup(playerId) === undefined) return undefined;
			// Re-resolve on every access: a reconnect replaces the Account
			// instance, and a fleet operation can outlive one socket.
			return makeLibGoalContext(() => {
				const account = lookup(playerId);
				if (account === undefined) {
					throw new Error(`Account ${playerId} is no longer connected`);
				}
				return account as never;
			});
		},

		busyReason: (playerId) => {
			if (deps.isInCombat?.(playerId) === true) return "in_combat";

			const loop = deps.loopManager.getStatus(playerId);
			if (loop?.running === true) return `busy:loop:${loop.type}`;

			const goal = deps.executingGoals.get(playerId);
			if (goal !== undefined) return `busy:goal:${goal.goalType}`;

			const job = deps.jobManager.getRunningJob(playerId);
			if (job !== undefined) return `busy:job:${job.goalType ?? "unknown"}`;

			if (deps.claimedAccounts.has(playerId)) return "busy:claimed";

			return undefined;
		},
	};
}
