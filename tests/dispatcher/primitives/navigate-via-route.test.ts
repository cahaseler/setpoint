import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { NavigateViaRoute } from "../../../src/dispatcher/primitives/navigate-via-route.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { ApiError, HttpError } from "../../../src/util/errors.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

function makeState(
	systemId: string | null = "sol",
	dockedAt: string | null = null,
): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: {
			id: "s1",
			hull: 100,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
			cargo_capacity: 100,
			cargo_used: 0,
		},
		cargo: [],
		location:
			systemId !== null
				? {
						system_id: systemId,
						system_name: "Test System",
						poi_id: "poi-1",
						poi_name: "Test Station",
						docked_at: dockedAt,
					}
				: undefined,
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
	} as StoredGameState;
}

function makeFuelInfo(opts: { fuelPerJump?: number; fuelAvailable?: number } = {}) {
	return mockApiResponse({
		found: true,
		message: "Route found",
		route: [],
		target_system: "target",
		total_jumps: 0,
		fuel_per_jump: opts.fuelPerJump ?? 10,
		estimated_fuel: 0,
		fuel_available: opts.fuelAvailable ?? 1000,
	});
}

describe("NavigateViaRoute", () => {
	test("fails on an empty route", async () => {
		const goal = new NavigateViaRoute([]);
		const ctx: GoalContext = { endpoints: createMockEndpoints(), state: makeState() };

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("route is empty");
	});

	test("already satisfied when in the final system", async () => {
		const goal = new NavigateViaRoute(["a", "b", "target"]);
		const ctx: GoalContext = { endpoints: createMockEndpoints(), state: makeState("target") };

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("jumps each hop in order and never re-plans the path", async () => {
		const jumps: string[] = [];
		let findRouteCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => {
				findRouteCalls++;
				return makeFuelInfo();
			},
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state: makeState("sol") };

		const goal = new NavigateViaRoute(["a", "b", "target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jumps).toEqual(["a", "b", "target"]);
		expect(result.ticksUsed).toBe(3);
		// find_route is consulted once for fuel numbers only
		expect(findRouteCalls).toBe(1);
	});

	test("skips a leading hop equal to the current system", async () => {
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeFuelInfo(),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state: makeState("sol") };

		const goal = new NavigateViaRoute(["sol", "a", "target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jumps).toEqual(["a", "target"]);
		expect(result.ticksUsed).toBe(2);
	});

	test("fails before the first jump when fuel is insufficient for the hop count", async () => {
		let jumpCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => makeFuelInfo({ fuelPerJump: 10, fuelAvailable: 25 }),
			jump: async () => {
				jumpCalls++;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state: makeState("sol") };

		const goal = new NavigateViaRoute(["a", "b", "target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Insufficient fuel");
		expect(result.message).toContain("need 30, have 25");
		expect(jumpCalls).toBe(0);
	});

	test("fuelReserve: fails before the first jump when reserve pushes cost over available", async () => {
		// 2 hops × 10 = 20 fits in 25, but a 10-unit reserve needs 30 — must fail.
		let jumpCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => makeFuelInfo({ fuelPerJump: 10, fuelAvailable: 25 }),
			jump: async () => {
				jumpCalls++;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state: makeState("sol") };

		const goal = new NavigateViaRoute(["a", "target"], 10);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Insufficient fuel");
		expect(result.message).toContain("need 30");
		expect(result.message).toContain("(incl. 10 reserve)");
		expect(result.message).toContain("have 25");
		expect(jumpCalls).toBe(0);
	});

	test("undocks before jumping when docked", async () => {
		let undocked = false;
		const endpoints = createMockEndpoints({
			findRoute: async () => makeFuelInfo(),
			undock: async () => {
				undocked = true;
				return mockApiResponse({});
			},
			jump: async () => mockApiResponse({}),
		});
		const ctx: GoalContext = { endpoints, state: makeState("sol", "sol-base") };

		const goal = new NavigateViaRoute(["target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(undocked).toBe(true);
		expect(result.ticksUsed).toBe(2); // undock + 1 jump
	});

	test("fails hard on a game rejection without re-planning, reporting position", async () => {
		let jumpCalls = 0;
		let findRouteCalls = 0;
		let position = "sol";
		const endpoints = createMockEndpoints({
			findRoute: async () => {
				findRouteCalls++;
				return makeFuelInfo();
			},
			jump: async (systemId: unknown) => {
				jumpCalls++;
				if (systemId === "b") {
					throw new ApiError("patrol_blockade", "Jump denied", 400);
				}
				position = systemId as string;
				return mockApiResponse({});
			},
		});
		const state = makeState("sol");
		const ctx: GoalContext = { endpoints, state, refreshState: async () => makeState(position) };

		const goal = new NavigateViaRoute(["a", "b", "target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Jump denied");
		expect(result.message).toContain("currently in a");
		expect(result.ticksUsed).toBe(1);
		expect(jumpCalls).toBe(2); // a succeeded, b rejected — no retries, no re-route
		expect(findRouteCalls).toBe(1); // fuel check only
	});

	test("continues when a transient error masks a jump that actually executed", async () => {
		const jumps: string[] = [];
		let position = "sol";
		const endpoints = createMockEndpoints({
			findRoute: async () => makeFuelInfo(),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				position = systemId as string;
				if (systemId === "a" && jumps.length === 1) {
					// Executed server-side but the response was lost.
					throw new HttpError("Bad gateway", 502);
				}
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state: makeState("sol"),
			refreshState: async () => makeState(position),
		};

		const goal = new NavigateViaRoute(["a", "target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jumps).toEqual(["a", "target"]);
		expect(result.ticksUsed).toBe(2);
	});

	test("retries a transient error once on the same hop, then fails hard", async () => {
		let jumpCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => makeFuelInfo(),
			jump: async () => {
				jumpCalls++;
				throw new HttpError("Bad gateway", 502);
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state: makeState("sol"),
			refreshState: async () => makeState("sol"),
		};

		const goal = new NavigateViaRoute(["a", "target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("currently in sol");
		expect(jumpCalls).toBe(2); // first attempt + one retry of the same hop
	});

	test("stops between hops when the abort signal fires", async () => {
		const controller = new AbortController();
		let jumpCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => makeFuelInfo(),
			jump: async () => {
				jumpCalls++;
				controller.abort();
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state: makeState("sol"), signal: controller.signal };

		const goal = new NavigateViaRoute(["a", "b", "target"]);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(jumpCalls).toBe(1);
	});
});
