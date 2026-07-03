import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { LibProcessTowedWreck } from "../../../src/dispatcher/lib-compounds/process-towed-wreck.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibProcessTowedWreck", () => {
	test("tows, drains, and disposes of a wreck end to end", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "yard_sys", poi_id: "yard_poi", docked_at: "yard_base" },
				ship: { fuel: 100, max_fuel: 100, cargo_used: 0, cargo_capacity: 100 },
				cargo: [],
			},
			{
				tow: () => fakeMutationResult("tow"),
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

		const result = await new LibProcessTowedWreck({
			wreckId: "wreck-1",
			yardSystemId: "yard_sys",
			yardPoiId: "yard_poi",
			yardBaseId: "yard_base",
			disposition: "scrap",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"tow-wreck",
			"navigate-to-system",
			"go-to-poi",
			"dock-at",
			"ensure-fueled",
			"drain-towed-wreck",
			"dispose-towed-wreck",
		]);
		expect(account.calls.some((c) => c.action === "scrap")).toBe(true);
	});

	test("propagates a permanent tow failure without attempting the rest of the sequence", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "yard_sys", poi_id: "yard_poi", docked_at: "yard_base" },
				ship: { fuel: 100, max_fuel: 100, cargo_used: 0, cargo_capacity: 100 },
			},
			{
				tow: () => {
					throw new SpacemoltError("no_tow_rig", "No tow rig fitted");
				},
			},
		);

		const result = await new LibProcessTowedWreck({
			wreckId: "wreck-1",
			yardSystemId: "yard_sys",
			yardPoiId: "yard_poi",
			yardBaseId: "yard_base",
			disposition: "scrap",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.message).toContain("PERMANENT:");
		expect(result.steps.map((s) => s.goalName)).toEqual(["tow-wreck"]);
	});
});
