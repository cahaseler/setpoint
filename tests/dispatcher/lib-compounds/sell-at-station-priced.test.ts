import { describe, expect, test } from "bun:test";
import { LibSellAtStationPriced } from "../../../src/dispatcher/lib-compounds/sell-at-station-priced.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibSellAtStationPriced", () => {
	test("lists cargo for sale at configured min prices", async () => {
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
			{ create_sell_order: () => fakeMutationResult("create_sell_order") },
		);

		const result = await new LibSellAtStationPriced({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "iron_ore", minPrice: 10 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"prepare-at-station",
			"list-cargo-for-sale",
		]);
		expect(account.calls.some((c) => c.action === "create_sell_order")).toBe(true);
	});

	test("fails when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await new LibSellAtStationPriced({
			systemId: "alpha",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "iron_ore", minPrice: 10 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.steps.every((s) => s.goalName !== "list-cargo-for-sale")).toBe(true);
	});
});
