import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runStorageTransferLoop } from "../../../src/dispatcher/lib-loops/storage-transfer-loop.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("runStorageTransferLoop", () => {
	test("transfers once then stops when storage is empty (alreadySatisfied)", async () => {
		let emptied = false;
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
			},
			{
				view: () =>
					emptied
						? { result: "", structuredContent: { items: [], credits: 0 } }
						: {
								result: "",
								structuredContent: { items: [{ item_id: "iron_ore", quantity: 10 }], credits: 0 },
							},
				deposit: () => {
					emptied = true;
					return { command: "deposit", tick: 0, delta: {} };
				},
			},
		);

		const result = await runStorageTransferLoop(
			{
				systemId: "sol",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				loopOptions: { maxIterations: 5, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		// The first iteration transfers storage; the second finds it empty
		// (alreadySatisfied) and shouldContinue stops the loop before a third.
		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(account.calls.some((c) => c.action === "deposit")).toBe(true);
	});

	test("stops after a consecutive failure when not docked", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await runStorageTransferLoop(
			{
				systemId: "alpha",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				loopOptions: { maxConsecutiveFailures: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("consecutive failure");
	});
});
