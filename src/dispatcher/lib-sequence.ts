import { createLogger } from "../util/logger.js";
import type { CompoundGoalResult, ProgressRef, StepResult } from "./goals.js";
import type { LibGoal, LibGoalContext } from "./lib-goal-context.js";
import { makeLibGoalContext } from "./lib-goal-context.js";

const log = createLogger("sequence");

/**
 * Execute a sequence of lib-backed goals in order, stopping on the first
 * failure or abort. The lib counterpart of `runSequence`.
 *
 * Unlike `runSequence`, there is NO between-step wire refresh. The old sequence
 * issued a full `get_state` after every tick-consuming step to guarantee all
 * fields were current regardless of what the mutation's response carried. The
 * lib's push-fed cache makes that unnecessary and counterproductive: each
 * mutation's delta is applied to `account.state` before the step's `await`
 * resolves, so the next step reads current state for free. Where a delta is
 * known to be incomplete (e.g. jumps carry no reliable position), the primitive
 * itself forces a live refresh — so completeness is handled at the primitive
 * level, not by re-polling between every step. Each step reads live
 * `account.state` via its own `LibGoalContext`.
 *
 * If `ctx.signal` is aborted before a step starts, the sequence stops and
 * returns the completed/remaining breakdown. If a `progressRef` is provided, it
 * is updated as steps execute so external observers can see current progress.
 */
export async function runLibSequence(
	steps: LibGoal[],
	ctx: LibGoalContext,
	progressRef?: ProgressRef,
): Promise<CompoundGoalResult> {
	const stepResults: StepResult[] = [];
	let totalTicks = 0;

	const stepNames = steps.map((s) => s.name);

	if (progressRef) {
		progressRef.completedSteps = [];
		progressRef.remainingSteps = [...stepNames];
		progressRef.currentStep = undefined;
	}

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i] as (typeof steps)[number];

		// Check for abort before starting the next step
		if (ctx.signal?.aborted) {
			const remaining = stepNames.slice(i);
			const completed = stepNames.slice(0, i);
			log.info(
				`Sequence aborted before step ${step.name}. Completed: [${completed.join(", ")}], remaining: [${remaining.join(", ")}]`,
			);

			return {
				success: false,
				message: `Aborted before ${step.name}. Completed: ${completed.join(", ") || "none"}. Remaining: ${remaining.join(", ")}`,
				alreadySatisfied: false,
				ticksUsed: totalTicks,
				steps: stepResults,
			};
		}

		if (progressRef) {
			progressRef.currentStep = step.name;
			progressRef.remainingSteps = stepNames.slice(i + 1);
		}

		// Pass the RESOLVER, not `ctx.account`. Reading `ctx.account` here would
		// evaluate the getter once and pin the step to that Account instance for
		// its whole duration — and a step can run for minutes (go-to-poi polls
		// for arrival for up to 600s). A reconnect during the step replaces the
		// underlying Account, leaving the pinned one sending on a dead socket:
		// the step then fails, the sequence stops, and the ship is left wherever
		// it got to — in the right system but short of the station.
		const stepCtx = makeLibGoalContext(() => ctx.account, ctx.signal);

		log.info(`Running step: ${step.name}`);
		const result = await step.execute(stepCtx);

		stepResults.push({ goalName: step.name, result });
		totalTicks += result.ticksUsed;

		if (progressRef) {
			progressRef.completedSteps.push(step.name);
		}

		if (!result.success) {
			const completedNames = stepResults.filter((s) => s.result.success).map((s) => s.goalName);
			const summary =
				completedNames.length > 0
					? `Failed at ${step.name} after completing: ${completedNames.join(", ")}`
					: `Failed at first step: ${step.name}`;

			log.warn(`${summary} — ${result.message}`);

			return {
				success: false,
				message: `${summary}. ${result.message}`,
				alreadySatisfied: false,
				ticksUsed: totalTicks,
				steps: stepResults,
			};
		}

		if (result.alreadySatisfied) {
			log.debug(`Step ${step.name}: already satisfied`);
		} else {
			log.info(`Step ${step.name}: completed (${result.ticksUsed} tick(s))`);
		}
	}

	if (progressRef) {
		progressRef.currentStep = undefined;
		progressRef.remainingSteps = [];
	}

	const allSatisfied = stepResults.every((s) => s.result.alreadySatisfied);
	const stepSummary = stepResults.map((s) => s.goalName).join(" → ");

	return {
		success: true,
		message: allSatisfied
			? `All steps already satisfied: ${stepSummary}`
			: `Completed sequence: ${stepSummary} (${totalTicks} tick(s))`,
		alreadySatisfied: allSatisfied,
		ticksUsed: totalTicks,
		steps: stepResults,
	};
}
