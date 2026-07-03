import { describe, expect, test } from "bun:test";
import { LibEnhancedMiningRun } from "../../../src/dispatcher/lib-compounds/enhanced-mining-run.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibEnhancedMiningRun", () => {
	test("already at belt — mines until cargo full with no junk to jettison", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "belt_1" },
				ship: { cargo_used: 90, cargo_capacity: 100 },
				cargo: [],
			},
			{
				mine: () => {
					account.setState({ ship: { cargo_used: 100, cargo_capacity: 100 } });
					return fakeMutationResult("mine");
				},
			},
		);

		const result = await new LibEnhancedMiningRun({
			systemId: "sol",
			beltPoiId: "belt_1",
			junkItemIds: ["rock_dust"],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"navigate-to-system",
			"go-to-poi",
			"ensure-undocked",
			"mine-with-jettison",
		]);
		expect(account.calls.some((c) => c.action === "mine")).toBe(true);
		expect(account.calls.some((c) => c.action === "jettison")).toBe(false);
	});

	test("mines, jettisons junk, then mines again", async () => {
		let mineCalls = 0;
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "belt_1" },
				ship: { cargo_used: 90, cargo_capacity: 100 },
				cargo: [],
			},
			{
				mine: () => {
					mineCalls++;
					if (mineCalls === 1) {
						account.setState({
							ship: { cargo_used: 100, cargo_capacity: 100 },
							cargo: [{ item_id: "rock_dust", quantity: 20 }],
						});
					} else {
						account.setState({ ship: { cargo_used: 100, cargo_capacity: 100 } });
					}
					return fakeMutationResult("mine");
				},
				jettison: () => {
					account.setState({ ship: { cargo_used: 80, cargo_capacity: 100 }, cargo: [] });
					return {
						command: "jettison",
						tick: 0,
						delta: { details: { item_id: "rock_dust", item_name: "Rock Dust", quantity: 20 } },
					};
				},
			},
		);

		const result = await new LibEnhancedMiningRun({
			systemId: "sol",
			beltPoiId: "belt_1",
			junkItemIds: ["rock_dust"],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "jettison")).toBe(true);
		expect(mineCalls).toBe(2);
	});

	test("travel failure stops before mining", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await new LibEnhancedMiningRun({
			systemId: "alpha",
			beltPoiId: "belt_1",
			junkItemIds: ["rock_dust"],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.steps.every((s) => s.goalName !== "mine-with-jettison")).toBe(true);
	});
});
