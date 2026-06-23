import type { CompoundGoalResult, Goal, GoalContext } from "./goals.js";
import { runSequence } from "./sequence.js";

/**
 * A goal that executes a sequence of sub-goals in order.
 *
 * This is a thin wrapper around `runSequence` that implements the `Goal`
 * interface, allowing any sequence to be used wherever a single Goal is
 * expected (e.g., as a loop iteration body).
 */
export class SequenceGoal implements Goal {
	readonly name: string;
	private readonly steps: Goal[];

	constructor(name: string, steps: Goal[]) {
		this.name = name;
		this.steps = steps;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		return runSequence(this.steps, ctx);
	}
}
