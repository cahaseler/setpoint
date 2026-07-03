import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runHaulingLoop } from "../../../src/dispatcher/lib-loops/hauling-loop.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("runHaulingLoop", () => {
	test("runs a bounded number of load/unload iterations", async () => {
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
				view: () => ({
					result: "",
					structuredContent: {
						base_id: "sol_base",
						hint: "",
						items: [{ item_id: "iron_ore", name: "Iron Ore", quantity: 20, size: 1 }],
					},
				}),
				withdraw: () => ({ command: "withdraw", tick: 0, delta: {} }),
				create_sell_order: () => ({ command: "create_sell_order", tick: 0, delta: {} }),
			},
		);

		const result = await runHaulingLoop(
			{
				source: {
					systemId: "sol",
					poiId: "sol_station",
					baseId: "sol_base",
					type: "personal-storage",
					items: [{ itemId: "iron_ore", quantity: 20 }],
				},
				destination: {
					systemId: "sol",
					poiId: "sol_station",
					baseId: "sol_base",
					type: "market",
					items: [{ itemId: "iron_ore", minPrice: 10 }],
				},
				loopOptions: { maxIterations: 2, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(account.calls.some((c) => c.action === "withdraw")).toBe(true);
	});

	test("stops after a consecutive failure when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await runHaulingLoop(
			{
				source: {
					systemId: "alpha",
					poiId: "sol_station",
					baseId: "sol_base",
					type: "personal-storage",
					items: [{ itemId: "iron_ore", quantity: 20 }],
				},
				destination: {
					systemId: "beta",
					poiId: "sol_station",
					baseId: "sol_base",
					type: "market",
					items: [{ itemId: "iron_ore", minPrice: 10 }],
				},
				loopOptions: { maxConsecutiveFailures: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("consecutive failure");
	});
});
