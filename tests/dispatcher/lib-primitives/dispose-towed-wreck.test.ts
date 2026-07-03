import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibDisposeTowedWreck } from "../../../src/dispatcher/lib-primitives/dispose-towed-wreck.js";
import { PERMANENT_PREFIX } from "../../../src/dispatcher/lib-primitives/tow-wreck.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibDisposeTowedWreck", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibDisposeTowedWreck({ disposition: "scrap" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
		expect(account.calls).toHaveLength(0);
	});

	test("scraps the towed wreck", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "yard-1" } },
			{ scrap: () => fakeMutationResult("scrap") },
		);
		const result = await new LibDisposeTowedWreck({ disposition: "scrap" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("scrapped");
		expect(account.calls[0]).toEqual({ action: "scrap" });
	});

	test("sells the towed wreck", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "yard-1" } },
			{ sell: () => fakeMutationResult("sell") },
		);
		const result = await new LibDisposeTowedWreck({ disposition: "sell" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain("sold");
		expect(account.calls[0]).toEqual({ action: "sell" });
	});

	test("no salvage yard skill fails as a permanent precondition failure", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "yard-1" } },
			{
				scrap: () => {
					throw new SpacemoltError("no_salvage_yard", "You need salvage skill 2");
				},
			},
		);
		const result = await new LibDisposeTowedWreck({ disposition: "scrap" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(PERMANENT_PREFIX);
	});
});
