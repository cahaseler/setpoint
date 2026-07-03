import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibLoadFromFactionStorage } from "../../../src/dispatcher/lib-primitives/load-from-faction-storage.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibLoadFromFactionStorage", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {}, cargo: [] });
		const result = await new LibLoadFromFactionStorage("iron_ore", 10).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when cargo already has target quantity", async () => {
		const account = new FakeLibGoalAccount({
			location: { docked_at: "station-1" },
			cargo: [{ item_id: "iron_ore", quantity: 10 }],
		});
		const result = await new LibLoadFromFactionStorage("iron_ore", 10).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("withdraws as much as fits, capped by cargo space and maxQuantity", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				cargo: [{ item_id: "iron_ore", quantity: 2, size: 1 }],
				ship: { cargo_capacity: 10 },
			},
			{
				view: () => ({
					result: "",
					structuredContent: {
						base_id: "station-1",
						items: [{ item_id: "iron_ore", name: "Iron Ore", quantity: 100, size: 1 }],
					},
				}),
				withdraw: () => fakeMutationResult("withdraw"),
			},
		);
		const result = await new LibLoadFromFactionStorage("iron_ore", 5).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Loaded 3x iron_ore");
		const withdrawCall = account.calls.find((c) => c.action === "withdraw");
		expect(withdrawCall?.params).toEqual({ item_id: "iron_ore", quantity: 3, target: "faction" });
	});
});
