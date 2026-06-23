import { describe, expect, mock, test } from "bun:test";
import type { BulkOrderResponse } from "../../../src/api/endpoints.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { CancelOrders } from "../../../src/dispatcher/primitives/cancel-orders.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
		cargo: [],
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "sol_station",
			poi_name: "Sol Central",
			docked_at: "sol_base",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function bulkCancelResponse(succeeded: number, failed: number): BulkOrderResponse {
	return {
		action: "cancel_order",
		mode: "bulk",
		results: [],
		summary: { succeeded, failed, total: succeeded + failed },
	};
}

describe("CancelOrders", () => {
	test("fails when not docked", async () => {
		const state = makeState({ location: { system_id: "sol", system_name: "Sol" } });
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new CancelOrders({ orderIds: ["o1"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("docked");
	});

	test("fails when orderIds is empty", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new CancelOrders({ orderIds: [] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("empty");
	});

	test("cancels a single batch of orders", async () => {
		const state = makeState();
		const cancelMock = mock(async () => mockApiResponse(bulkCancelResponse(3, 0)));
		const endpoints = createMockEndpoints({ cancelOrdersBulk: cancelMock });
		const ctx: GoalContext = { endpoints, state };

		const goal = new CancelOrders({ orderIds: ["o1", "o2", "o3"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("3");
		expect(cancelMock).toHaveBeenCalledTimes(1);
		expect(cancelMock).toHaveBeenCalledWith(["o1", "o2", "o3"]);
	});

	test("batches more than 50 orders into multiple ticks", async () => {
		const state = makeState();
		const orderIds = Array.from({ length: 75 }, (_, i) => `o${i}`);
		let callCount = 0;
		const cancelMock = mock(async (ids: unknown) => {
			const batch = ids as string[];
			callCount++;
			return mockApiResponse(bulkCancelResponse(batch.length, 0));
		});
		const endpoints = createMockEndpoints({ cancelOrdersBulk: cancelMock });
		const ctx: GoalContext = { endpoints, state };

		const goal = new CancelOrders({ orderIds });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(callCount).toBe(2);
		expect(result.message).toContain("75");
	});

	test("reports partial failures in message", async () => {
		const state = makeState();
		const cancelMock = mock(async () => mockApiResponse(bulkCancelResponse(2, 1)));
		const endpoints = createMockEndpoints({ cancelOrdersBulk: cancelMock });
		const ctx: GoalContext = { endpoints, state };

		const goal = new CancelOrders({ orderIds: ["o1", "o2", "o3"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("2");
		expect(result.message).toContain("1 failed");
	});

	test("exactly 50 orders uses one tick", async () => {
		const state = makeState();
		const orderIds = Array.from({ length: 50 }, (_, i) => `o${i}`);
		const cancelMock = mock(async () => mockApiResponse(bulkCancelResponse(50, 0)));
		const endpoints = createMockEndpoints({ cancelOrdersBulk: cancelMock });
		const ctx: GoalContext = { endpoints, state };

		const goal = new CancelOrders({ orderIds });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(cancelMock).toHaveBeenCalledTimes(1);
	});

	test("stops cancelling when the abort signal fires between batches", async () => {
		const state = makeState();
		const orderIds = Array.from({ length: 120 }, (_, i) => `o${i}`);
		const controller = new AbortController();
		const cancelMock = mock(async (ids: unknown) => {
			const batch = ids as string[];
			// Force abort lands while the first batch is in flight — there are more
			// batches queued, so only the signal can stop the loop.
			controller.abort();
			return mockApiResponse(bulkCancelResponse(batch.length, 0));
		});
		const endpoints = createMockEndpoints({ cancelOrdersBulk: cancelMock });
		const ctx: GoalContext = { endpoints, state, signal: controller.signal };

		const goal = new CancelOrders({ orderIds });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(result.ticksUsed).toBe(1);
		expect(cancelMock).toHaveBeenCalledTimes(1);
	});

	test("51 orders uses two ticks", async () => {
		const state = makeState();
		const orderIds = Array.from({ length: 51 }, (_, i) => `o${i}`);
		const batchSizes: number[] = [];
		const cancelMock = mock(async (ids: unknown) => {
			const batch = ids as string[];
			batchSizes.push(batch.length);
			return mockApiResponse(bulkCancelResponse(batch.length, 0));
		});
		const endpoints = createMockEndpoints({ cancelOrdersBulk: cancelMock });
		const ctx: GoalContext = { endpoints, state };

		const goal = new CancelOrders({ orderIds });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(batchSizes).toEqual([50, 1]);
	});
});
