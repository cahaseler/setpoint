import type { GoalResult, LoopResult } from "./goals.js";
import type { LibGoalContext } from "./lib-goal-context.js";
import type { LibGoalFactory } from "./lib-loops.js";
import { runLibLoop } from "./lib-loops.js";
import { LibNavigateToSystem } from "./lib-primitives/navigate-to-system.js";

/**
 * The smallest loop the ported slice primitives can drive: repeatedly navigate
 * between the given systems, alternating the target each iteration. Its purpose
 * is to exercise the runLibLoop engine (refresh/retry/abort cycle) against a real
 * lib account in the live harness — NOT a game-meaningful behavior.
 */
export function libPatrolLoop(
	ctx: LibGoalContext,
	systemIds: string[],
	options: { maxIterations?: number; signal?: AbortSignal } = {},
): Promise<LoopResult> {
	if (systemIds.length === 0) {
		throw new Error("libPatrolLoop requires at least one system id");
	}
	let next = 0;
	const factory: LibGoalFactory = () => {
		const target = systemIds[next % systemIds.length] as string;
		next++;
		return new LibNavigateToSystem(target);
	};
	return runLibLoop(factory, ctx, {
		...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
}

/**
 * Format a one-line-per-field report for the live harness. Pure so it is
 * unit-testable. `deltaSections` is the list of state sections a mutation's delta
 * carried — the live signal for questions like "does jump's delta include
 * location?".
 */
export function formatSliceReport(
	label: string,
	result: GoalResult,
	deltaSections: string[],
): string {
	const outcome = result.success
		? result.alreadySatisfied
			? "already-satisfied"
			: "success"
		: "failure";
	return [
		`slice: ${label}`,
		`outcome: ${outcome}`,
		`ticks: ${result.ticksUsed}`,
		`message: ${result.message}`,
		`delta sections observed: ${deltaSections.length ? deltaSections.join(", ") : "(none)"}`,
	].join("\n");
}
