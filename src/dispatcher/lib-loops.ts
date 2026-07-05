import type { GameState } from "@spacemolt/lib";
import type { StoredGameState } from "../state/store.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import type { GoalResult, IterationResult, LoopOptions, LoopResult } from "./goals.js";
import type { LibGoal, LibGoalContext } from "./lib-goal-context.js";
import { makeLibGoalContext } from "./lib-goal-context.js";

const log = createLogger("loop");

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const MAX_STORED_ITERATIONS = 100;

/** Factory that produces a fresh lib-backed Goal given current state. */
export type LibGoalFactory = (state: Readonly<GameState>) => LibGoal;

// abortableDelay and pushIteration are copied verbatim from loops.ts. That file
// is coupled to the old GoalContext types and cannot be imported without pulling
// them in; this is intentional additive duplication, deduped at cutover when the
// old loops.ts is deleted.
function pushIteration(iterations: IterationResult[], entry: IterationResult): void {
	iterations.push(entry);
	if (iterations.length > MAX_STORED_ITERATIONS) {
		iterations.shift();
	}
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Refresh state before retrying a failed iteration. Non-forced: returns the
 * push-fed cache for free. Falls back to the existing state if refresh throws.
 */
async function refreshBeforeRetry(
	ctx: LibGoalContext,
	fallback: Readonly<GameState>,
): Promise<Readonly<GameState>> {
	try {
		return await ctx.refreshState();
	} catch (err) {
		log.warn(`Failed to refresh state before retry: ${errorMessage(err)}`);
		return fallback;
	}
}

/**
 * Run a lib-backed goal in a loop, producing a fresh goal from the factory each
 * iteration. Mirrors runLoop's success/failure/retry/abort semantics over
 * LibGoalContext.
 *
 * Unlike the REST runLoop, this engine never sees a RateLimitError: the lib
 * absorbs `rate_limited` beneath the command layer (Account.withRateLimitRetry),
 * honoring the server's retry-after there. A thrown error here is always a
 * normal failure paced by retryDelayMs.
 */
export async function runLibLoop(
	factory: LibGoalFactory,
	ctx: LibGoalContext,
	options: LoopOptions = {},
): Promise<LoopResult> {
	const iterations: IterationResult[] = [];
	let totalTicks = 0;
	// Refresh (free) before the first iteration so the loop starts with current data.
	let currentState = await refreshBeforeRetry(ctx, ctx.state);
	const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
	const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	let consecutiveFailures = 0;
	let i = 0;

	while (i < maxIterations) {
		if (options.signal?.aborted) {
			log.info(`Loop cancelled after ${i} iteration(s)`);
			return {
				success: true,
				message: `Loop cancelled after ${i} iteration(s)`,
				alreadySatisfied: false,
				ticksUsed: totalTicks,
				iterations,
				iterationCount: i,
			};
		}

		// shouldContinue takes StoredGameState in the shared LoopOptions type. The lib
		// GameState is structurally identical (same V2GameState sections); Phase 4
		// unifies the state type. The cast is safe.
		if (
			options.shouldContinue &&
			!options.shouldContinue(i, currentState as unknown as StoredGameState)
		) {
			log.info(`Loop stopped by shouldContinue after ${i} iteration(s)`);
			return {
				success: true,
				message: `Loop stopped after ${i} iteration(s)`,
				alreadySatisfied: false,
				ticksUsed: totalTicks,
				iterations,
				iterationCount: i,
			};
		}

		const goal = factory(currentState);
		log.info(`Loop iteration ${i + 1}: running ${goal.name}`);

		let result: GoalResult;
		try {
			const iterationCtx = makeLibGoalContext(ctx.account, options.signal ?? ctx.signal);
			result = await goal.execute(iterationCtx);
		} catch (err) {
			if (options.signal?.aborted) {
				log.info(`Loop cancelled during iteration ${i + 1}`);
				return {
					success: true,
					message: `Loop cancelled after ${i} iteration(s)`,
					alreadySatisfied: false,
					ticksUsed: totalTicks,
					iterations,
					iterationCount: i,
				};
			}
			consecutiveFailures++;
			log.warn(
				`Loop iteration ${i + 1} threw exception (failure ${consecutiveFailures}/${maxConsecutiveFailures}): ${errorMessage(err)}`,
			);

			if (consecutiveFailures >= maxConsecutiveFailures) {
				const msg = errorMessage(err);
				return {
					success: false,
					message: `Loop stopped after ${maxConsecutiveFailures} consecutive failure(s). Last error: ${msg}`,
					alreadySatisfied: false,
					ticksUsed: totalTicks,
					iterations,
					iterationCount: i,
				};
			}

			log.info(`Retrying iteration ${i + 1} in ${retryDelayMs}ms...`);
			await abortableDelay(retryDelayMs, options.signal);
			currentState = await refreshBeforeRetry(ctx, currentState);
			continue;
		}

		if (!result.success) {
			totalTicks += result.ticksUsed;
			options.onIterationComplete?.(i + 1, result);

			if (options.signal?.aborted) {
				log.info(`Loop cancelled during iteration ${i + 1}`);
				return {
					success: true,
					message: `Loop cancelled after ${i} iteration(s)`,
					alreadySatisfied: false,
					ticksUsed: totalTicks,
					iterations,
					iterationCount: i,
				};
			}

			if (options.ignoreFailure?.(result)) {
				log.info(`Loop iteration ${i + 1} will retry (not counted as failure): ${result.message}`);
				log.info(`Retrying iteration ${i + 1} in ${retryDelayMs}ms...`);
				await abortableDelay(retryDelayMs, options.signal);
				currentState = await refreshBeforeRetry(ctx, currentState);
				continue;
			}

			consecutiveFailures++;
			log.warn(
				`Loop failed on iteration ${i + 1} (failure ${consecutiveFailures}/${maxConsecutiveFailures}): ${result.message}`,
			);

			if (consecutiveFailures >= maxConsecutiveFailures) {
				pushIteration(iterations, { iteration: i, result });
				return {
					success: false,
					message: `Loop stopped after ${maxConsecutiveFailures} consecutive failure(s). Last: ${result.message}`,
					alreadySatisfied: false,
					ticksUsed: totalTicks,
					iterations,
					iterationCount: iterations.length,
				};
			}

			log.info(`Retrying iteration ${i + 1} in ${retryDelayMs}ms...`);
			await abortableDelay(retryDelayMs, options.signal);
			currentState = await refreshBeforeRetry(ctx, currentState);
			continue;
		}

		consecutiveFailures = 0;
		pushIteration(iterations, { iteration: i, result });
		totalTicks += result.ticksUsed;
		options.onIterationComplete?.(i + 1, result);
		log.info(`Loop iteration ${i + 1} complete: ${result.ticksUsed} tick(s)`);

		currentState = await refreshBeforeRetry(ctx, currentState);
		i++;
	}

	log.info(`Loop completed ${iterations.length} iteration(s), ${totalTicks} total tick(s)`);
	return {
		success: true,
		message: `Loop completed ${iterations.length} iteration(s) (${totalTicks} tick(s))`,
		alreadySatisfied: false,
		ticksUsed: totalTicks,
		iterations,
		iterationCount: iterations.length,
	};
}
