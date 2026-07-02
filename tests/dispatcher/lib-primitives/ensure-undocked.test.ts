import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibEnsureUndocked } from "../../../src/dispatcher/lib-primitives/ensure-undocked.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibEnsureUndocked", () => {
	test("already satisfied when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibEnsureUndocked().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("undocks and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{ undock: () => fakeMutationResult("undock") },
		);
		const result = await new LibEnsureUndocked().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls[0]).toEqual({ action: "undock" });
	});
});
