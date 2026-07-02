import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runSalvageLoop } from "../../../src/dispatcher/lib-loops/salvage-loop.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("runSalvageLoop", () => {
	test("loots to full, sells at station, and stops at maxIterations", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "wreck_site" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 90,
				},
				cargo: [{ item_id: "scrap_metal", item_name: "Scrap Metal", quantity: 90, size: 1 }],
			},
			{
				wrecks: () => ({
					result: "",
					structuredContent: {
						count: 1,
						wrecks: [{ id: "wreck-1", cargo: [{ item_id: "scrap_metal", quantity: 10 }] }],
					},
				}),
				loot: () => {
					const ship = account.state.ship;
					account.setState({ ship: { ...ship, cargo_used: 100 } });
					return { command: "loot", tick: 0, delta: { details: { wreck_empty: true } } };
				},
				travel: (params) => {
					const id = (params as { id: string }).id;
					account.setState({ location: { ...account.state.location, poi_id: id } });
					return fakeMutationResult("travel");
				},
				dock: () => {
					account.setState({ location: { ...account.state.location, docked_at: "sol_base" } });
					return fakeMutationResult("dock");
				},
			},
		);

		const result = await runSalvageLoop(
			{
				salvageSystemId: "sol",
				salvagePoiId: "wreck_site",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(account.calls.some((c) => c.action === "loot")).toBe(true);
		expect(account.calls.some((c) => c.action === "deposit")).toBe(true);
	});

	test("stops after a consecutive failure when no route exists to the salvage site", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await runSalvageLoop(
			{
				salvageSystemId: "alpha",
				salvagePoiId: "wreck_site",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxConsecutiveFailures: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("consecutive failure");
	});
});
