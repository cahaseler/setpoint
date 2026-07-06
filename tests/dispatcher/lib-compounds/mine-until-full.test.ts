import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { LibMineUntilFull } from "../../../src/dispatcher/lib-compounds/mine-until-full.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibMineUntilFull", () => {
	test("already satisfied when cargo is full", async () => {
		const account = new FakeLibGoalAccount({ ship: { cargo_used: 100, cargo_capacity: 100 } });
		const result = await new LibMineUntilFull().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("fails when docked", async () => {
		const account = new FakeLibGoalAccount({
			ship: { cargo_used: 0, cargo_capacity: 100 },
			location: { docked_at: "station-1" },
		});
		const result = await new LibMineUntilFull().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Cannot mine while docked");
	});

	test("mines until cargo full, tracking ticks", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 90, cargo_capacity: 100 } },
			{
				mine: () => {
					account.setState({ ship: { cargo_used: 100, cargo_capacity: 100 } });
					return fakeMutationResult("mine");
				},
			},
		);
		const result = await new LibMineUntilFull().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls).toHaveLength(1);
	});

	test("stops and succeeds when the server rejects mining with cargo_full", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 95, cargo_capacity: 100 } },
			{
				mine: () => {
					throw new SpacemoltError("cargo_full", "Cargo hold is full");
				},
			},
		);
		const result = await new LibMineUntilFull().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.message).toContain("Cargo full");
	});

	test("fails on other game errors", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { cargo_used: 0, cargo_capacity: 100 } },
			{
				mine: () => {
					throw new SpacemoltError("not_at_asteroid", "Not at a mining site");
				},
			},
		);
		const result = await new LibMineUntilFull().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Mine rejected");
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
				location: { poi_id: "belt-1", in_transit: true },
			},
			{
				mine: () => {
					mineCalls++;
					if (mineCalls === 1) throw new SpacemoltError("in_transit", "mid-travel, wait ~30s");
					account.setState({ ship: { cargo_used: 100, cargo_capacity: 100 } });
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
		const result = await new LibMineUntilFull({
			waitOpts: { maxWaitMs: 1000, pollIntervalMs: 5 },
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(mineCalls).toBe(2);
	});

	test("fails if still in_transit after waiting out a mid-transit mine rejection", async () => {
		const account = new FakeLibGoalAccount(
			{
				ship: { cargo_used: 0, cargo_capacity: 100 },
				location: { poi_id: "belt-1", in_transit: true },
			},
			{
				mine: () => {
					throw new SpacemoltError("in_transit", "mid-travel, wait ~30s");
				},
			},
		);
		const result = await new LibMineUntilFull({
			waitOpts: { maxWaitMs: 20, pollIntervalMs: 5 },
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Mine rejected");
	});
});
