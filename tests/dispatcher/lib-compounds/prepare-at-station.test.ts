import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { LibPrepareAtStation } from "../../../src/dispatcher/lib-compounds/prepare-at-station.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibPrepareAtStation", () => {
	test("already satisfied when already docked, fueled, and repaired", async () => {
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "poi-1", docked_at: "base-1" },
			ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
		});
		const result = await new LibPrepareAtStation({
			systemId: "sol",
			poiId: "poi-1",
			baseId: "base-1",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.steps.length).toBeGreaterThan(0);
	});

	test("fails immediately when explicit route does not end at systemId", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "sol", poi_id: "poi-1" } });
		const result = await new LibPrepareAtStation({
			systemId: "alpha",
			poiId: "poi-1",
			baseId: "base-1",
			route: ["mid", "beta"],
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must end at");
		expect(result.ticksUsed).toBe(0);
		expect(account.calls).toHaveLength(0);
	});

	test("fails the sequence when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{
				find_route: () => ({
					result: "",
					structuredContent: { found: false, message: "no path" },
				}),
			},
		);
		const result = await new LibPrepareAtStation({
			systemId: "alpha",
			poiId: "poi-2",
			baseId: "base-2",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("navigate-to-system");
	});
});

describe("prepare-at-station outcome instrumentation", () => {
	afterEach(() => {
		(console.warn as unknown as { mockRestore?: () => void }).mockRestore?.();
		(console.info as unknown as { mockRestore?: () => void }).mockRestore?.();
	});

	test("warns with target vs actual when the ship did not reach the station", async () => {
		// The recurring failure: right system, wrong POI, undocked. One grep-able
		// line has to say where it was asked to go and where it actually is.
		const warn = spyOn(console, "warn");
		spyOn(console, "info");

		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "belt-1", in_transit: false },
				ship: { fuel: 100, max_fuel: 100 },
			},
			{
				travel: () => {
					throw new SpacemoltError("unknown_destination", "Unknown destination");
				},
			},
		);

		await new LibPrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			refuel: false,
			repair: false,
		}).execute(makeLibGoalContext(account));

		const line = warn.mock.calls
			.map((c) => String(c[0]))
			.find((l) => l.includes("[prepare-outcome]"));
		expect(line).toBeDefined();
		expect(line).toContain("arrived=false");
		expect(line).toContain("want=sol/sol_station/sol_base");
		expect(line).toContain("got=sol/belt-1/undocked");
	});
});
