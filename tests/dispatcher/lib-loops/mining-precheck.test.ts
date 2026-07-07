import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import {
	checkHarvesterForPoi,
	resetResourceCatalogForTests,
} from "../../../src/dispatcher/lib-loops/mining-precheck.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

/** A query_intel response exposing one system whose POIs include `beltPoiId`. */
function intelWith(
	beltPoiId: string,
	type: string,
	resources?: Array<{ resource_id: string; richness?: number; remaining?: number }>,
) {
	return () => ({
		result: "",
		structuredContent: {
			entries: [{ system_id: "sol", pois: [{ id: beltPoiId, type, resources }] }],
		},
	});
}

/** Mocks the catalog's HTTP endpoint (`GET /api/catalog.json`) with items mapped resource_id -> extracted_by. */
function mockCatalog(extractedByItem: Record<string, string>): void {
	globalThis.fetch = ((url: string | URL | Request) => {
		if (url.toString().endsWith("/api/catalog.json")) {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						items: Object.entries(extractedByItem).map(([id, extracted_by]) => ({
							id,
							extracted_by,
						})),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		}
		throw new Error(`unexpected fetch: ${url.toString()}`);
	}) as typeof fetch;
}

describe("checkHarvesterForPoi", () => {
	const originalFetch = globalThis.fetch;
	const baseOptions = {
		miningSystemId: "sol",
		beltPoiId: "gas_1",
		sellSystemId: "sol",
		sellStationPoiId: "sol_station",
		sellBaseId: "sol_base",
	};

	beforeEach(() => {
		resetResourceCatalogForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetResourceCatalogForTests();
	});

	test("returns null when the required harvester is equipped", async () => {
		mockCatalog({ helium3: "gas" });
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "gas_1" },
				modules: [{ module_id: "m1", type_id: "gas_harvester_mk1" }],
			},
			{ query_intel: intelWith("gas_1", "gas_cloud", [{ resource_id: "helium3" }]) },
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).toBeNull();
	});

	test("fails and navigates to the sell station when the required harvester is missing", async () => {
		mockCatalog({ helium3: "gas" });
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "gas_1" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
				modules: [],
			},
			{
				query_intel: intelWith("gas_1", "gas_cloud", [{ resource_id: "helium3" }]),
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

	test("does not block a gas_cloud-typed POI whose actual resources are mining-extracted (ore/crystal), not gas", async () => {
		// Regression: a real POI ("The Bleeding Ring") is `type: gas_cloud` but
		// its only resources are fury_crystal and darksteel_ore, both
		// extracted_by "mining" — an ordinary mining laser mines them fine. The
		// POI's environmental `type` must not be used as a stand-in for what its
		// resources actually require.
		mockCatalog({ fury_crystal: "mining", darksteel_ore: "mining" });
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "gas_1" },
				modules: [{ module_id: "m1", type_id: "mining_laser_iii" }],
			},
			{
				query_intel: intelWith("gas_1", "gas_cloud", [
					{ resource_id: "fury_crystal" },
					{ resource_id: "darksteel_ore" },
				]),
			},
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).toBeNull();
	});

	test("blocks when a gas_cloud POI has a mix of resources but none are minable with equipped gear", async () => {
		mockCatalog({ fury_crystal: "gas", darksteel_ore: "ice" });
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "gas_1" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
				modules: [{ module_id: "m1", type_id: "mining_laser_iii" }],
			},
			{
				query_intel: intelWith("gas_1", "gas_cloud", [
					{ resource_id: "fury_crystal" },
					{ resource_id: "darksteel_ore" },
				]),
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
		expect(result?.message).toContain("ice harvester");
	});

	test("does not block when the POI has no resource data to judge by", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "gas_1" }, modules: [] },
			{ query_intel: intelWith("gas_1", "gas_cloud") },
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).toBeNull();
	});

	test("does not block when the item catalog can't be fetched", async () => {
		globalThis.fetch = (() =>
			Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "gas_1" }, modules: [] },
			{ query_intel: intelWith("gas_1", "gas_cloud", [{ resource_id: "helium3" }]) },
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).toBeNull();
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
			{ query_intel: intelWith("some_other_poi", "gas_cloud", [{ resource_id: "helium3" }]) },
		);

		const result = await checkHarvesterForPoi(baseOptions, makeLibGoalContext(account));

		expect(result).toBeNull();
	});
});
