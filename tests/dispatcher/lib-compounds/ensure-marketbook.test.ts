import { describe, expect, test } from "bun:test";
import { LibEnsureMarketbook } from "../../../src/dispatcher/lib-compounds/ensure-marketbook.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

function ordersPage(orders: unknown[] = [], hasMore = false): unknown {
	return { result: "", structuredContent: { orders, has_more: hasMore } };
}

describe("LibEnsureMarketbook", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibEnsureMarketbook({ targetOrders: [] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("requires being docked");
	});

	test("already satisfied when there are no target orders and nothing to cancel", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{ view_orders: () => ordersPage([]) },
		);
		const result = await new LibEnsureMarketbook({ targetOrders: [] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("creates a missing sell order", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view_orders: () => ordersPage([]),
				create_sell_order: () => ({
					command: "create_sell_order",
					tick: 0,
					delta: {
						details: {
							action: "create_sell_order",
							mode: "bulk",
							results: [{ index: 0, success: true, order_id: "order-9" }],
							summary: { succeeded: 1, failed: 0, total: 1 },
						},
					},
				}),
			},
		);
		const result = await new LibEnsureMarketbook({
			targetOrders: [{ itemId: "iron_ore", side: "sell", quantity: 10, price: 5 }],
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.message).toContain("1 created");
		expect(account.calls.some((c) => c.action === "create_sell_order")).toBe(true);
	});
});
