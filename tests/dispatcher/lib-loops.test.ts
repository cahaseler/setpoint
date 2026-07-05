import { describe, expect, test } from "bun:test";
import type { GoalResult } from "../../src/dispatcher/goals.js";
import { alreadySatisfied, failed, succeeded } from "../../src/dispatcher/goals.js";
import type { LibGoal } from "../../src/dispatcher/lib-goal-context.js";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { runLibLoop } from "../../src/dispatcher/lib-loops.js";
import { FakeLibGoalAccount } from "./lib-fakes.js";

/** A goal whose execute is supplied per-test. */
function goal(name: string, run: () => Promise<GoalResult> | GoalResult): LibGoal {
	return { name, execute: () => Promise.resolve(run()) };
}

describe("runLibLoop", () => {
	test("runs maxIterations successful iterations", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 100 } });
		let count = 0;
		const result = await runLibLoop(
			() =>
				goal("x", () => {
					count++;
					return succeeded("ok", 1);
				}),
			makeLibGoalContext(account),
			{ maxIterations: 3 },
		);
		expect(result.success).toBe(true);
		expect(count).toBe(3);
		expect(result.iterationCount).toBe(3);
		expect(result.ticksUsed).toBe(3);
	});

	test("stops when shouldContinue returns false", async () => {
		const account = new FakeLibGoalAccount({});
		const result = await runLibLoop(
			() => goal("x", () => succeeded("ok", 0)),
			makeLibGoalContext(account),
			{ maxIterations: 10, shouldContinue: (i) => i < 2 },
		);
		expect(result.iterationCount).toBe(2);
		expect(result.message).toContain("stopped");
	});

	test("stops after maxConsecutiveFailures", async () => {
		const account = new FakeLibGoalAccount({});
		const result = await runLibLoop(
			() => goal("x", () => failed("nope", 0)),
			makeLibGoalContext(account),
			{ maxConsecutiveFailures: 2, retryDelayMs: 1 },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("consecutive failure");
	});

	test("a success resets the consecutive failure counter", async () => {
		const account = new FakeLibGoalAccount({});
		const outcomes = [false, false, true, false, false];
		let idx = 0;
		const result = await runLibLoop(
			() =>
				goal("x", () => {
					const ok = outcomes[idx++] ?? true;
					return ok ? succeeded("ok", 1) : failed("bad", 0);
				}),
			makeLibGoalContext(account),
			{ maxIterations: 3, maxConsecutiveFailures: 3, retryDelayMs: 1 },
		);
		// 2 fails, 1 success (resets), then advances — never hits 3 consecutive.
		expect(result.success).toBe(true);
	});

	test("counts a thrown exception as a failure", async () => {
		const account = new FakeLibGoalAccount({});
		const result = await runLibLoop(
			() =>
				goal("x", () => {
					throw new Error("boom");
				}),
			makeLibGoalContext(account),
			{ maxConsecutiveFailures: 1, retryDelayMs: 1 },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("boom");
	});

	test("aborts cleanly when signal fires", async () => {
		const account = new FakeLibGoalAccount({});
		const controller = new AbortController();
		const result = await runLibLoop(
			() =>
				goal("x", () => {
					controller.abort();
					return succeeded("ok", 1);
				}),
			makeLibGoalContext(account),
			{ maxIterations: 10, signal: controller.signal },
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain("cancelled");
	});

	test("ignoreFailure retries without counting toward the failure cap", async () => {
		const account = new FakeLibGoalAccount({});
		let calls = 0;
		const result = await runLibLoop(
			() =>
				goal("x", () => {
					calls++;
					return calls < 3 ? failed("transient", 0) : succeeded("ok", 1);
				}),
			makeLibGoalContext(account),
			{ maxIterations: 1, maxConsecutiveFailures: 1, retryDelayMs: 1, ignoreFailure: () => true },
		);
		expect(result.success).toBe(true);
		expect(calls).toBe(3);
	});

	test("uses alreadySatisfied results as successful iterations", async () => {
		const account = new FakeLibGoalAccount({});
		const result = await runLibLoop(
			() => goal("x", () => alreadySatisfied("done")),
			makeLibGoalContext(account),
			{ maxIterations: 1 },
		);
		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
	});

	test("onIterationComplete fires on a successful iteration", async () => {
		const account = new FakeLibGoalAccount({});
		const calls: Array<[number, string]> = [];
		await runLibLoop(() => goal("x", () => succeeded("done", 1)), makeLibGoalContext(account), {
			maxIterations: 1,
			onIterationComplete: (iter, result) => calls.push([iter, result.message]),
		});
		expect(calls).toEqual([[1, "done"]]);
	});

	test("onIterationComplete fires on a failed iteration, before the retry", async () => {
		// loop-manager.ts relies on this firing even on failure — it's how a stuck
		// loop's LoopStatus.lastStep/lastStepAt still advances on every retry attempt,
		// not just on eventual success.
		const account = new FakeLibGoalAccount({});
		const calls: Array<[number, string]> = [];
		const result = await runLibLoop(
			() => goal("x", () => failed("nope", 0)),
			makeLibGoalContext(account),
			{
				maxConsecutiveFailures: 1,
				retryDelayMs: 1,
				onIterationComplete: (iter, r) => calls.push([iter, r.message]),
			},
		);
		expect(result.success).toBe(false);
		expect(calls).toEqual([[1, "nope"]]);
	});
});
