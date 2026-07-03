import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibWithdrawFromFactionStorage } from "../../../src/dispatcher/lib-primitives/withdraw-from-faction-storage.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibWithdrawFromFactionStorage", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibWithdrawFromFactionStorage({ itemId: "iron_ore" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("fails when nothing available in faction storage", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: { base_id: "station-1", items: [] },
				}),
			},
		);
		const result = await new LibWithdrawFromFactionStorage({ itemId: "iron_ore" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("No iron_ore available in faction storage");
	});

	test("withdraws item, capped by requested quantity, via deposit source=faction", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: {
						base_id: "station-1",
						items: [{ item_id: "iron_ore", name: "Iron Ore", quantity: 500, size: 1 }],
					},
				}),
				deposit: () => fakeMutationResult("deposit"),
			},
		);
		const result = await new LibWithdrawFromFactionStorage({
			itemId: "iron_ore",
			quantity: 50,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Withdrew 50x iron_ore");
		const depositCall = account.calls.find((c) => c.action === "deposit");
		expect(depositCall).toEqual({
			action: "deposit",
			params: { item_id: "iron_ore", quantity: 50, target: "self", source: "faction" },
		});
	});

	test("withdraws all available credits when quantity omitted", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: { base_id: "station-1", items: [], credits: 5000 },
				}),
				deposit: () => fakeMutationResult("deposit"),
			},
		);
		const result = await new LibWithdrawFromFactionStorage({ itemId: "credits" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		const depositCall = account.calls.find((c) => c.action === "deposit");
		expect(depositCall?.params).toEqual({
			item_id: "credits",
			quantity: 5000,
			target: "self",
			source: "faction",
		});
	});
});
