import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibEnsureCreditsFromFaction } from "../../../src/dispatcher/lib-primitives/ensure-credits-from-faction.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibEnsureCreditsFromFaction", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {}, player: { credits: 100 } });
		const result = await new LibEnsureCreditsFromFaction().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when credits >= threshold", async () => {
		const account = new FakeLibGoalAccount({
			location: { docked_at: "station-1" },
			player: { credits: 5000 },
		});
		const result = await new LibEnsureCreditsFromFaction({ minCredits: 1000 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("already satisfied when credits low but faction storage has none", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, player: { credits: 100 } },
			{
				view: () => ({
					result: "",
					structuredContent: { base_id: "station-1", items: [], credits: 0 },
				}),
			},
		);
		const result = await new LibEnsureCreditsFromFaction({ minCredits: 1000 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("no credits in faction storage");
	});

	test("withdraws enough to reach the threshold", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, player: { credits: 200 } },
			{
				view: () => ({
					result: "",
					structuredContent: { base_id: "station-1", items: [], credits: 5000 },
				}),
				withdraw: () => fakeMutationResult("withdraw"),
			},
		);
		const result = await new LibEnsureCreditsFromFaction({ minCredits: 1000 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Withdrew 800 credits");
		const withdrawCall = account.calls.find((c) => c.action === "withdraw");
		expect(withdrawCall).toEqual({
			action: "withdraw",
			params: { item_id: "credits", quantity: 800, target: "faction" },
		});
	});

	test("caps withdrawal to available faction credits", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, player: { credits: 200 } },
			{
				view: () => ({
					result: "",
					structuredContent: { base_id: "station-1", items: [], credits: 300 },
				}),
				withdraw: () => fakeMutationResult("withdraw"),
			},
		);
		const result = await new LibEnsureCreditsFromFaction({ minCredits: 1000 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		const withdrawCall = account.calls.find((c) => c.action === "withdraw");
		expect(withdrawCall?.params).toEqual({
			item_id: "credits",
			quantity: 300,
			target: "faction",
		});
	});
});
