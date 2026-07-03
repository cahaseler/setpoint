import { describe, expect, test } from "bun:test";
import type { FindRouteResponse } from "@spacemolt/lib";
import { ConnectionClosedError, SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibNavigateViaRoute } from "../../../src/dispatcher/lib-primitives/navigate-via-route.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

/** Build a minimal FindRouteResponse QueryResult with the fields the goal reads. */
function route(partial: Partial<FindRouteResponse>): {
	result: unknown;
	structuredContent: FindRouteResponse;
} {
	return {
		result: "",
		structuredContent: {
			cargo_used: 0,
			estimated_fuel: 0,
			found: true,
			fuel_available: 1000,
			fuel_per_jump: 10,
			message: "",
			route: [],
			target_system: "target",
			total_jumps: 0,
			...partial,
		},
	};
}

describe("LibNavigateViaRoute", () => {
	test("already satisfied when already in final system", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "alpha" } });
		const result = await new LibNavigateViaRoute(["sol", "mid", "alpha"]).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("fails when route is empty", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "sol" } });
		const result = await new LibNavigateViaRoute([]).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("route is empty");
	});

	test("fails pre-flight when fuel insufficient", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol" } },
			{ find_route: () => route({ fuel_per_jump: 60, fuel_available: 50 }) },
		);
		const result = await new LibNavigateViaRoute(["sol", "alpha"]).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("Insufficient fuel");
	});

	test("undocks, jumps each explicit hop, and force-refreshes after", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", docked_at: "station-1" } },
			{
				find_route: () => route({ fuel_per_jump: 10, fuel_available: 100 }),
				undock: () => fakeMutationResult("undock"),
				jump: () => fakeMutationResult("jump"),
			},
		);
		account.refreshReturns = { location: { system_id: "alpha" } };
		const result = await new LibNavigateViaRoute(["sol", "mid", "alpha"]).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(3); // undock + 2 jumps
		expect(account.calls.filter((c) => c.action === "jump")).toHaveLength(2);
		expect(account.calls.some((c) => c.action === "undock")).toBe(true);
	});

	test("fails hard (no reroute) on SpacemoltError, reporting current position", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol" } },
			{
				find_route: () => route({ fuel_per_jump: 10, fuel_available: 100 }),
				jump: () => {
					throw new SpacemoltError("unknown_destination", "bad dest");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol" } };
		const result = await new LibNavigateViaRoute(["sol", "alpha"]).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("currently in sol");
	});

	test("retries once on transient ConnectionClosedError then succeeds", async () => {
		let jumps = 0;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol" } },
			{
				find_route: () => route({ fuel_per_jump: 10, fuel_available: 100 }),
				jump: () => {
					jumps++;
					if (jumps === 1) throw new ConnectionClosedError("closed");
					return fakeMutationResult("jump");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol" } };
		const result = await new LibNavigateViaRoute(["sol", "alpha"]).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(jumps).toBe(2);
	});
});
