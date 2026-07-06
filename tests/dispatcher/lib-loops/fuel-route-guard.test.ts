import { describe, expect, test } from "bun:test";
import type { FindRouteResponse } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibFuelRouteGuard } from "../../../src/dispatcher/lib-loops/fuel-route-guard.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

/** Build a minimal FindRouteResponse QueryResult with the fields the guard reads. */
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

describe("LibFuelRouteGuard", () => {
	test("already satisfied when fuel covers the route", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { fuel: 50, max_fuel: 100, hull: 1, max_hull: 1, cargo_capacity: 1, cargo_used: 0 } },
			{ find_route: () => route({ estimated_fuel: 20 }) },
		);
		const result = await new LibFuelRouteGuard({
			name: "fuel-route-guard",
			destinationPoiId: "station-1",
			minFuelReserve: 0,
		}).execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls.some((c) => c.action === "refuel")).toBe(false);
	});

	test("fails without attempting anything when undocked and fuel is short", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: {},
				ship: { fuel: 5, max_fuel: 100, hull: 1, max_hull: 1, cargo_capacity: 1, cargo_used: 0 },
			},
			{ find_route: () => route({ estimated_fuel: 20 }) },
		);
		const result = await new LibFuelRouteGuard({
			name: "fuel-route-guard",
			destinationPoiId: "station-1",
			minFuelReserve: 0,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("fuel_below_route_minimum");
		expect(account.calls.some((c) => c.action === "refuel")).toBe(false);
	});

	test("refuels in place when docked and fuel is short, then succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				ship: { fuel: 5, max_fuel: 100, hull: 1, max_hull: 1, cargo_capacity: 1, cargo_used: 0 },
			},
			{
				find_route: () => route({ estimated_fuel: 20 }),
				refuel: () => {
					account.setState({
						ship: {
							fuel: 100,
							max_fuel: 100,
							hull: 1,
							max_hull: 1,
							cargo_capacity: 1,
							cargo_used: 0,
						},
					});
					return fakeMutationResult("refuel");
				},
			},
		);
		const result = await new LibFuelRouteGuard({
			name: "fuel-route-guard",
			destinationPoiId: "station-1",
			minFuelReserve: 0,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "refuel")).toBe(true);
	});

	test("fails if docked but refuel couldn't bring fuel above the route minimum", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { docked_at: "station-1" },
				ship: { fuel: 5, max_fuel: 10, hull: 1, max_hull: 1, cargo_capacity: 1, cargo_used: 0 },
			},
			{
				find_route: () => route({ estimated_fuel: 20 }),
				// Station supply exhausted after a partial top-up to 10 (still short of 20).
				refuel: () => {
					account.setState({
						ship: {
							fuel: 10,
							max_fuel: 10,
							hull: 1,
							max_hull: 1,
							cargo_capacity: 1,
							cargo_used: 0,
						},
					});
					return fakeMutationResult("refuel");
				},
			},
		);
		const result = await new LibFuelRouteGuard({
			name: "fuel-route-guard",
			destinationPoiId: "station-1",
			minFuelReserve: 0,
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("fuel_below_route_minimum");
	});

	test("minFuelReserve adds to the required amount", async () => {
		const account = new FakeLibGoalAccount(
			{ ship: { fuel: 25, max_fuel: 100, hull: 1, max_hull: 1, cargo_capacity: 1, cargo_used: 0 } },
			{ find_route: () => route({ estimated_fuel: 20 }) },
		);
		const result = await new LibFuelRouteGuard({
			name: "fuel-route-guard",
			destinationPoiId: "station-1",
			minFuelReserve: 10,
		}).execute(makeLibGoalContext(account));
		// 25 available, but 20 + 10 reserve = 30 needed, and undocked so no refuel possible.
		expect(result.success).toBe(false);
	});
});
