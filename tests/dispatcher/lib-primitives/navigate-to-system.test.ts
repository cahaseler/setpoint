import { describe, expect, test } from "bun:test";
import type { FindRouteResponse } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibNavigateToSystem } from "../../../src/dispatcher/lib-primitives/navigate-to-system.js";
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
			fuel_per_jump: 0,
			message: "",
			route: [],
			target_system: "target",
			total_jumps: 0,
			...partial,
		},
	};
}

describe("LibNavigateToSystem", () => {
	test("already satisfied when in target system", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "sol", poi_id: "p" } });
		const result = await new LibNavigateToSystem("sol").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});

	test("fails when no route found", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{ find_route: () => route({ found: false, message: "no path" }) },
		);
		const result = await new LibNavigateToSystem("alpha").execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("No route found");
	});

	test("fails pre-flight when fuel insufficient", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () =>
					route({
						estimated_fuel: 500,
						fuel_available: 100,
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
						total_jumps: 1,
					}),
			},
		);
		const result = await new LibNavigateToSystem("alpha").execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Insufficient fuel");
	});

	test("waits out an unknown current system, then navigates once it resolves", async () => {
		let refreshCalls = 0;
		const account = new FakeLibGoalAccount(
			{ location: {} },
			{
				find_route: () =>
					route({
						estimated_fuel: 10,
						fuel_available: 100,
						total_jumps: 1,
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
					}),
				jump: () => fakeMutationResult("jump"),
			},
		);
		account.refresh = () => {
			refreshCalls++;
			if (refreshCalls >= 2) {
				account.setState({ location: { system_id: "sol", poi_id: "p" } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibNavigateToSystem("alpha", 0, {
			maxWaitMs: 1000,
			pollIntervalMs: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(refreshCalls).toBeGreaterThanOrEqual(2);
	});

	test("fails when current system is still unknown after waiting it out", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibNavigateToSystem("alpha", 0, {
			maxWaitMs: 20,
			pollIntervalMs: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("current system unknown");
	});

	test("waits out in_transit even when system_id still reads as the stale pre-jump value", async () => {
		let refreshCalls = 0;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p", in_transit: true } },
			{
				find_route: () =>
					route({
						estimated_fuel: 10,
						fuel_available: 100,
						total_jumps: 1,
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
					}),
				jump: () => fakeMutationResult("jump"),
			},
		);
		account.refresh = () => {
			refreshCalls++;
			if (refreshCalls >= 2) {
				account.setState({ location: { system_id: "alpha", poi_id: "p", in_transit: false } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibNavigateToSystem("alpha", 0, {
			maxWaitMs: 1000,
			pollIntervalMs: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(refreshCalls).toBeGreaterThanOrEqual(2);
	});

	test("fails when still in_transit after waiting it out, even with a defined system_id", async () => {
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "p", in_transit: true },
		});
		const result = await new LibNavigateToSystem("alpha", 0, {
			maxWaitMs: 20,
			pollIntervalMs: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("mid-transit");
	});

	test("waits out an unknown position after a jump failure, then reroutes and completes", async () => {
		let jumps = 0;
		let refreshCalls = 0;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () =>
					route({
						estimated_fuel: 10,
						fuel_available: 100,
						total_jumps: 1,
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
					}),
				jump: () => {
					jumps++;
					if (jumps === 1) throw new SpacemoltError("already_in_transit", "mid-jump, wait ~60s");
					return fakeMutationResult("jump");
				},
			},
		);
		account.refresh = () => {
			refreshCalls++;
			if (refreshCalls === 1) {
				// jumpRoute's own forced refresh right after the jump failure —
				// position is momentarily ambiguous (mid-transit).
				account.setState({ location: {} });
			} else if (refreshCalls >= 3) {
				// A later poll inside waitForLocation reveals arrival.
				account.setState({ location: { system_id: "alpha", poi_id: "p" } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibNavigateToSystem("alpha", 0, {
			maxWaitMs: 1000,
			pollIntervalMs: 5,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(refreshCalls).toBeGreaterThanOrEqual(2);
	});

	test("multi-hop jump succeeds and force-refreshes after navigation", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () =>
					route({
						estimated_fuel: 20,
						fuel_available: 100,
						total_jumps: 2,
						route: [
							{ system_id: "mid", jumps: 1, name: "Mid" },
							{ system_id: "alpha", jumps: 1, name: "Alpha" },
						],
					}),
				jump: () => fakeMutationResult("jump"),
			},
		);
		account.refreshReturns = { location: { system_id: "alpha", poi_id: "p" } };
		const result = await new LibNavigateToSystem("alpha").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(account.calls.filter((c) => c.action === "jump")).toHaveLength(2);
		expect(account.refreshCalls).toBeGreaterThanOrEqual(1); // forced post-nav sync
	});

	test("undocks before jumping when docked", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p", docked_at: "station-1" } },
			{
				find_route: () =>
					route({
						estimated_fuel: 10,
						fuel_available: 100,
						total_jumps: 1,
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
					}),
				jump: () => fakeMutationResult("jump"),
			},
		);
		account.refreshReturns = { location: { system_id: "alpha", poi_id: "p" } };
		const result = await new LibNavigateToSystem("alpha").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "undock")).toBe(true);
		expect(result.ticksUsed).toBe(2); // undock + 1 jump
	});

	test("reroutes on SpacemoltError 'already in' and completes", async () => {
		let jumps = 0;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () =>
					route({
						estimated_fuel: 10,
						fuel_available: 100,
						total_jumps: 1,
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
					}),
				jump: () => {
					jumps++;
					if (jumps === 1)
						throw new SpacemoltError("already_in_system", "You are already in alpha");
					return fakeMutationResult("jump");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "alpha", poi_id: "p" } };
		const result = await new LibNavigateToSystem("alpha").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
	});

	test("aborts mid-route when signal fires", async () => {
		const controller = new AbortController();
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () =>
					route({
						estimated_fuel: 20,
						fuel_available: 100,
						total_jumps: 2,
						route: [
							{ system_id: "mid", jumps: 1, name: "Mid" },
							{ system_id: "alpha", jumps: 1, name: "Alpha" },
						],
					}),
				jump: () => {
					controller.abort();
					return fakeMutationResult("jump");
				},
			},
		);
		const result = await new LibNavigateToSystem("alpha").execute(
			makeLibGoalContext(account, controller.signal),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
	});
});
