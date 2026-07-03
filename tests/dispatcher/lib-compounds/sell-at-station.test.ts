import { describe, expect, test } from "bun:test";
import { LibSellAtStation } from "../../../src/dispatcher/lib-compounds/sell-at-station.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibSellAtStation", () => {
	test("deposits cargo with no market buyers when already at station", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 10,
				},
				cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
			},
			{
				view_market: () => ({
					result: "",
					structuredContent: {
						action: "view_market",
						base: "Sol Central",
						base_id: "sol_base",
						current_tick: 1,
						items: [],
					},
				}),
				deposit: () => fakeMutationResult("deposit"),
			},
		);

		const result = await new LibSellAtStation({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"prepare-at-station",
			"sell-or-deposit-cargo",
		]);
		expect(account.calls.some((c) => c.action === "deposit")).toBe(true);
	});

	test("fails when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await new LibSellAtStation({
			systemId: "alpha",
			stationPoiId: "sol_station",
			baseId: "sol_base",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.steps.every((s) => s.goalName !== "sell-or-deposit-cargo")).toBe(true);
	});
});
