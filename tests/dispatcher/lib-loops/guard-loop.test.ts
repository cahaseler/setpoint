import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runGuardLoop } from "../../../src/dispatcher/lib-loops/guard-loop.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("runGuardLoop", () => {
	test("patrols and clears an already-clear POI for a bounded number of sweeps", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "guard_poi" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
			},
			{
				get_nearby: () => ({ result: "", structuredContent: { pirates: [] } }),
			},
		);

		const result = await runGuardLoop(
			{
				homeSystemId: "sol",
				homeStationPoiId: "sol_station",
				homeBaseId: "sol_base",
				guardSystemId: "sol",
				guardPoiId: "guard_poi",
				loopOptions: { maxIterations: 2, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(account.calls.some((c) => c.action === "get_nearby")).toBe(true);
	});

	test("stops after a consecutive failure when a damaged ship cannot route home", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "guard_poi" },
				ship: { fuel: 100, max_fuel: 100, hull: 10, max_hull: 50 },
			},
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await runGuardLoop(
			{
				homeSystemId: "alpha",
				homeStationPoiId: "sol_station",
				homeBaseId: "sol_base",
				guardSystemId: "sol",
				guardPoiId: "guard_poi",
				loopOptions: { maxConsecutiveFailures: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("consecutive failure");
	});
});

describe("guard-loop engagement handoff", () => {
	const pirateAccount = () =>
		new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "guard_poi" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
			},
			{
				// Always a pirate present: "auto" would attack forever.
				get_nearby: () => ({
					result: "",
					structuredContent: { pirates: [{ pirate_id: "pirate-1" }] },
				}),
			},
		);

	const base = {
		homeSystemId: "sol",
		homeStationPoiId: "sol_station",
		homeBaseId: "sol_base",
		guardSystemId: "sol",
		guardPoiId: "guard_poi",
	};

	test('engagement "external" opens the battle with one attack and hands off', async () => {
		// Combat entry releases the account from the loop anyway, so continuing
		// to attack would mean setpoint and the external driver flying one ship.
		const account = pirateAccount();

		await runGuardLoop(
			{ ...base, engagement: "external", loopOptions: { maxIterations: 1, retryDelayMs: 1 } },
			makeLibGoalContext(account),
		);

		expect(account.calls.filter((c) => c.action === "attack")).toHaveLength(1);
	});

	test('engagement "auto" keeps attacking until the area is clear', async () => {
		// Bounded on purpose: the pirate disappears after two attacks, so this
		// asserts the contrast with the handoff without running the unbounded
		// path for real.
		let remaining = 2;
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "guard_poi" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
			},
			{
				get_nearby: () => ({
					result: "",
					structuredContent: {
						pirates: remaining > 0 ? [{ pirate_id: "pirate-1" }] : [],
					},
				}),
				attack: () => {
					remaining--;
					return { command: "attack", tick: 0, delta: {} };
				},
			},
		);

		await runGuardLoop(
			{ ...base, loopOptions: { maxIterations: 1, retryDelayMs: 1 } },
			makeLibGoalContext(account),
		);

		expect(account.calls.filter((c) => c.action === "attack")).toHaveLength(2);
	});
});
