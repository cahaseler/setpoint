import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibJettisonCargo } from "../../../src/dispatcher/lib-primitives/jettison-cargo.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibJettisonCargo", () => {
	test("already satisfied when cargo is empty", async () => {
		const account = new FakeLibGoalAccount({ cargo: [] });
		const result = await new LibJettisonCargo({ itemId: "iron_ore", quantity: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("already satisfied when item not in cargo", async () => {
		const account = new FakeLibGoalAccount({
			cargo: [{ item_id: "steel_plate", quantity: 3 }],
		});
		const result = await new LibJettisonCargo({ itemId: "iron_ore", quantity: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("jettisons and succeeds, reading quantity/name from response details", async () => {
		const account = new FakeLibGoalAccount(
			{ cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 10 }] },
			{
				jettison: () => ({
					command: "jettison",
					tick: 0,
					delta: {
						details: { item_id: "iron_ore", item_name: "Iron Ore", quantity: 5, message: "" },
					},
				}),
			},
		);
		const result = await new LibJettisonCargo({ itemId: "iron_ore", quantity: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("5x Iron Ore");
		expect(account.calls[0]).toEqual({
			action: "jettison",
			params: { id: "iron_ore", quantity: 5 },
		});
	});

	test("caps quantity to what's in cargo", async () => {
		const account = new FakeLibGoalAccount(
			{ cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 2 }] },
			{
				jettison: () => ({
					command: "jettison",
					tick: 0,
					delta: {
						details: { item_id: "iron_ore", item_name: "Iron Ore", quantity: 2, message: "" },
					},
				}),
			},
		);
		const result = await new LibJettisonCargo({ itemId: "iron_ore", quantity: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(account.calls[0]).toEqual({
			action: "jettison",
			params: { id: "iron_ore", quantity: 2 },
		});
	});
});
