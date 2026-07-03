import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runTradingLoop } from "../../../src/dispatcher/lib-loops/trading-loop.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

const marketItem = {
	action: "view_market",
	items: [
		{
			item_id: "iron_ore",
			sell_orders: [{ price_each: 10, quantity: 50 }],
		},
	],
};

describe("runTradingLoop", () => {
	test("runs a bounded number of buy/sell iterations", async () => {
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
				cargo: [],
			},
			{
				view_market: () => ({ result: "", structuredContent: marketItem }),
				buy: () => fakeMutationResult("buy"),
				create_sell_order: () => fakeMutationResult("create_sell_order"),
			},
		);

		const result = await runTradingLoop(
			{
				buyStation: { systemId: "sol", poiId: "sol_station", baseId: "sol_base" },
				sellStation: { systemId: "sol", stationPoiId: "sol_station", baseId: "sol_base" },
				items: [{ itemId: "iron_ore", maxBuyPrice: 20, minSellPrice: 30 }],
				loopOptions: { maxIterations: 2, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(account.calls.some((c) => c.action === "buy")).toBe(true);
	});

	test("stops after a consecutive failure when not docked", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await runTradingLoop(
			{
				buyStation: { systemId: "alpha", poiId: "sol_station", baseId: "sol_base" },
				sellStation: { systemId: "beta", stationPoiId: "sol_station", baseId: "sol_base" },
				items: [{ itemId: "iron_ore", maxBuyPrice: 20, minSellPrice: 30 }],
				loopOptions: { maxConsecutiveFailures: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("consecutive failure");
	});
});
