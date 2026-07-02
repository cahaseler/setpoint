import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibGiftToPlayer } from "../../../src/dispatcher/lib-primitives/gift-to-player.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibGiftToPlayer", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibGiftToPlayer({
			targetName: "Bob",
			itemId: "credits",
			quantity: 100,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("fails to gift credits when balance is insufficient", async () => {
		const account = new FakeLibGoalAccount({
			location: { docked_at: "station-1" },
			player: { credits: 50 },
		});
		const result = await new LibGiftToPlayer({
			targetName: "Bob",
			itemId: "credits",
			quantity: 100,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Insufficient credits");
		expect(account.calls).toHaveLength(0);
	});

	test("gifts credits to a player", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, player: { credits: 500 } },
			{ deposit: () => ({ command: "deposit", tick: 0, delta: {} }) },
		);
		const result = await new LibGiftToPlayer({
			targetName: "Bob",
			itemId: "credits",
			quantity: 100,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toBe("Gifted 100 credits to Bob");
		expect(account.calls[0]).toEqual({
			action: "deposit",
			params: { credits: 100, target: "Bob" },
		});
	});

	test("fails to gift an item not in cargo", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" }, cargo: [] });
		const result = await new LibGiftToPlayer({
			targetName: "Bob",
			itemId: "iron_ore",
			quantity: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("No iron_ore in cargo");
	});

	test("gifts an item, capped to what's in cargo", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				cargo: [{ item_id: "iron_ore", quantity: 3 }],
			},
			{ deposit: () => ({ command: "deposit", tick: 0, delta: {} }) },
		);
		const result = await new LibGiftToPlayer({
			targetName: "Bob",
			itemId: "iron_ore",
			quantity: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.message).toBe("Gifted 3x iron_ore to Bob");
		expect(account.calls[0]).toEqual({
			action: "deposit",
			params: { item_id: "iron_ore", quantity: 3, target: "Bob" },
		});
	});
});
