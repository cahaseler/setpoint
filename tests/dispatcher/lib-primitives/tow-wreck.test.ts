import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibTowWreck, PERMANENT_PREFIX } from "../../../src/dispatcher/lib-primitives/tow-wreck.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibTowWreck", () => {
	test("tows wreck and succeeds", async () => {
		const account = new FakeLibGoalAccount({}, { tow: () => fakeMutationResult("tow") });
		const result = await new LibTowWreck("wreck-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls[0]).toEqual({ action: "tow", params: { id: "wreck-1" } });
	});

	test("already-towing error resolves as already satisfied", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				tow: () => {
					throw new SpacemoltError("already_towing", "You are already towing a wreck");
				},
			},
		);
		const result = await new LibTowWreck("wreck-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});

	test("no tow-rig module fails as a permanent precondition failure", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				tow: () => {
					throw new SpacemoltError("no_tow_rig", "No tow-rig module fitted");
				},
			},
		);
		const result = await new LibTowWreck("wreck-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain(PERMANENT_PREFIX);
	});
});
