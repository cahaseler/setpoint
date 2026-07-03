import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runTowSalvageLoop } from "../../../src/dispatcher/lib-loops/tow-salvage-loop.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("runTowSalvageLoop", () => {
	test("tows, drains, and scraps a wreck end to end, then stops at maxIterations", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "wreck_poi" },
				ship: { fuel: 100, max_fuel: 100, cargo_used: 0, cargo_capacity: 100 },
				cargo: [],
			},
			{
				wrecks: () => ({
					result: "",
					structuredContent: {
						count: 1,
						wrecks: [{ id: "wreck-1", towed_by_player_id: null }],
					},
				}),
				tow: () => fakeMutationResult("tow"),
				travel: (params) => {
					const id = (params as { id: string }).id;
					account.setState({ location: { ...account.state.location, poi_id: id } });
					return fakeMutationResult("travel");
				},
				dock: () => {
					account.setState({ location: { ...account.state.location, docked_at: "yard_base" } });
					return fakeMutationResult("dock");
				},
				loot: () => {
					account.setState({ cargo: [{ item_id: "scrap_metal", quantity: 10 }] });
					return {
						command: "loot",
						tick: 0,
						delta: { details: { wreck_empty: true, quantity: 10 } },
					};
				},
				deposit: () => {
					account.setState({ cargo: [] });
					return fakeMutationResult("deposit");
				},
				scrap: () => fakeMutationResult("scrap"),
			},
		);

		const result = await runTowSalvageLoop(
			{
				mode: "fixed",
				wreckSystemId: "sol",
				wreckPoiId: "wreck_poi",
				yardSystemId: "sol",
				yardPoiId: "yard_poi",
				yardBaseId: "yard_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(account.calls.some((c) => c.action === "scrap")).toBe(true);
	});

	test("stops cleanly (not as a failure) on a permanent no-tow-rig precondition", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "wreck_poi" },
				ship: { fuel: 100, max_fuel: 100 },
			},
			{
				wrecks: () => ({
					result: "",
					structuredContent: {
						count: 1,
						wrecks: [{ id: "wreck-1", towed_by_player_id: null }],
					},
				}),
				tow: () => {
					throw new SpacemoltError("no_tow_rig", "No tow rig fitted");
				},
			},
		);

		const result = await runTowSalvageLoop(
			{
				mode: "fixed",
				wreckSystemId: "sol",
				wreckPoiId: "wreck_poi",
				yardSystemId: "sol",
				yardPoiId: "yard_poi",
				yardBaseId: "yard_base",
				loopOptions: { maxIterations: 5, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("cancelled");
		expect(result.iterationCount).toBe(0);
	});
});
