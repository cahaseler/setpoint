import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibEnsureEmptyCargo } from "../../../src/dispatcher/lib-primitives/ensure-empty-cargo.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibEnsureEmptyCargo", () => {
	test("already satisfied when cargo is empty", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" }, cargo: [] });
		const result = await new LibEnsureEmptyCargo().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({
			location: {},
			cargo: [{ item_id: "iron_ore", quantity: 5 }],
		});
		const result = await new LibEnsureEmptyCargo().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("deposits bulk to personal storage and counts per-item successes", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				cargo: [
					{ item_id: "iron_ore", quantity: 5 },
					{ item_id: "steel_plate", quantity: 3 },
				],
			},
			{
				deposit: () => ({
					command: "deposit",
					tick: 0,
					delta: {
						details: {
							action: "deposit",
							requested: 2,
							succeeded: 1,
							failed: 1,
							results: [
								{ item_id: "iron_ore", quantity: 5, success: true },
								{ item_id: "steel_plate", quantity: 3, success: false, error: "storage_full" },
							],
						},
					},
				}),
			},
		);
		const result = await new LibEnsureEmptyCargo().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deposited 1 item type(s) to storage");
		expect(account.calls[0]?.action).toBe("deposit");
		expect(account.calls[0]?.params).toMatchObject({
			target: "self",
			items: [
				{ item_id: "iron_ore", quantity: 5 },
				{ item_id: "steel_plate", quantity: 3 },
			],
		});
	});

	test("deposits to faction storage when depositTarget is faction", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, cargo: [{ item_id: "iron_ore", quantity: 5 }] },
			{
				deposit: () => ({
					command: "deposit",
					tick: 0,
					delta: {
						details: {
							action: "deposit",
							requested: 1,
							succeeded: 1,
							failed: 0,
							results: [{ item_id: "iron_ore", quantity: 5, success: true }],
						},
					},
				}),
			},
		);
		const result = await new LibEnsureEmptyCargo({ depositTarget: "faction" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain("faction storage");
		expect(account.calls[0]?.params).toMatchObject({ target: "faction" });
	});
});
