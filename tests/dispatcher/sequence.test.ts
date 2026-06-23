import { describe, expect, test } from "bun:test";
import type { Goal, GoalContext, GoalResult } from "../../src/dispatcher/goals.js";
import { runSequence } from "../../src/dispatcher/sequence.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints } from "../fixtures/mock-endpoints.js";

/** Simple goal stub that returns a preconfigured result. */
function stubGoal(name: string, result: GoalResult): Goal {
	return {
		name,
		execute: async () => result,
	};
}

function makeCtx(overrides: Partial<GoalContext> = {}): GoalContext {
	return {
		endpoints: createMockEndpoints(),
		state: {
			player: { id: "p1", username: "Test", credits: 100 },
			ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
			cargo: undefined,
			location: { system_id: "sol", system_name: "Sol", docked_at: "base1" },
			modules: undefined,
			skills: undefined,
			missions: undefined,
			queue: undefined,
			updatedAt: "2026-01-01T00:00:00Z",
		},
		...overrides,
	};
}

describe("runSequence", () => {
	test("returns all-satisfied when every step is already satisfied", async () => {
		const steps = [
			stubGoal("step-a", { success: true, message: "ok", alreadySatisfied: true, ticksUsed: 0 }),
			stubGoal("step-b", { success: true, message: "ok", alreadySatisfied: true, ticksUsed: 0 }),
		];

		const result = await runSequence(steps, makeCtx());

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.steps).toHaveLength(2);
	});

	test("accumulates ticks from successful steps", async () => {
		const steps = [
			stubGoal("step-a", {
				success: true,
				message: "done",
				alreadySatisfied: false,
				ticksUsed: 2,
			}),
			stubGoal("step-b", {
				success: true,
				message: "done",
				alreadySatisfied: false,
				ticksUsed: 1,
			}),
		];

		const result = await runSequence(steps, makeCtx());

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(3);
		expect(result.steps).toHaveLength(2);
	});

	test("stops on first failure", async () => {
		const steps = [
			stubGoal("step-a", {
				success: true,
				message: "ok",
				alreadySatisfied: false,
				ticksUsed: 1,
			}),
			stubGoal("step-b", {
				success: false,
				message: "boom",
				alreadySatisfied: false,
				ticksUsed: 0,
			}),
			stubGoal("step-c", {
				success: true,
				message: "never reached",
				alreadySatisfied: false,
				ticksUsed: 1,
			}),
		];

		const result = await runSequence(steps, makeCtx());

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(result.steps).toHaveLength(2);
		expect(result.message).toContain("step-b");
		expect(result.message).toContain("step-a");
	});

	test("reports failure at first step clearly", async () => {
		const steps = [
			stubGoal("step-a", {
				success: false,
				message: "nope",
				alreadySatisfied: false,
				ticksUsed: 0,
			}),
		];

		const result = await runSequence(steps, makeCtx());

		expect(result.success).toBe(false);
		expect(result.message).toContain("Failed at first step");
	});

	test("refreshes state after mutation steps", async () => {
		let refreshCount = 0;
		const freshState: StoredGameState = {
			player: { id: "p1", username: "Test", credits: 200 },
			ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
			cargo: undefined,
			location: { system_id: "alpha", system_name: "Alpha", docked_at: "base2" },
			modules: undefined,
			skills: undefined,
			missions: undefined,
			queue: undefined,
			updatedAt: "2026-01-01T00:01:00Z",
		};

		const statesSeenBySteps: StoredGameState[] = [];

		const steps: Goal[] = [
			{
				name: "mutator",
				execute: async (ctx) => {
					statesSeenBySteps.push(ctx.state);
					return { success: true, message: "jumped", alreadySatisfied: false, ticksUsed: 1 };
				},
			},
			{
				name: "reader",
				execute: async (ctx) => {
					statesSeenBySteps.push(ctx.state);
					return { success: true, message: "ok", alreadySatisfied: true, ticksUsed: 0 };
				},
			},
		];

		const ctx = makeCtx({
			refreshState: async () => {
				refreshCount++;
				return freshState;
			},
		});

		await runSequence(steps, ctx);

		// State should have been refreshed after the mutation step
		expect(refreshCount).toBe(1);
		// First step sees original state, second sees refreshed state
		expect(statesSeenBySteps[0]?.location?.system_id).toBe("sol");
		expect(statesSeenBySteps[1]?.location?.system_id).toBe("alpha");
	});

	test("does not refresh state after already-satisfied steps", async () => {
		let refreshCount = 0;

		const steps = [
			stubGoal("satisfied", {
				success: true,
				message: "ok",
				alreadySatisfied: true,
				ticksUsed: 0,
			}),
			stubGoal("next", {
				success: true,
				message: "ok",
				alreadySatisfied: true,
				ticksUsed: 0,
			}),
		];

		const ctx = makeCtx({
			refreshState: async () => {
				refreshCount++;
				return ctx.state;
			},
		});

		await runSequence(steps, ctx);

		expect(refreshCount).toBe(0);
	});

	test("works without refreshState callback", async () => {
		const steps = [
			stubGoal("step-a", {
				success: true,
				message: "done",
				alreadySatisfied: false,
				ticksUsed: 1,
			}),
			stubGoal("step-b", {
				success: true,
				message: "done",
				alreadySatisfied: false,
				ticksUsed: 1,
			}),
		];

		// No refreshState provided
		const result = await runSequence(steps, makeCtx());

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
	});

	test("handles empty step list", async () => {
		const result = await runSequence([], makeCtx());

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.steps).toHaveLength(0);
	});

	test("mixed satisfied and mutation steps", async () => {
		let refreshCount = 0;

		const steps = [
			stubGoal("already-there", {
				success: true,
				message: "ok",
				alreadySatisfied: true,
				ticksUsed: 0,
			}),
			stubGoal("dock", {
				success: true,
				message: "docked",
				alreadySatisfied: false,
				ticksUsed: 1,
			}),
			stubGoal("refuel", {
				success: true,
				message: "fueled",
				alreadySatisfied: false,
				ticksUsed: 1,
			}),
		];

		const ctx = makeCtx({
			refreshState: async () => {
				refreshCount++;
				return ctx.state;
			},
		});

		const result = await runSequence(steps, ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(2);
		// Refresh after dock (before refuel), but not after already-there (before dock)
		expect(refreshCount).toBe(1);
	});
});
