import { describe, expect, test } from "bun:test";
import { LibDrainTowedWreck } from "../../../src/dispatcher/lib-compounds/drain-towed-wreck.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibDrainTowedWreck", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibDrainTowedWreck({ wreckId: "wreck-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("drains the wreck in one pass and deposits cargo", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "yard-1" }, cargo: [{ item_id: "iron_ore", quantity: 10 }] },
			{
				loot: () => {
					account.setState({ cargo: [{ item_id: "iron_ore", quantity: 10 }] });
					return {
						command: "loot",
						tick: 0,
						delta: { details: { wreck_empty: true, quantity: 10 } },
					};
				},
				deposit: () => {
					account.setState({ cargo: [] });
					return { command: "deposit", tick: 0, delta: {} };
				},
			},
		);
		const result = await new LibDrainTowedWreck({ wreckId: "wreck-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain("in 1 pass(es)");
		expect(account.calls.some((c) => c.action === "deposit")).toBe(true);
	});

	test("fails after exhausting maxDrains when the wreck never empties", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "yard-1" }, cargo: [] },
			{
				loot: () => ({
					command: "loot",
					tick: 0,
					delta: { details: { wreck_empty: false, quantity: 1 } },
				}),
			},
		);
		const result = await new LibDrainTowedWreck({ wreckId: "wreck-1", maxDrains: 1 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("not empty after 1 passes");
	});
});
