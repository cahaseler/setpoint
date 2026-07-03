import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runRoamingSalvageLoop } from "../../../src/dispatcher/lib-loops/roaming-salvage-loop.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("runRoamingSalvageLoop", () => {
	test("full cargo triggers an immediate return home, then stops at maxIterations", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "wreck_site" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 100,
				},
				cargo: [{ item_id: "scrap_metal", item_name: "Scrap Metal", quantity: 100, size: 1 }],
			},
			{
				get_map: () => ({
					result: "",
					structuredContent: {
						total_count: 1,
						systems: [{ system_id: "sol", connections: [], empire: "solarian" }],
					},
				}),
				travel: (params) => {
					const id = (params as { id: string }).id;
					account.setState({ location: { ...account.state.location, poi_id: id } });
					return fakeMutationResult("travel");
				},
				dock: () => {
					account.setState({ location: { ...account.state.location, docked_at: "sol_base" } });
					return fakeMutationResult("dock");
				},
				deposit: () => {
					account.setState({ cargo: [] });
					return fakeMutationResult("deposit");
				},
			},
		);

		const result = await runRoamingSalvageLoop(
			{
				homeSystemId: "sol",
				homeStationPoiId: "sol_station",
				homeBaseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(account.calls.some((c) => c.action === "deposit")).toBe(true);
	});

	test("fails upfront when get_map does not return a systems list", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				get_map: () => ({ result: "", structuredContent: { total_count: 0 } }),
			},
		);

		const result = await runRoamingSalvageLoop(
			{
				homeSystemId: "sol",
				homeStationPoiId: "sol_station",
				homeBaseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("systems list");
		expect(result.iterationCount).toBe(0);
	});
});
