import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibDepositToFactionStorage } from "../../../src/dispatcher/lib-primitives/deposit-to-faction-storage.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibDepositToFactionStorage", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {}, cargo: [] });
		const result = await new LibDepositToFactionStorage({
			itemId: "iron_ore",
			quantity: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("fails when item not in cargo", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" }, cargo: [] });
		const result = await new LibDepositToFactionStorage({
			itemId: "iron_ore",
			quantity: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("No iron_ore in cargo");
		expect(account.calls).toHaveLength(0);
	});

	test("deposits capped to cargo quantity", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				cargo: [{ item_id: "iron_ore", quantity: 3 }],
			},
			{ deposit: () => fakeMutationResult("deposit") },
		);
		const result = await new LibDepositToFactionStorage({
			itemId: "iron_ore",
			quantity: 10,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deposited 3x iron_ore");
		expect(account.calls[0]).toEqual({
			action: "deposit",
			params: { item_id: "iron_ore", quantity: 3, target: "faction" },
		});
	});
});
