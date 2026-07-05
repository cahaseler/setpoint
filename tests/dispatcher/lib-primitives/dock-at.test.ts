import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibDockAt } from "../../../src/dispatcher/lib-primitives/dock-at.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibDockAt", () => {
	test("already satisfied when docked at target", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" } });
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("docks and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{ dock: () => fakeMutationResult("dock") },
		);
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls[0]).toEqual({ action: "dock" });
	});

	test("fails when not at a POI", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("not at a POI");
	});

	test("already_docked error resolves as already satisfied", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{
				dock: () => {
					throw new SpacemoltError("already_docked", "Already docked");
				},
			},
		);
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});

	test("mutation_timeout is treated as success if a live refresh shows the dock landed", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{
				dock: () => {
					// The outcome frame arrived late (after the caller gave up), but
					// its delta still updated the push-fed cache.
					account.setState({ location: { poi_id: "poi-1", docked_at: "station-1" } });
					throw new SpacemoltError(
						"mutation_timeout",
						"No action_result for mutation r1 within 180000ms",
					);
				},
			},
		);
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(account.refreshCalls).toBe(1);
	});

	test("mutation_timeout is a real failure if a live refresh shows the dock never landed", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{
				dock: () => {
					throw new SpacemoltError(
						"mutation_timeout",
						"No action_result for mutation r1 within 180000ms",
					);
				},
			},
		);
		await expect(new LibDockAt("station-1").execute(makeLibGoalContext(account))).rejects.toThrow(
			"No action_result",
		);
	});
});
