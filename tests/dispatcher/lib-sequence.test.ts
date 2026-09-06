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

describe("runLibSequence reconnect resilience", () => {
	test("a step follows the account through a reconnect mid-step", async () => {
		// The lib replaces the Account instance on reconnect. A step that pinned
		// the instance it started with would keep talking to a dead socket — and
		// a step can run for minutes (go-to-poi polls arrival for up to 600s).
		const original = new FakeLibGoalAccount({ location: { system_id: "sol" } });
		const afterReconnect = new FakeLibGoalAccount({ location: { system_id: "sirius" } });

		let live: FakeLibGoalAccount = original;
		const outer = makeLibGoalContext(() => live);

		const observed: Array<string | undefined> = [];
		const step: LibGoal = {
			name: "long-step",
			async execute(ctx) {
				observed.push(ctx.state.location?.system_id);
				// The socket drops and the lib hands us a new Account.
				live = afterReconnect;
				observed.push(ctx.state.location?.system_id);
				return { success: true, message: "ok", alreadySatisfied: false, ticksUsed: 0 };
			},
		};

		const result = await runLibSequence([step], outer);

		expect(result.success).toBe(true);
		expect(observed).toEqual(["sol", "sirius"]);
	});

	test("a later step uses the reconnected account, not the one the sequence started with", async () => {
		const original = new FakeLibGoalAccount({ location: { system_id: "sol" } });
		const afterReconnect = new FakeLibGoalAccount({ location: { system_id: "sirius" } });

		let live: FakeLibGoalAccount = original;
		const outer = makeLibGoalContext(() => live);

		const seen: Array<string | undefined> = [];
		const ok = { success: true, message: "ok", alreadySatisfied: false, ticksUsed: 0 };
		const first: LibGoal = {
			name: "first",
			async execute() {
				live = afterReconnect;
				return ok;
			},
		};
		const second: LibGoal = {
			name: "second",
			async execute(ctx) {
				seen.push(ctx.state.location?.system_id);
				return ok;
			},
		};

		await runLibSequence([first, second], outer);
		expect(seen).toEqual(["sirius"]);
	});
});
