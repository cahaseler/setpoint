import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { LibMineWithJettison } from "../../../src/dispatcher/lib-compounds/mine-with-jettison.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibMineWithJettison", () => {
	test("fails when docked", async () => {
		const account = new FakeLibGoalAccount({
			ship: { cargo_used: 0, cargo_capacity: 100 },
			location: { docked_at: "station-1" },
		});
		const result = await new LibMineWithJettison({ junkItemIds: ["rock_dust"] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Cannot mine while docked");
	});

	test("mines full, jettisons junk, then mines again to full with no junk", async () => {
		let mineCalls = 0;
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 90, cargo_capacity: 100 }, cargo: [] },
			{
				mine: () => {
					mineCalls++;
					if (mineCalls === 1) {
						// First round fills up with junk mixed in.
						account.setState({
							ship: { cargo_used: 100, cargo_capacity: 100 },
							cargo: [{ item_id: "rock_dust", quantity: 20 }],
						});
					} else {
						// Second round (post-jettison) fills with valuable ore only.
						account.setState({
							ship: { cargo_used: 100, cargo_capacity: 100 },
							cargo: [{ item_id: "iron_ore", quantity: 100 }],
						});
					}
					return fakeMutationResult("mine");
				},
				jettison: () => {
					account.setState({ ship: { cargo_used: 80, cargo_capacity: 100 }, cargo: [] });
					return fakeMutationResult("jettison");
				},
			},
		);
		const result = await new LibMineWithJettison({ junkItemIds: ["rock_dust"] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(mineCalls).toBe(2);
		expect(account.calls.filter((c) => c.action === "jettison")).toHaveLength(1);
		expect(result.message).toContain("1 jettison round(s)");
	});

	test("fails when mining fails outright", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 0, cargo_capacity: 100 } },
			{
				mine: () => {
					throw new SpacemoltError("not_at_asteroid", "Not at a mining site");
				},
			},
		);
		const result = await new LibMineWithJettison({ junkItemIds: ["rock_dust"] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Mining failed");
	});

	test("waits out a mid-transit mine rejection then retries successfully", async () => {
		// Regression: travel() can resolve successfully before the ship has
		// actually arrived, so mine() can still be rejected as mid-transit
		// right after a travel step reported success. Must wait for in_transit
		// to clear and retry once instead of failing the whole run.
		let mineCalls = 0;
		let refreshCalls = 0;
		const account = new FakeLibGoalAccount(
			{
				ship: { cargo_used: 0, cargo_capacity: 100 },
				cargo: [],
				location: { poi_id: "belt-1", in_transit: true },
			},
			{
				mine: () => {
					mineCalls++;
					if (mineCalls === 1) throw new SpacemoltError("in_transit", "mid-travel, wait ~30s");
					account.setState({
						ship: { cargo_used: 100, cargo_capacity: 100 },
						cargo: [{ item_id: "iron_ore", quantity: 100 }],
					});
					return fakeMutationResult("mine");
				},
			},
		);
		account.refresh = () => {
			refreshCalls++;
			if (refreshCalls >= 2) {
				account.setState({ location: { poi_id: "belt-1", in_transit: false } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibMineWithJettison({
			junkItemIds: ["rock_dust"],
			waitOpts: { maxWaitMs: 1000, pollIntervalMs: 5 },
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(mineCalls).toBe(2);
	});

	test("fails if still in_transit after waiting out a mid-transit mine rejection", async () => {
		const account = new FakeLibGoalAccount(
			{
				ship: { cargo_used: 0, cargo_capacity: 100 },
				cargo: [],
				location: { poi_id: "belt-1", in_transit: true },
			},
			{
				mine: () => {
					throw new SpacemoltError("in_transit", "mid-travel, wait ~30s");
				},
			},
		);
		const result = await new LibMineWithJettison({
			junkItemIds: ["rock_dust"],
			waitOpts: { maxWaitMs: 20, pollIntervalMs: 5 },
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Mining failed");
	});

	test("mutation_timeout is treated as a successful attempt if a live refresh shows cargo increased", async () => {
		let mineCalls = 0;
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 0, cargo_capacity: 100 }, cargo: [] },
			{
				mine: () => {
					mineCalls++;
					if (mineCalls === 1) {
						// The outcome frame arrived late (after the caller gave up),
						// but its delta still updated the push-fed cache.
						account.setState({
							ship: { cargo_used: 10, cargo_capacity: 100 },
							cargo: [{ item_id: "iron_ore", quantity: 10 }],
						});
						throw new SpacemoltError(
							"mutation_timeout",
							"No action_result for mutation r1 within 180000ms",
						);
					}
					account.setState({ ship: { cargo_used: 100, cargo_capacity: 100 } });
					return fakeMutationResult("mine");
				},
			},
		);
		const result = await new LibMineWithJettison({ junkItemIds: ["rock_dust"] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(mineCalls).toBe(2);
		expect(result.ticksUsed).toBe(2);
	});

	test("mutation_timeout is a real failure if a live refresh shows cargo unchanged", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 0, cargo_capacity: 100 }, cargo: [] },
			{
				mine: () => {
					throw new SpacemoltError(
						"mutation_timeout",
						"No action_result for mutation r1 within 180000ms",
					);
				},
			},
		);
		const result = await new LibMineWithJettison({ junkItemIds: ["rock_dust"] }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Mine rejected");
	});
});
