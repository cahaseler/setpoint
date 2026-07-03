import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibSellOrDepositCargo } from "../../../src/dispatcher/lib-primitives/sell-or-deposit-cargo.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibSellOrDepositCargo", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {}, cargo: [] });
		const result = await new LibSellOrDepositCargo().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when cargo is empty", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" }, cargo: [] });
		const result = await new LibSellOrDepositCargo().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("lists priced items on market and deposits the rest", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				cargo: [
					{ item_id: "iron_ore", quantity: 5 },
					{ item_id: "rock_dust", quantity: 3 },
				],
			},
			{
				create_sell_order: () => ({
					command: "create_sell_order",
					tick: 0,
					delta: {
						details: {
							action: "create_sell_order",
							mode: "bulk",
							results: [{ index: 0, success: true, order_id: "order-1" }],
							summary: { succeeded: 1, failed: 0, total: 1 },
						},
					},
				}),
				deposit: () => ({
					command: "deposit",
					tick: 0,
					delta: {
						details: {
							action: "deposit",
							requested: 1,
							succeeded: 1,
							failed: 0,
							results: [{ item_id: "rock_dust", quantity: 3, success: true }],
						},
					},
				}),
			},
		);
		const result = await new LibSellOrDepositCargo({
			skipMarket: true,
			listPrices: { iron_ore: 10 },
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(result.message).toContain("1 listed on market");
		expect(result.message).toContain("1 deposited to storage");

		const sellCall = account.calls.find((c) => c.action === "create_sell_order");
		expect(sellCall?.params).toMatchObject({
			orders: [{ item_id: "iron_ore", quantity: 5, price_each: 10 }],
		});
		const depositCall = account.calls.find((c) => c.action === "deposit");
		expect(depositCall?.params).toMatchObject({
			items: [{ item_id: "rock_dust", quantity: 3 }],
			target: "self",
		});
	});
});
