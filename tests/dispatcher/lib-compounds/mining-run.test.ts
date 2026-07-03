import { describe, expect, test } from "bun:test";
import { LibMiningRun } from "../../../src/dispatcher/lib-compounds/mining-run.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibMiningRun", () => {
	test("already at belt — mines until cargo full", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "belt_1" },
				ship: { cargo_used: 90, cargo_capacity: 100 },
			},
			{
				mine: () => {
					account.setState({ ship: { cargo_used: 100, cargo_capacity: 100 } });
					return fakeMutationResult("mine");
				},
			},
		);

		const result = await new LibMiningRun({ systemId: "sol", beltPoiId: "belt_1" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"navigate-to-system",
			"go-to-poi",
			"ensure-undocked",
			"mine-until-full",
		]);
		expect(account.calls.some((c) => c.action === "mine")).toBe(true);
	});

	test("travel failure stops before mining", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await new LibMiningRun({ systemId: "alpha", beltPoiId: "belt_1" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.steps.every((s) => s.goalName !== "mine-until-full")).toBe(true);
	});
});
