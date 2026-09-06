import type { LibGoalContext } from "../dispatcher/lib-goal-context.js";

/**
 * How a fleet operation reaches accounts other than the one it runs on.
 *
 * Every goal in setpoint owns exactly one account, and the claim, abort and
 * loop machinery is keyed that way. Fleet operations are the one thing that
 * genuinely spans accounts — a fleet invite is worthless until the invitee
 * accepts it — so rather than widen `LibGoalContext`, they reach other accounts
 * through this narrow, read-mostly port supplied by the server layer.
 *
 * It deliberately offers no way to take an account away from work it is already
 * doing. A fleet operation that finds a member mid-loop reports that as a
 * failure for the caller to resolve; it does not preempt. Releasing an account
 * is an operator action (`DELETE /accounts/:playerId/abort`), not something a
 * reconciler does on a re-run.
 */
export interface FleetAccess {
	/** Canonical player id for an id or username, or `undefined` if unknown. */
	resolve(playerIdOrUsername: string): string | undefined;
	/** A goal context for another connected account. */
	contextFor(playerId: string): LibGoalContext | undefined;
	/**
	 * Why this account cannot be commanded right now, as a machine-readable
	 * token (`busy:mining-loop`, `busy:goal:navigate-to-system`, `in_combat`),
	 * or `undefined` when it is free.
	 */
	busyReason(playerId: string): string | undefined;
}
