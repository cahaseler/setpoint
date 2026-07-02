import { describe, expect, test } from "bun:test";
import { LibLoadAtStation } from "../../../src/dispatcher/lib-compounds/load-at-station.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibLoadAtStation", () => {
	test("loads from personal storage when already at station", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 0,
				},
				cargo: [],
			},
			{
				view: () => ({
					result: "",
					structuredContent: {
						base_id: "sol_base",
						hint: "",
						items: [{ item_id: "iron_ore", name: "Iron Ore", quantity: 20, size: 1 }],
					},
				}),
				withdraw: () => {
					account.setState({ cargo: [{ item_id: "iron_ore", quantity: 20, size: 1 }] });
					return { command: "withdraw", tick: 0, delta: {} };
				},
			},
		);

		const result = await new LibLoadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			sourceType: "personal-storage",
			items: [{ itemId: "iron_ore", quantity: 20 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"prepare-at-station",
			"load-from-storage",
		]);
		expect(account.calls.some((c) => c.action === "withdraw")).toBe(true);
	});

	test("fails when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await new LibLoadAtStation({
			systemId: "alpha",
			poiId: "sol_station",
			baseId: "sol_base",
			sourceType: "personal-storage",
			items: [{ itemId: "iron_ore", quantity: 20 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.steps.every((s) => s.goalName !== "load-from-storage")).toBe(true);
	});
});
