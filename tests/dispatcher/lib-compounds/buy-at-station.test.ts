import { describe, expect, test } from "bun:test";
import { LibBuyAtStation } from "../../../src/dispatcher/lib-compounds/buy-at-station.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

const marketItem = {
	action: "view_market",
	base: "Sol Central",
	base_id: "sol_base",
	current_tick: 1,
	items: [
		{
			item_id: "fuel_cell",
			item_name: "Fuel Cell",
			best_buy: 0,
			best_buy_qty: 0,
			best_sell: 50,
			best_sell_qty: 500,
			buy_orders: [],
			buy_price: 0,
			buy_quantity: 0,
			category: "fuel",
			sell_orders: [{ price_each: 50, quantity: 500 }],
			sell_price: 50,
			sell_quantity: 500,
		},
	],
};

describe("LibBuyAtStation", () => {
	test("already at station — buys items from market", async () => {
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
			},
			{
				view_market: () => ({ result: "", structuredContent: marketItem }),
				buy: () => {
					account.setState({
						cargo: [{ item_id: "fuel_cell", item_name: "Fuel Cell", quantity: 10, size: 1 }],
					});
					return {
						command: "buy",
						tick: 0,
						delta: { details: { item_id: "fuel_cell", quantity: 10, total_cost: 500 } },
					};
				},
			},
		);

		const result = await new LibBuyAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "fuel_cell", maxPrice: 100 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
		expect(result.steps.map((s) => s.goalName)).toEqual(["prepare-at-station", "buy-items"]);
	});

	test("fails when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await new LibBuyAtStation({
			systemId: "alpha",
			poiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "fuel_cell", maxPrice: 100 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.steps.every((s) => s.goalName !== "buy-items")).toBe(true);
	});
});
