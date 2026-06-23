import type { StoredGameState } from "../state/store.js";
import { RateLimitError, errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import type {
	GoalContext,
	GoalFactory,
	GoalResult,
	IterationResult,
	LoopOptions,
	LoopResult,
} from "./goals.js";

const log = createLogger("loop");

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const MAX_STORED_ITERATIONS = 100;

function pushIteration(iterations: IterationResult[], entry: IterationResult): void {
	iterations.push(entry);
	if (iterations.length > MAX_STORED_ITERATIONS) {
		iterations.shift();
	}
}

/**
 * Wait for the given number of milliseconds, but resolve immediately if the
 * abort signal fires. Used to make retry delays responsive to loop stop.
 */
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
 * Refresh state before retrying a failed iteration. Ensures the retry
 * starts with current state rather than the stale snapshot from the
 * last successful iteration (or loop start). Falls back to the
 * existing state if the refresh fails.
 */
async function refreshBeforeRetry(
	ctx: GoalContext,
	fallback: StoredGameState,
): Promise<StoredGameState> {
	if (!ctx.refreshState) return fallback;
	try {
		return await ctx.refreshState();
	} catch (err) {
		log.warn(`Failed to refresh state before retry: ${errorMessage(err)}`);
		return fallback;
	}
}

/**
 * Run a goal in a loop, producing a fresh goal from the factory each iteration.
 *
 * The loop:
 * 1. Checks abort signal and shouldContinue before each iteration
 * 2. Calls factory(currentState) to build a fresh Goal
 * 3. Executes the goal
 * 4. On success: refreshes state, advances to the next iteration
 * 5. On failure (result.success === false) or thrown exception: waits retryDelayMs
 *    and retries the same iteration — does NOT advance the iteration counter.
 *    Consecutive failures are tracked; after maxConsecutiveFailures the loop stops.
 * 6. A successful iteration resets the consecutive failure counter.
 *
 * Cancellation and shouldContinue stops are considered successful completions.
 * RateLimitErrors use the server's retry-after time instead of retryDelayMs.
 */
export async function runLoop(
	factory: GoalFactory,
	ctx: GoalContext,
	options: LoopOptions = {},
): Promise<LoopResult> {
	const iterations: IterationResult[] = [];
	let totalTicks = 0;
	// Refresh state before the first iteration so the loop starts with
	// accurate data rather than whatever was in the store at construction time.
	let currentState = await refreshBeforeRetry(ctx, ctx.state);
	const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
	const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	let consecutiveFailures = 0;
	let i = 0;

	while (i < maxIterations) {
		// Check cancellation
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

		// Check shouldContinue
		if (options.shouldContinue && !options.shouldContinue(i, currentState)) {
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

		// Build fresh goal from factory
		const goal = factory(currentState);
		log.info(`Loop iteration ${i + 1}: running ${goal.name}`);

		let result: GoalResult;
		try {
			result = await goal.execute({
				endpoints: ctx.endpoints,
				state: currentState,
				...(ctx.refreshState ? { refreshState: ctx.refreshState } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
		} catch (err) {
			// An exception during an aborted iteration is cancellation, not a failure —
			// don't count it toward maxConsecutiveFailures or schedule a retry.
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
			// Respect the server's retry-after for rate limits; otherwise use configured delay.
			const delay = err instanceof RateLimitError ? err.retryAfterSeconds * 1000 : retryDelayMs;
			log.warn(
				`Loop iteration ${i + 1} threw exception (failure ${consecutiveFailures}/${maxConsecutiveFailures}): ${errorMessage(
					err,
				)}`,
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

			log.info(`Retrying iteration ${i + 1} in ${delay}ms...`);
			await abortableDelay(delay, options.signal);
			currentState = await refreshBeforeRetry(ctx, currentState);
			continue;
		}

		if (!result.success) {
			totalTicks += result.ticksUsed;
			options.onIterationComplete?.(i + 1, result);

			// A failure caused by an abort is cancellation, not a failure —
			// don't count it toward maxConsecutiveFailures or schedule a retry.
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

		// Iteration succeeded — reset failure counter, record, advance
		consecutiveFailures = 0;
		pushIteration(iterations, { iteration: i, result });
		totalTicks += result.ticksUsed;
		options.onIterationComplete?.(i + 1, result);
		log.info(`Loop iteration ${i + 1} complete: ${result.ticksUsed} tick(s)`);

		// Refresh state between iterations
		if (ctx.refreshState) {
			currentState = await ctx.refreshState();
		}

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
