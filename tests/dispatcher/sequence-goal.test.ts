import { describe, expect, test } from "bun:test";
import type { Goal, GoalResult } from "../../src/dispatcher/goals.js";
import { SequenceGoal } from "../../src/dispatcher/sequence-goal.js";
import { createMockEndpoints } from "../fixtures/mock-endpoints.js";

function stubGoal(name: string, result: GoalResult): Goal {
	return {
		name,
		execute: async () => result,
	};
}

describe("SequenceGoal", () => {
	test("delegates to runSequence and returns CompoundGoalResult", async () => {
		const steps = [
			stubGoal("step-a", { success: true, message: "ok", alreadySatisfied: true, ticksUsed: 0 }),
			stubGoal("step-b", { success: true, message: "done", alreadySatisfied: false, ticksUsed: 1 }),
		];

		const goal = new SequenceGoal("test-sequence", steps);
		expect(goal.name).toBe("test-sequence");

		const result = await goal.execute({
			endpoints: createMockEndpoints(),
			state: {
				player: { id: "p1", username: "Test", credits: 100 },
				ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
				cargo: undefined,
				location: { system_id: "sol", system_name: "Sol" },
				modules: undefined,
				skills: undefined,
				missions: undefined,
				queue: undefined,
				updatedAt: "2026-01-01T00:00:00Z",
			},
		});

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(result.steps).toHaveLength(2);
		expect(result.steps.map((s) => s.goalName)).toEqual(["step-a", "step-b"]);
	});

	test("stops on failure like runSequence", async () => {
		const steps = [
			stubGoal("good", { success: true, message: "ok", alreadySatisfied: false, ticksUsed: 1 }),
			stubGoal("bad", { success: false, message: "boom", alreadySatisfied: false, ticksUsed: 0 }),
			stubGoal("skip", { success: true, message: "never", alreadySatisfied: false, ticksUsed: 1 }),
		];

		const goal = new SequenceGoal("failing-sequence", steps);
		const result = await goal.execute({
			endpoints: createMockEndpoints(),
			state: {
				player: { id: "p1", username: "Test", credits: 100 },
				ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
				cargo: undefined,
				location: { system_id: "sol", system_name: "Sol" },
				modules: undefined,
				skills: undefined,
				missions: undefined,
				queue: undefined,
				updatedAt: "2026-01-01T00:00:00Z",
			},
		});

		expect(result.success).toBe(false);
		expect(result.steps).toHaveLength(2);
	});
});
