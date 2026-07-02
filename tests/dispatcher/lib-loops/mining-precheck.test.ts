import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { checkHarvesterForPoi } from "../../../src/dispatcher/lib-loops/mining-precheck.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("checkHarvesterForPoi", () => {
	test("returns null when the required harvester is equipped", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "gas_1" },
				modules: [{ module_id: "m1", type_id: "gas_harvester_mk1" }],
			},
			{
				get_poi: () => ({
					result: "",
					structuredContent: { poi: { id: "gas_1", type: "gas_cloud" } },
				}),
			},
		);

		const result = await checkHarvesterForPoi(
			{
				beltPoiId: "gas_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
			},
			makeLibGoalContext(account),
		);

		expect(result).toBeNull();
	});

	test("fails and navigates to the sell station when the required harvester is missing", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "gas_1" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
				modules: [],
			},
			{
				get_poi: () => ({
					result: "",
					structuredContent: { poi: { id: "gas_1", type: "gas_cloud" } },
				}),
				find_route: () => ({
					result: "",
					structuredContent: {
						found: true,
						route: [{ system_id: "sol" }],
						total_jumps: 0,
						fuel_per_jump: 0,
						estimated_fuel: 0,
						fuel_available: 100,
					},
				}),
			},
		);

		const result = await checkHarvesterForPoi(
			{
				beltPoiId: "gas_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
			},
			makeLibGoalContext(account),
		);

		expect(result).not.toBeNull();
		expect(result?.success).toBe(false);
		expect(result?.message).toContain("gas harvester");
	});
});
