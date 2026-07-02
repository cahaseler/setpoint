import { describe, expect, test } from "bun:test";
import type { GoalResult, ProgressRef } from "../../src/dispatcher/goals.js";
import { alreadySatisfied, failed, succeeded } from "../../src/dispatcher/goals.js";
import type { LibGoal } from "../../src/dispatcher/lib-goal-context.js";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { runLibSequence } from "../../src/dispatcher/lib-sequence.js";
import { FakeLibGoalAccount } from "./lib-fakes.js";

function goal(name: string, run: () => Promise<GoalResult> | GoalResult): LibGoal {
	return { name, execute: () => Promise.resolve(run()) };
}

describe("runLibSequence", () => {
	test("runs all steps in order and sums ticks", async () => {
		const order: string[] = [];
		const account = new FakeLibGoalAccount({});
		const result = await runLibSequence(
			[
				goal("a", () => {
					order.push("a");
					return succeeded("a", 1);
				}),
				goal("b", () => {
					order.push("b");
					return succeeded("b", 2);
				}),
			],
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(order).toEqual(["a", "b"]);
		expect(result.ticksUsed).toBe(3);
		expect(result.steps).toHaveLength(2);
	});

	test("stops at the first failing step", async () => {
		const order: string[] = [];
		const account = new FakeLibGoalAccount({});
		const result = await runLibSequence(
			[
				goal("a", () => {
					order.push("a");
					return succeeded("a", 1);
				}),
				goal("b", () => {
					order.push("b");
					return failed("b failed", 0);
				}),
				goal("c", () => {
					order.push("c");
					return succeeded("c", 1);
				}),
			],
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(order).toEqual(["a", "b"]); // c never runs
		expect(result.message).toContain("Failed at b");
	});

	test("reports alreadySatisfied when every step is already satisfied", async () => {
		const account = new FakeLibGoalAccount({});
		const result = await runLibSequence(
			[goal("a", () => alreadySatisfied("a")), goal("b", () => alreadySatisfied("b"))],
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("aborts before a step when the signal fires", async () => {
		const controller = new AbortController();
		const account = new FakeLibGoalAccount({});
		const result = await runLibSequence(
			[
				goal("a", () => {
					controller.abort();
					return succeeded("a", 1);
				}),
				goal("b", () => succeeded("b", 1)),
			],
			makeLibGoalContext(account, controller.signal),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Aborted before b");
	});

	test("updates the progress ref as steps execute", async () => {
		const account = new FakeLibGoalAccount({});
		const progressRef: ProgressRef = {
			goalType: "seq",
			completedSteps: [],
			remainingSteps: [],
		};
		await runLibSequence(
			[goal("a", () => succeeded("a", 1)), goal("b", () => succeeded("b", 1))],
			makeLibGoalContext(account),
			progressRef,
		);
		expect(progressRef.completedSteps).toEqual(["a", "b"]);
		expect(progressRef.remainingSteps).toEqual([]);
		expect(progressRef.currentStep).toBeUndefined();
	});
});
