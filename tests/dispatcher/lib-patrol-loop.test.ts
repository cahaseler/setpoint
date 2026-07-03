import { describe, expect, test } from "bun:test";
import { succeeded } from "../../src/dispatcher/goals.js";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { formatSliceReport, libPatrolLoop } from "../../src/dispatcher/lib-patrol-loop.js";
import { FakeLibGoalAccount, fakeMutationResult } from "./lib-fakes.js";

describe("libPatrolLoop", () => {
	test("navigates alternating targets for maxIterations", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({
					result: "",
					structuredContent: {
						cargo_used: 0,
						estimated_fuel: 1,
						found: true,
						fuel_available: 100,
						fuel_per_jump: 1,
						message: "",
						total_jumps: 1,
						target_system: "t",
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
					},
				}),
				jump: () => fakeMutationResult("jump"),
			},
		);
		account.refreshReturns = { location: { system_id: "alpha", poi_id: "p" } };
		const result = await libPatrolLoop(makeLibGoalContext(account), ["alpha", "beta"], {
			maxIterations: 2,
		});
		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
	});
});

describe("formatSliceReport", () => {
	test("includes label, outcome, ticks, and delta sections", () => {
		const out = formatSliceReport("navigate", succeeded("Navigated in 2 jumps", 2), [
			"location",
			"ship",
		]);
		expect(out).toContain("navigate");
		expect(out).toContain("success");
		expect(out).toContain("2");
		expect(out).toContain("location");
	});
});
