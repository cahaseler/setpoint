import { createLogger } from "../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext, ProgressRef, StepResult } from "./goals.js";

const log = createLogger("sequence");

/**
 * Execute a sequence of goals in order, stopping on the first failure or abort.
 *
 * State refresh strategy:
 * - After a step that consumed ticks (a mutation happened), refresh state
 *   via ctx.refreshState() before running the next step. This guarantees
 *   all state fields (including fuel after navigation) are current, regardless
 *   of which fields the previous mutation's response included.
 * - After a step that was already satisfied (0 ticks), skip the refresh
 *   since nothing changed.
 * - If ctx.refreshState is not provided, each step receives the original
 *   state snapshot (fine for testing, not ideal for production).
 *
 * If ctx.signal is aborted before a step starts, the sequence stops and
 * returns with the completed/remaining step breakdown.
 *
 * If a progressRef is provided, it is updated as steps execute so external
 * observers can see current progress.
 *
 * Returns a CompoundGoalResult with per-step detail.
 */
export async function runSequence(
	steps: Goal[],
	ctx: GoalContext,
	progressRef?: ProgressRef,
): Promise<CompoundGoalResult> {
	const stepResults: StepResult[] = [];
	let totalTicks = 0;
	let currentState = ctx.state;
	let lastStepUsedTicks = false;

	const stepNames = steps.map((s) => s.name);

	// Initialize progress ref
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

		// Update progress ref
		if (progressRef) {
			progressRef.currentStep = step.name;
			progressRef.remainingSteps = stepNames.slice(i + 1);
		}

		// Refresh state if the previous step consumed ticks (mutation occurred).
		// Uses the full API call — not local store — to guarantee all fields
		// (e.g. fuel after navigation) are current regardless of what the
		// previous mutation's response contained.
		if (lastStepUsedTicks && ctx.refreshState) {
			currentState = await ctx.refreshState();
		}

		const stepCtx: GoalContext = {
			endpoints: ctx.endpoints,
			state: currentState,
			...(ctx.readLocalState ? { readLocalState: ctx.readLocalState } : {}),
			...(ctx.refreshState ? { refreshState: ctx.refreshState } : {}),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		};

		log.info(`Running step: ${step.name}`);
		const result = await step.execute(stepCtx);

		stepResults.push({ goalName: step.name, result });
		totalTicks += result.ticksUsed;
		lastStepUsedTicks = result.ticksUsed > 0;

		// Update progress ref
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

	// Clear progress ref on completion
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
