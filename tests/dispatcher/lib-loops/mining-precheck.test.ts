import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { checkHarvesterForPoi } from "../../../src/dispatcher/lib-loops/mining-precheck.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

/** A query_intel response exposing one system whose POIs include `beltPoiId`. */
function intelWith(beltPoiId: string, type: string) {
	return () => ({
		result: "",
		structuredContent: {
			entries: [{ system_id: "sol", pois: [{ id: beltPoiId, type }] }],
		},
	});
}

describe("checkHarvesterForPoi", () => {
	const baseOptions = {
		miningSystemId: "sol",
		beltPoiId: "gas_1",
		sellSystemId: "sol",
		sellStationPoiId: "sol_station",
		sellBaseId: "sol_base",
	};

	test("returns null when the required harvester is equipped", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "gas_1" },
				modules: [{ module_id: "m1", type_id: "gas_harvester_mk1" }],
			},
			{ query_intel: intelWith("gas_1", "gas_cloud") },
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

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
				query_intel: intelWith("gas_1", "gas_cloud"),
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
				travel: () => {
					account.setState({ location: { system_id: "sol", poi_id: "sol_station" } });
					return { command: "travel", tick: 0, delta: {} };
				},
			},
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).not.toBeNull();
		expect(result?.success).toBe(false);
		expect(result?.message).toContain("gas harvester");
	});

	test("does not block when the faction has no intel facility (query rejects)", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "gas_1" }, modules: [] },
			{ query_intel: () => Promise.reject(new Error("requires an intel facility")) },
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).toBeNull();
	});

	test("does not block when the target POI is not in the faction's intel", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "gas_1" }, modules: [] },
			{ query_intel: intelWith("some_other_poi", "gas_cloud") },
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).toBeNull();
	});
});
