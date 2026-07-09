import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runMiningLoop } from "../../../src/dispatcher/lib-loops/mining-loop.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("runMiningLoop", () => {
	test("mines to full, sells at station, and stops at maxIterations", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "belt_1" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 90,
				},
				cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 90, size: 1 }],
			},
			{
				mine: () => {
					const ship = account.state.ship;
					account.setState({ ship: { ...ship, cargo_used: 100 } });
					return fakeMutationResult("mine");
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

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(account.calls.some((c) => c.action === "mine")).toBe(true);
		expect(account.calls.some((c) => c.action === "deposit")).toBe(true);
	});

	test("treats a deposit_too_sparse mine() rejection as depletion — moves to sell instead of counting as a failure", async () => {
		// Regression: gameserver v0.463.0 added deposit_too_sparse (a high-power
		// mining array can't get a lock on a sparse deposit) as a distinct error
		// from the original "Resources depleted" — both must trigger the same
		// depleted-so-go-sell behavior, not count toward consecutiveFailures.
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "belt_1" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 10,
				},
				cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
			},
			{
				mine: () => {
					throw new SpacemoltError(
						"deposit_too_sparse",
						"Deposits here are too sparse for your mining array",
					);
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

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 1, maxConsecutiveFailures: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "mine")).toBe(true);
		expect(account.calls.some((c) => c.action === "deposit")).toBe(true);
	});

	test("stops after a consecutive failure when no route exists to the belt", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await runMiningLoop(
			{
				miningSystemId: "alpha",
				beltPoiId: "belt_1",
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
