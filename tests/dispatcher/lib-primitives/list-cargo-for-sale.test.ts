import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibListCargoForSale } from "../../../src/dispatcher/lib-primitives/list-cargo-for-sale.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibListCargoForSale", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {}, cargo: [] });
		const result = await new LibListCargoForSale({ items: [] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when cargo is empty", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" }, cargo: [] });
		const result = await new LibListCargoForSale({ items: [] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("lists matching cargo items and skips unconfigured ones", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				cargo: [
					{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 5 },
					{ item_id: "steel_plate", quantity: 3 },
				],
			},
			{
				create_sell_order: () => ({ command: "create_sell_order", tick: 0, delta: {} }),
			},
		);
		const result = await new LibListCargoForSale({
			items: [{ itemId: "iron_ore", minPrice: 10 }],
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("5x Iron Ore @ 10");
		expect(account.calls).toHaveLength(1);
		expect(account.calls[0]).toEqual({
			action: "create_sell_order",
			params: { item_id: "iron_ore", quantity: 5, price_each: 10 },
		});
	});
});
