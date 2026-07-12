import { describe, expect, test } from "bun:test";
import { resolveRecoveryTarget, runCombatRecovery } from "../../src/combat/combat-recovery.js";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import type { MapSystem } from "../../src/dispatcher/route-graph.js";
import { FakeLibGoalAccount } from "../dispatcher/lib-fakes.js";

function system(id: string, connections: string[]): MapSystem {
	return { system_id: id, connections, empire: "solarian" } as MapSystem;
}

// sol -- alpha -- beta -- gamma  (source near sol, destination near gamma)
const LINEAR_MAP: MapSystem[] = [
	system("sol", ["alpha"]),
	system("alpha", ["sol", "beta"]),
	system("beta", ["alpha", "gamma"]),
	system("gamma", ["beta"]),
];

describe("resolveRecoveryTarget", () => {
	test("mining: resolves to the loop's sell station", () => {
		const target = resolveRecoveryTarget("mining", {
			miningSystemId: "belt-sys",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
		});
		expect(target).toEqual({ systemId: "sol", poiId: "sol-station", baseId: "sol-base" });
	});

	test("enhanced-mining: resolves the same way as mining", () => {
		const target = resolveRecoveryTarget("enhanced-mining", {
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
		});
		expect(target).toEqual({ systemId: "sol", poiId: "sol-station", baseId: "sol-base" });
	});

	test("mining: undefined when sell fields are missing", () => {
		expect(resolveRecoveryTarget("mining", { miningSystemId: "belt-sys" })).toBeUndefined();
	});

	const haulingOptions = {
		source: { systemId: "sol", poiId: "sol-poi", baseId: "sol-base" },
		destination: { systemId: "gamma", poiId: "gamma-poi", baseId: "gamma-base" },
	};

	test("hauling: picks source when it's fewer hops away", () => {
		const target = resolveRecoveryTarget("hauling", haulingOptions, {
			currentSystemId: "alpha",
			systems: LINEAR_MAP,
		});
		expect(target).toEqual({ systemId: "sol", poiId: "sol-poi", baseId: "sol-base" });
	});

	test("hauling: picks destination when it's fewer hops away", () => {
		const target = resolveRecoveryTarget("hauling", haulingOptions, {
			currentSystemId: "beta",
			systems: LINEAR_MAP,
		});
		expect(target).toEqual({ systemId: "gamma", poiId: "gamma-poi", baseId: "gamma-base" });
	});

	test("hauling: falls back to source when destination is unreachable", () => {
		const disconnected: MapSystem[] = [
			...LINEAR_MAP.filter((s) => s.system_id !== "gamma"),
			system("gamma", []),
		];
		const target = resolveRecoveryTarget("hauling", haulingOptions, {
			currentSystemId: "sol",
			systems: disconnected,
		});
		expect(target).toEqual({ systemId: "sol", poiId: "sol-poi", baseId: "sol-base" });
	});

	test("hauling: falls back to source when both legs are unreachable", () => {
		const isolated: MapSystem[] = [system("sol", []), system("alpha", []), system("gamma", [])];
		const target = resolveRecoveryTarget("hauling", haulingOptions, {
			currentSystemId: "alpha",
			systems: isolated,
		});
		expect(target).toEqual({ systemId: "sol", poiId: "sol-poi", baseId: "sol-base" });
	});

	test("hauling: falls back to source when no proximity data is given", () => {
		expect(resolveRecoveryTarget("hauling", haulingOptions)).toEqual({
			systemId: "sol",
			poiId: "sol-poi",
			baseId: "sol-base",
		});
	});

	test("hauling: falls back to whichever leg is present when the other is missing", () => {
		expect(resolveRecoveryTarget("hauling", { destination: haulingOptions.destination })).toEqual({
			systemId: "gamma",
			poiId: "gamma-poi",
			baseId: "gamma-base",
		});
	});

	test("unsupported loop type resolves to undefined", () => {
		expect(resolveRecoveryTarget("trading", { foo: "bar" })).toBeUndefined();
	});

	test("undefined loop options resolves to undefined", () => {
		expect(resolveRecoveryTarget("mining", undefined)).toBeUndefined();
	});
});

describe("runCombatRecovery", () => {
	test("runs a plain travel-and-dock without refuel or repair", async () => {
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "sol-poi" },
			ship: { fuel: 50, max_fuel: 100, hull: 25, max_hull: 50 },
		});

		const result = await runCombatRecovery(makeLibGoalContext(account), {
			systemId: "sol",
			poiId: "sol-poi",
			baseId: "sol-base",
		});

		expect(result.success).toBe(true);
		const actions = account.calls.map((c) => c.action);
		expect(actions).toContain("dock");
		expect(actions).not.toContain("refuel");
		expect(actions).not.toContain("repair");
	});
});
