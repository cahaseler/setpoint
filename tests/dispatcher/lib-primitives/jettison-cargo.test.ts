import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
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

	test("not_in_cargo from stale cache: re-reads live cargo and is satisfied when the item is gone", async () => {
		const account = new FakeLibGoalAccount(
			{ cargo: [{ item_id: "nebula_gas", item_name: "Nebula Gas", quantity: 50 }] },
			{
				jettison: () => {
					throw new SpacemoltError("not_in_cargo", "You do not have any Nebula Gas in cargo.");
				},
			},
		);
		account.refreshReturns = { cargo: [{ item_id: "nebula_essence", quantity: 20 }] };
		const result = await new LibJettisonCargo({ itemId: "nebula_gas", quantity: 50 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.refreshCalls).toBe(1);
		expect(account.calls).toHaveLength(1);
	});

	test("not_in_cargo from stale cache: jettisons the live quantity when some is left", async () => {
		let attempt = 0;
		const account = new FakeLibGoalAccount(
			{ cargo: [{ item_id: "nebula_gas", item_name: "Nebula Gas", quantity: 50 }] },
			{
				jettison: () => {
					attempt++;
					if (attempt === 1) {
						throw new SpacemoltError("not_in_cargo", "You do not have enough Nebula Gas in cargo.");
					}
					return { command: "jettison", tick: 0, delta: {} };
				},
			},
		);
		account.refreshReturns = {
			cargo: [{ item_id: "nebula_gas", item_name: "Nebula Gas", quantity: 12 }],
		};
		const result = await new LibJettisonCargo({ itemId: "nebula_gas", quantity: 50 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain("12x Nebula Gas");
		expect(account.calls[1]).toEqual({
			action: "jettison",
			params: { id: "nebula_gas", quantity: 12 },
		});
	});

	test("other jettison errors are passed through without a re-read", async () => {
		const account = new FakeLibGoalAccount(
			{ cargo: [{ item_id: "iron_ore", quantity: 5 }] },
			{
				jettison: () => {
					throw new SpacemoltError("docked", "Cannot jettison while docked");
				},
			},
		);
		await expect(
			new LibJettisonCargo({ itemId: "iron_ore", quantity: 5 }).execute(
				makeLibGoalContext(account),
			),
		).rejects.toThrow("Cannot jettison while docked");
		expect(account.refreshCalls).toBe(0);
	});
});
