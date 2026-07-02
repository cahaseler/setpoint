import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibCreateBuyOrder } from "../../../src/dispatcher/lib-primitives/create-buy-order.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibCreateBuyOrder", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibCreateBuyOrder("iron_ore", 10, 5).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
		expect(account.calls).toHaveLength(0);
	});

	test("creates a buy order and reports filled/listed quantities", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				create_buy_order: () => ({
					command: "create_buy_order",
					tick: 0,
					delta: {
						details: {
							action: "create_buy_order",
							item: "Iron Ore",
							item_id: "iron_ore",
							listing_fee: 1,
							message: "",
							price_each: 5,
							quantity: 10,
							quantity_filled: 4,
							quantity_listed: 6,
							total_escrowed: 50,
						},
					},
				}),
			},
		);
		const result = await new LibCreateBuyOrder("iron_ore", 10, 5).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("4 filled, 6 listed @ 5 each");
		expect(account.calls[0]).toEqual({
			action: "create_buy_order",
			params: { item_id: "iron_ore", quantity: 10, price_each: 5 },
		});
	});
});
