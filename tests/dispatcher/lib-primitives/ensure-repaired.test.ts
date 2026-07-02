import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibEnsureRepaired } from "../../../src/dispatcher/lib-primitives/ensure-repaired.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibEnsureRepaired", () => {
	test("already satisfied when hull is full", async () => {
		const account = new FakeLibGoalAccount({ ship: { hull: 100, max_hull: 100 } });
		const result = await new LibEnsureRepaired().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("repairs and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { hull: 40, max_hull: 100 }, location: { docked_at: "station-1" } },
			{ repair: () => fakeMutationResult("repair") },
		);
		const result = await new LibEnsureRepaired().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("60");
	});

	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ ship: { hull: 40, max_hull: 100 }, location: {} });
		const result = await new LibEnsureRepaired().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("hull_full error resolves as already satisfied", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { hull: 40, max_hull: 100 }, location: { docked_at: "station-1" } },
			{
				repair: () => {
					throw new SpacemoltError("hull_full", "Hull already full");
				},
			},
		);
		const result = await new LibEnsureRepaired().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});
});
