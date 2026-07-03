import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibEnsureFueled } from "../../../src/dispatcher/lib-primitives/ensure-fueled.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibEnsureFueled", () => {
	test("already satisfied when fuel >= target", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 100, max_fuel: 100 } });
		const result = await new LibEnsureFueled().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("fails when ship state unknown", async () => {
		const account = new FakeLibGoalAccount({});
		const result = await new LibEnsureFueled().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("ship state unknown");
	});

	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 10, max_fuel: 100 }, location: {} });
		const result = await new LibEnsureFueled().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("refuels and reads post-refuel fuel from account.state", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { fuel: 10, max_fuel: 100 }, location: { docked_at: "station-1" } },
			{
				refuel: () => {
					// simulate the delta filling the tank
					account.setState({ ship: { fuel: 100, max_fuel: 100 } });
					return fakeMutationResult("refuel");
				},
			},
		);
		const result = await new LibEnsureFueled().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls[0]).toEqual({ action: "refuel", params: { quantity: 90 } });
	});

	test("tank_full error resolves as already satisfied", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { fuel: 10, max_fuel: 100 }, location: { docked_at: "s" } },
			{
				refuel: () => {
					throw new SpacemoltError("tank_full", "Tank is full");
				},
			},
		);
		const result = await new LibEnsureFueled().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});

	test("soft-fails (succeeds with warning) on non-bug SpacemoltError e.g. insufficient credits", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { fuel: 10, max_fuel: 100 }, location: { docked_at: "s" } },
			{
				refuel: () => {
					throw new SpacemoltError("insufficient_credits", "Not enough credits");
				},
			},
		);
		const result = await new LibEnsureFueled().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.message).toContain("Refuel skipped");
	});

	test("rethrows bug-class SpacemoltError (invalid_params)", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { fuel: 10, max_fuel: 100 }, location: { docked_at: "s" } },
			{
				refuel: () => {
					throw new SpacemoltError("invalid_params", "bad");
				},
			},
		);
		await expect(new LibEnsureFueled().execute(makeLibGoalContext(account))).rejects.toThrow("bad");
	});

	test("retries on partial fill then succeeds (short retry delay)", async () => {
		let calls = 0;
		const account = new FakeLibGoalAccount(
			{ ship: { fuel: 10, max_fuel: 100 }, location: { docked_at: "s" } },
			{
				refuel: () => {
					calls++;
					account.setState({ ship: { fuel: calls === 1 ? 60 : 100, max_fuel: 100 } });
					return fakeMutationResult("refuel");
				},
			},
		);
		const result = await new LibEnsureFueled(undefined, 1).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(calls).toBe(2);
		expect(result.ticksUsed).toBe(2);
	});
});
