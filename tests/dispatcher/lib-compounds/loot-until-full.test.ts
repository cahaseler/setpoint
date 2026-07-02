import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { LibLootUntilFull } from "../../../src/dispatcher/lib-compounds/loot-until-full.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibLootUntilFull", () => {
	test("already satisfied when cargo is full", async () => {
		const account = new FakeLibGoalAccount({ ship: { cargo_used: 100, cargo_capacity: 100 } });
		const result = await new LibLootUntilFull().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("fails when docked", async () => {
		const account = new FakeLibGoalAccount({
			ship: { cargo_used: 0, cargo_capacity: 100 },
			location: { docked_at: "station-1" },
		});
		const result = await new LibLootUntilFull().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Cannot loot while docked");
	});

	test("loots a wreck empty and reports success", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 50, cargo_capacity: 100 } },
			{
				wrecks: () => ({
					result: "",
					structuredContent: {
						wrecks: [{ id: "wreck-1", cargo: [{ item_id: "iron_ore", quantity: 5 }] }],
					},
				}),
				loot: () => {
					account.setState({ ship: { cargo_used: 55, cargo_capacity: 100 } });
					return {
						command: "loot",
						tick: 0,
						delta: { details: { wreck_empty: true, quantity: 5 } },
					};
				},
			},
		);
		const result = await new LibLootUntilFull().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls.filter((c) => c.action === "loot")).toHaveLength(1);
	});

	test("fails when the game rejects looting for a non-cargo_full reason", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 0, cargo_capacity: 100 } },
			{
				wrecks: () => ({
					result: "",
					structuredContent: {
						wrecks: [{ id: "wreck-1", cargo: [{ item_id: "iron_ore", quantity: 5 }] }],
					},
				}),
				loot: () => {
					throw new SpacemoltError("wreck_gone", "Wreck no longer exists");
				},
			},
		);
		const result = await new LibLootUntilFull().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Loot failed");
	});
});
