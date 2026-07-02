import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibUseItem } from "../../../src/dispatcher/lib-primitives/use-item.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibUseItem", () => {
	test("already satisfied when item not in cargo", async () => {
		const account = new FakeLibGoalAccount({ cargo: [] });
		const result = await new LibUseItem({ itemId: "repair_kit" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("uses item and succeeds, reading effect details from response", async () => {
		const account = new FakeLibGoalAccount(
			{ cargo: [{ item_id: "repair_kit", item_name: "Repair Kit", quantity: 3 }] },
			{
				use_item: () => ({
					command: "use_item",
					tick: 0,
					delta: {
						details: {
							action: "use_item",
							item_id: "repair_kit",
							item_name: "Repair Kit",
							effect_type: "hull_repair",
							quantity_used: 1,
							quantity_remaining: 2,
						},
					},
				}),
			},
		);
		const result = await new LibUseItem({ itemId: "repair_kit" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("hull_repair");
		expect(result.message).toContain("2 remaining");
		expect(account.calls[0]).toEqual({ action: "use_item", params: { id: "repair_kit" } });
	});
});
