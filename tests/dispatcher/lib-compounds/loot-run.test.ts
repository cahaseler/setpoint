import { describe, expect, test } from "bun:test";
import { LibLootRun } from "../../../src/dispatcher/lib-compounds/loot-run.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibLootRun", () => {
	test("already at salvage site — loots wreck until cargo full", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "salvage_1" },
				ship: { cargo_used: 50, cargo_capacity: 100 },
			},
			{
				wrecks: () => ({
					result: "",
					structuredContent: {
						wrecks: [{ id: "wreck-1", cargo: [{ item_id: "iron_ore", quantity: 5 }] }],
					},
				}),
				loot: () => {
					account.setState({ ship: { cargo_used: 100, cargo_capacity: 100 } });
					return {
						command: "loot",
						tick: 0,
						delta: { details: { wreck_empty: true, quantity: 5 } },
					};
				},
			},
		);

		const result = await new LibLootRun({ systemId: "sol", salvagePoiId: "salvage_1" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"navigate-to-system",
			"go-to-poi",
			"ensure-undocked",
			"loot-until-full",
		]);
		expect(account.calls.some((c) => c.action === "loot")).toBe(true);
	});

	test("travel failure stops before looting", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await new LibLootRun({ systemId: "alpha", salvagePoiId: "salvage_1" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.steps.every((s) => s.goalName !== "loot-until-full")).toBe(true);
	});
});
