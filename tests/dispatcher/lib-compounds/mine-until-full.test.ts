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
});
