import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibCancelOrders } from "../../../src/dispatcher/lib-primitives/cancel-orders.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibCancelOrders", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibCancelOrders({ orderIds: ["order-1"] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("fails when orderIds is empty", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" } });
		const result = await new LibCancelOrders({ orderIds: [] }).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("orderIds array is empty");
		expect(account.calls).toHaveLength(0);
	});

	test("cancels orders in bulk and reports succeeded/failed counts", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				cancel_order: () => ({
					command: "cancel_order",
					tick: 0,
					delta: {
						details: {
							action: "cancel_order",
							mode: "bulk",
							results: [
								{ index: 0, success: true, order_id: "order-1" },
								{ index: 1, success: false, error: "not_found" },
							],
							summary: { succeeded: 1, failed: 1, total: 2 },
						},
					},
				}),
			},
		);
		const result = await new LibCancelOrders({ orderIds: ["order-1", "order-2"] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toBe("Cancelled 1 order(s), 1 failed");
		expect(account.calls[0]).toEqual({
			action: "cancel_order",
			params: { order_ids: ["order-1", "order-2"] },
		});
	});
});
