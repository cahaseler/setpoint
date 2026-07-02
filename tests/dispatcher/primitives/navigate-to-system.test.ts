import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { NavigateToSystem } from "../../../src/dispatcher/primitives/navigate-to-system.js";
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

function makeRoute(
	systemIds: string[],
	opts: { estimatedFuel?: number; fuelAvailable?: number; fuelPerJump?: number } = {},
) {
	const hops = systemIds.length - 1;
	const fuelPerJump = opts.fuelPerJump ?? 10;
	return mockApiResponse({
		found: true,
		message: "Route found",
		route: systemIds.map((id) => ({ system_id: id, name: id, jumps: 1 })),
		target_system: systemIds[systemIds.length - 1] ?? "",
		total_jumps: hops,
		fuel_per_jump: fuelPerJump,
		estimated_fuel: opts.estimatedFuel ?? hops * fuelPerJump,
		fuel_available: opts.fuelAvailable ?? 1000,
	});
}

function makeNoRoute(message = "No path") {
	return mockApiResponse({
		found: false,
		message,
		route: undefined,
		target_system: "target",
		total_jumps: 0,
		fuel_per_jump: 10,
		estimated_fuel: 0,
		fuel_available: 1000,
	});
}

describe("NavigateToSystem", () => {
	test("returns alreadySatisfied when already in target system (no refreshState)", async () => {
		const state = makeState("target");
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("returns alreadySatisfied when fresh state shows already in target", async () => {
		const staleState = makeState("sol"); // stale — wrong system
		const freshState = makeState("target");
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = {
			endpoints,
			state: staleState,
			refreshState: async () => freshState,
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("fails when location is unknown", async () => {
		const state = makeState(null);
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("current system unknown");
	});

	test("fails when no route found", async () => {
		const state = makeState("sol");
		const endpoints = createMockEndpoints({
			findRoute: async () => makeNoRoute("Unreachable system"),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("No route found");
	});

	test("fails with insufficient fuel before attempting any jumps", async () => {
		const state = makeState("sol");
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				makeRoute(["sol", "target"], { estimatedFuel: 200, fuelAvailable: 80 }),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("Insufficient fuel");
		expect(result.message).toContain("need 200");
		expect(result.message).toContain("have 80");
		// No jumps attempted — fail fast before starting the route
		expect(jumps).toHaveLength(0);
	});

	test("proceeds normally when fuel is exactly sufficient", async () => {
		const state = makeState("sol");
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				makeRoute(["sol", "target"], { estimatedFuel: 100, fuelAvailable: 100 }),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jumps).toEqual(["target"]);
	});

	test("fuelReserve: a trip that fits the tank still fails when reserve does not", async () => {
		// estimated 80 fits in 100, but with a 30-unit reserve the ship would arrive
		// nearly dry — the pre-flight must fail before departing.
		const state = makeState("sol");
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				makeRoute(["sol", "target"], { estimatedFuel: 80, fuelAvailable: 100 }),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target", 30);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("Insufficient fuel");
		expect(result.message).toContain("need 110");
		expect(result.message).toContain("(incl. 30 reserve)");
		expect(result.message).toContain("have 100");
		expect(jumps).toHaveLength(0);
	});

	test("fuelReserve: proceeds when fuel covers the trip plus the reserve", async () => {
		const state = makeState("sol");
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				makeRoute(["sol", "target"], { estimatedFuel: 80, fuelAvailable: 120 }),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target", 30);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jumps).toEqual(["target"]);
	});

	test("single hop: jumps directly to target", async () => {
		const state = makeState("sol");

		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(jumps).toEqual(["target"]);
	});

	test("multi-hop: jumps each hop in sequence", async () => {
		const state = makeState("sol");

		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "alpha", "beta", "target"]),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(3);
		expect(jumps).toEqual(["alpha", "beta", "target"]);
	});

	test("forces a live state sync after jumps (jumps carry no state, so the store lags)", async () => {
		// After jumps complete, the post-nav refresh must FORCE a live read — a
		// TTL-fresh cache would otherwise leave the store at the pre-nav position,
		// stranding the next goal on a stale location.
		const state = makeState("sol");
		const refreshCalls: Array<{ force?: boolean } | undefined> = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async () => mockApiResponse({}),
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async (opts?: { force?: boolean }) => {
				refreshCalls.push(opts);
				return makeState("sol");
			},
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// The post-jump sync (the refresh that runs because ticks were used) forces live.
		expect(refreshCalls.some((c) => c?.force === true)).toBe(true);
	});

	test("stale location: refreshes state before routing, uses fresh location to skip first hop", async () => {
		// Stale state says 'sol', but ship actually moved to 'alpha' already.
		// find_route returns [alpha, beta, target] — alpha must be skipped.
		const staleState = makeState("sol");
		const freshState = makeState("alpha");

		const jumps: string[] = [];
		let routeFrom: string | undefined;
		const endpoints = createMockEndpoints({
			findRoute: async () => {
				// Route as returned by server (from actual position alpha)
				routeFrom = "alpha";
				return makeRoute(["alpha", "beta", "target"]);
			},
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state: staleState,
			refreshState: async () => freshState,
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		// alpha was skipped (it's the current system), only beta and target were jumped
		expect(jumps).toEqual(["beta", "target"]);
		expect(routeFrom).toBe("alpha");
	});

	test("jump failure triggers re-plan from actual position", async () => {
		// Route: sol -> alpha -> beta -> target
		// Jump to alpha succeeds. Jump to beta fails.
		// Fresh state after failure: ship is at alpha.
		// Re-route from alpha: alpha -> beta -> target. Completes successfully.
		const state = makeState("sol");

		const jumps: string[] = [];
		let refreshCalls = 0;
		let findRouteCalls = 0;

		const endpoints = createMockEndpoints({
			findRoute: async () => {
				findRouteCalls++;
				if (findRouteCalls === 1) {
					return makeRoute(["sol", "alpha", "beta", "target"]);
				}
				// Re-route from alpha
				return makeRoute(["alpha", "beta", "target"]);
			},
			jump: async (systemId: unknown) => {
				const id = systemId as string;
				jumps.push(id);
				if (id === "beta" && jumps.filter((j) => j === "beta").length === 1) {
					throw new ApiError("navigation_error", "Systems are not connected", 400);
				}
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => {
				refreshCalls++;
				// Call 1: initial refresh in execute() — same system as stale state
				// Call 2: after jump failure — ship is actually at alpha
				return refreshCalls === 1 ? makeState("sol") : makeState("alpha");
			},
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// 1 initial refresh + 1 on failure + 1 final position sync after ticks used
		expect(refreshCalls).toBe(3);
		expect(findRouteCalls).toBe(2);
		// Jumped alpha (success), beta (fail), then re-routed: beta (success), target (success)
		expect(jumps).toEqual(["alpha", "beta", "beta", "target"]);
		expect(result.ticksUsed).toBe(3); // alpha + beta (re-route) + target
	});

	test("already at target after jump failure returns success", async () => {
		const state = makeState("sol");
		const freshAtTarget = makeState("target");

		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				throw new ApiError("navigation_error", "Systems are not connected", 400);
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => freshAtTarget,
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(0); // jump failed before counting
		expect(result.message).toContain("target");
	});

	test("jump failure without refreshState re-throws the error", async () => {
		const state = makeState("sol");
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async () => {
				throw new ApiError("navigation_error", "Systems are not connected", 400);
			},
		});
		const ctx: GoalContext = { endpoints, state }; // no refreshState

		const goal = new NavigateToSystem("target");
		await expect(goal.execute(ctx)).rejects.toThrow("Systems are not connected");
	});

	test("recovers from multiple consecutive already-in-system errors without failing", async () => {
		// Simulates the production "already in X" cascade:
		// findRoute returns the route from the ship's ACTUAL position each time.
		// The ship is at "sol" (as far as the plan knows), but consecutive hops
		// fail with "already in" — each re-plan picks up from the actual location
		// after a refresh. Previously the 2nd "already in" would throw (rerouted=true).
		let findRouteCalls = 0;
		let jumpAttempts = 0;
		const jumps: string[] = [];
		const state = makeState("sol");

		const endpoints = createMockEndpoints({
			findRoute: async () => {
				findRouteCalls++;
				// Each findRoute call returns a one-hop route to "target" from wherever
				// the ship is at that point (the re-plan uses the refreshed position).
				return makeRoute(["sol", "target"]);
			},
			jump: async (systemId: unknown) => {
				const id = systemId as string;
				jumps.push(id);
				jumpAttempts++;
				// First two attempts: "already in" errors — triggers re-planning
				if (jumpAttempts <= 2) {
					throw new ApiError("already_in_system", `You are already in ${id}.`, 400);
				}
				// Third attempt: success
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state,
			// refreshState always returns "sol" (ship is genuinely at sol after re-plans)
			refreshState: async () => makeState("sol"),
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// Initial route + 2 re-plans (one per "already in" error) + 0 = 3 findRoute calls
		expect(findRouteCalls).toBe(3);
		// Each reroute tries the same hop (target) until it succeeds on the 3rd attempt
		expect(jumps).toEqual(["target", "target", "target"]);
	});

	test("jump failure exhausts ApiError reroute budget (no infinite re-routing)", async () => {
		// ApiErrors give definitive position info so multiple reroutes are allowed
		// (handles "already in X" cascades). After apiReroutesLeft reaches 0, throws.
		const state = makeState("sol");
		const freshState = makeState("alpha");

		let findRouteCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => {
				findRouteCalls++;
				if (findRouteCalls === 1) {
					return makeRoute(["sol", "target"]);
				}
				return makeRoute(["alpha", "target"]);
			},
			jump: async () => {
				throw new ApiError("navigation_error", "Systems are not connected", 400);
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => freshState,
		};

		const goal = new NavigateToSystem("target");
		// Initial route + 10 ApiError reroutes = 11 findRoute calls before throwing
		await expect(goal.execute(ctx)).rejects.toThrow("Systems are not connected");
		expect(findRouteCalls).toBe(11);
	});

	test("jump failure with unknown location returns failed", async () => {
		const state = makeState("sol");

		let refreshCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async () => {
				throw new ApiError("navigation_error", "Systems are not connected", 400);
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => {
				refreshCalls++;
				// Call 1: initial refresh — valid position
				// Call 2: after jump failure — location unknown
				return refreshCalls === 1 ? makeState("sol") : makeState(null);
			},
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("cannot determine current location");
	});

	test("non-HTTP errors always propagate", async () => {
		const state = makeState("sol");
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async () => {
				throw new Error("Network timeout");
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => makeState("sol"),
		};

		const goal = new NavigateToSystem("target");
		await expect(goal.execute(ctx)).rejects.toThrow("Network timeout");
	});

	test("timeout on jump (status 0): re-plans from actual position", async () => {
		// Request timeout (AbortError → HttpError status 0) should be treated as retriable.
		// We don't know if the jump executed server-side, so we refresh and re-plan.
		const state = makeState("sol");
		const freshAtSol = makeState("sol"); // jump did not execute

		let findRouteCalls = 0;
		let jumpCalls = 0;
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => {
				findRouteCalls++;
				return makeRoute(["sol", "target"]);
			},
			jump: async (systemId: unknown) => {
				const id = systemId as string;
				jumps.push(id);
				jumpCalls++;
				if (jumpCalls === 1) {
					throw new HttpError("Request to /api/v2/spacemolt/jump timed out after 30000ms", 0);
				}
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => freshAtSol,
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(findRouteCalls).toBe(2); // initial route + re-route after timeout
		expect(jumps).toEqual(["target", "target"]); // first timed out, second succeeded
	});

	test("timeout on jump: succeeds when ship already at target after refresh", async () => {
		// Timeout where the jump DID execute server-side.
		const state = makeState("sol");
		const freshAtTarget = makeState("target");

		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async () => {
				throw new HttpError("Request to /api/v2/spacemolt/jump timed out after 30000ms", 0);
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => freshAtTarget,
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.message).toContain("target");
	});

	test("504 on jump: succeeds when ship is already at target after refresh", async () => {
		// 504 may mean the jump executed server-side despite the error response.
		// After refreshing state, if the ship is at target, we should succeed.
		const state = makeState("sol");
		const freshAtTarget = makeState("target");

		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				throw new HttpError("HTTP 504 from /api/v2/spacemolt/jump", 504);
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => freshAtTarget,
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.message).toContain("target");
	});

	test("504 on jump: re-plans from actual position when jump did not execute", async () => {
		// 504 where the jump did NOT execute: ship is still at previous position.
		// Should re-plan from actual position and complete successfully.
		const state = makeState("sol");

		const jumps: string[] = [];
		let findRouteCalls = 0;
		let jumpCalls = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => {
				findRouteCalls++;
				return makeRoute(["sol", "target"]);
			},
			jump: async (systemId: unknown) => {
				const id = systemId as string;
				jumps.push(id);
				jumpCalls++;
				if (jumpCalls === 1) {
					// First jump attempt: 504 — jump did not execute server-side
					throw new HttpError("HTTP 504 from /api/v2/spacemolt/jump", 504);
				}
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => makeState("sol"), // still at sol — jump did not execute
		};

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(findRouteCalls).toBe(2); // initial route + re-route after 504
		expect(jumps).toEqual(["target", "target"]); // first failed (504), second succeeded
	});

	test("undocks before jumping when docked", async () => {
		// Ship is docked at a station — must undock before jumping.
		const state = makeState("sol", "base-station-1");

		const undocks: string[] = [];
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			undock: async () => {
				undocks.push("undocked");
				return mockApiResponse({});
			},
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(undocks).toEqual(["undocked"]); // undocked exactly once
		expect(jumps).toEqual(["target"]); // then jumped
		expect(result.ticksUsed).toBe(2); // 1 undock + 1 jump
	});

	test("does not undock when already undocked", async () => {
		// Ship is not docked — undock should not be called.
		const state = makeState("sol"); // docked_at: null

		const undocks: string[] = [];
		const jumps: string[] = [];
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "target"]),
			undock: async () => {
				undocks.push("undocked");
				return mockApiResponse({});
			},
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(undocks).toHaveLength(0); // no undock
		expect(jumps).toEqual(["target"]);
		expect(result.ticksUsed).toBe(1); // only 1 jump tick
	});

	test("alreadySatisfied does not undock even if docked", async () => {
		// Ship is docked in the target system — no jump needed, no undock.
		const state = makeState("target", "base-station-1");
		const endpoints = createMockEndpoints({
			undock: async () => {
				throw new Error("undock should not be called");
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("stops between jumps when the abort signal fires mid-route", async () => {
		const state = makeState("sol");
		const controller = new AbortController();
		let jumpCount = 0;
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "a", "b", "target"]),
			jump: async () => {
				jumpCount++;
				// Abort lands while the first jump is in flight (e.g. force abort
				// from the HTTP API during a long route).
				controller.abort();
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, signal: controller.signal };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(result.ticksUsed).toBe(1);
		expect(jumpCount).toBe(1);
	});

	test("aborts before the first jump when the signal is already aborted", async () => {
		const state = makeState("sol");
		const controller = new AbortController();
		controller.abort();
		const endpoints = createMockEndpoints({
			findRoute: async () => makeRoute(["sol", "a", "target"]),
			jump: async () => {
				throw new Error("jump should not be called after abort");
			},
		});
		const ctx: GoalContext = { endpoints, state, signal: controller.signal };

		const goal = new NavigateToSystem("target");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(result.ticksUsed).toBe(0);
	});
});
