import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibBuyItems } from "../../../src/dispatcher/lib-primitives/buy-items.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibBuyItems", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibBuyItems({ items: [] }).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when no items configured", async () => {
		const account = new FakeLibGoalAccount({
			location: { docked_at: "station-1" },
			ship: { cargo_capacity: 100, cargo_used: 0 },
		});
		const result = await new LibBuyItems({ items: [] }).execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("buys items at or below max price and reports cost", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				ship: { cargo_capacity: 100, cargo_used: 0 },
			},
			{
				view_market: () => ({
					result: "",
					structuredContent: {
						action: "view_market",
						base: "station-1",
						base_id: "station-1",
						current_tick: 1,
						items: [
							{
								item_id: "iron_ore",
								item_name: "Iron Ore",
								best_buy: 5,
								best_buy_qty: 10,
								best_sell: 8,
								best_sell_qty: 20,
								buy_orders: [],
								buy_price: 5,
								buy_quantity: 10,
								category: "ore",
								sell_orders: [{ price_each: 8, quantity: 20 }],
								sell_price: 8,
								sell_quantity: 20,
							},
						],
					},
				}),
				buy: () => ({
					command: "buy",
					tick: 0,
					delta: {
						details: {
							action: "buy",
							delivered_to_cargo: 10,
							fills: [],
							item: "Iron Ore",
							item_id: "iron_ore",
							level_up: false,
							quantity: 10,
							total_cost: 80,
						},
					},
				}),
			},
		);
		const result = await new LibBuyItems({
			items: [{ itemId: "iron_ore", maxPrice: 10, maxQuantity: 10 }],
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("10x iron_ore for 80cr");
		expect(account.calls[1]).toEqual({ action: "buy", params: { id: "iron_ore", quantity: 10 } });
	});
});
