import { describe, expect, test } from "bun:test";
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
