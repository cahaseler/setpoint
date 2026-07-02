import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibTransferStorage } from "../../../src/dispatcher/lib-primitives/transfer-storage.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibTransferStorage", () => {
	test("throws when source and target are the same", () => {
		expect(
			() => new LibTransferStorage({ source: "self", target: "self", itemId: "iron_ore" }),
		).toThrow(/cannot both be/);
	});

	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibTransferStorage({
			source: "self",
			target: "faction",
			itemId: "iron_ore",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when nothing available in source storage", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: { base_id: "station-1", items: [] },
				}),
			},
		);
		const result = await new LibTransferStorage({
			source: "self",
			target: "faction",
			itemId: "iron_ore",
		}).execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(1);
	});

	test("transfers self -> faction via deposit source=storage", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: {
						base_id: "station-1",
						items: [{ item_id: "iron_ore", name: "Iron Ore", quantity: 20, size: 1 }],
					},
				}),
				deposit: () => fakeMutationResult("deposit"),
			},
		);
		const result = await new LibTransferStorage({
			source: "self",
			target: "faction",
			itemId: "iron_ore",
			quantity: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		const depositCall = account.calls.find((c) => c.action === "deposit");
		expect(depositCall?.params).toEqual({
			item_id: "iron_ore",
			quantity: 5,
			target: "faction",
			source: "storage",
		});
	});

	test("transfers faction -> self credits via deposit source=faction", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: { base_id: "station-1", items: [], credits: 1000 },
				}),
				deposit: () => fakeMutationResult("deposit"),
			},
		);
		const result = await new LibTransferStorage({
			source: "faction",
			target: "self",
			itemId: "credits",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		const depositCall = account.calls.find((c) => c.action === "deposit");
		expect(depositCall?.params).toEqual({
			item_id: "credits",
			quantity: 1000,
			target: "self",
			source: "faction",
		});
	});
});
