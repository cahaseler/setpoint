import { describe, expect, test } from "bun:test";
import { ConnectionClosedError, SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibGoToPoi } from "../../../src/dispatcher/lib-primitives/go-to-poi.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibGoToPoi", () => {
	test("already satisfied when at target POI", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "sol", poi_id: "belt-1" } });
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("travels to POI and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					account.setState({ location: { system_id: "sol", poi_id: "belt-1" } });
					return fakeMutationResult("travel");
				},
			},
		);
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls[0]).toEqual({ action: "travel", params: { id: "belt-1" } });
	});

	test("force-refreshes when location unknown, then travels", async () => {
		const account = new FakeLibGoalAccount(
			{ location: {} },
			{
				travel: () => {
					account.refreshReturns = undefined;
					account.setState({ location: { system_id: "sol", poi_id: "belt-1" } });
					return fakeMutationResult("travel");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol", poi_id: "station-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(account.refreshCalls).toBe(2);
		expect(result.success).toBe(true);
	});

	test("fails when location still unknown after waiting it out", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		account.refreshReturns = { location: {} };
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 20, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("current location unknown");
	});

	test("waits out an unresolved location, then travels once it resolves", async () => {
		let calls = 0;
		let traveled = false;
		const account = new FakeLibGoalAccount(
			{ location: {} },
			{
				travel: () => {
					traveled = true;
					account.setState({ location: { system_id: "sol", poi_id: "belt-1" } });
					return fakeMutationResult("travel");
				},
			},
		);
		account.refresh = () => {
			calls++;
			if (!traveled && calls >= 2) {
				account.setState({ location: { system_id: "sol", poi_id: "station-1" } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 1000, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	test("retries once on SpacemoltError then succeeds", async () => {
		let calls = 0;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					calls++;
					if (calls === 1) throw new SpacemoltError("in_transit", "busy");
					account.refreshReturns = undefined;
					account.setState({ location: { system_id: "sol", poi_id: "belt-1" } });
					return fakeMutationResult("travel");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol", poi_id: "station-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(calls).toBe(2);
	});

	test("returns failed (does not throw) when retry also fails", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					throw new ConnectionClosedError("closed");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol", poi_id: "station-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("failed");
	});

	test("waits out in_transit even when system_id/poi_id still read as stale values", async () => {
		let calls = 0;
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "station-1", in_transit: true },
		});
		account.refresh = () => {
			calls++;
			if (calls >= 2) {
				account.setState({
					location: { system_id: "sol", poi_id: "belt-1", in_transit: false },
				});
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 1000, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	test("fails when still in_transit after waiting it out, even with a defined location", async () => {
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "station-1", in_transit: true },
		});
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 20, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("mid-transit");
	});

	test("already satisfied if refresh after error shows we arrived", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					throw new SpacemoltError("in_transit", "busy");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol", poi_id: "belt-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});

	test("does not misreport already-satisfied when cached poi_id matches target but still in_transit", async () => {
		// Regression: a ship departing the target POI can have a stale cached
		// poi_id that still equals the target while in_transit is true — the
		// fast path must not short-circuit on poi_id alone.
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "belt-1", in_transit: true },
		});
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 20, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.success).toBe(false);
		expect(result.message).toContain("mid-transit");
	});

	test("waits out an in-flight transit before retrying travel, instead of colliding with it", async () => {
		// Regression: a transient travel() failure used to trigger an immediate
		// second travel() call, which collides with the still-executing transit
		// and fails again — repeating every loop retry indefinitely. It must wait
		// for in_transit to clear before retrying.
		let travelCalls = 0;
		let refreshCalls = 0;
		let traveled = false;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					travelCalls++;
					if (travelCalls === 1) throw new SpacemoltError("in_transit", "busy");
					traveled = true;
					account.setState({ location: { system_id: "sol", poi_id: "belt-1", in_transit: false } });
					return fakeMutationResult("travel");
				},
			},
		);
		account.refresh = () => {
			refreshCalls++;
			if (!traveled) {
				if (refreshCalls === 1) {
					account.setState({
						location: { system_id: "sol", poi_id: "station-1", in_transit: true },
					});
				} else {
					account.setState({
						location: { system_id: "sol", poi_id: "station-1", in_transit: false },
					});
				}
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 1000, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(travelCalls).toBe(2);
		expect(refreshCalls).toBeGreaterThanOrEqual(2);
	});
});

describe("LibGoToPoi trusts the cached position", () => {
	test("short-circuits from the cache without a live read", async () => {
		// @spacemolt/lib 14.0.1 applies transit start to the cache from the
		// server's own push, so the cached POI is authoritative. Confirming it
		// with a get_status before every movement decision is exactly the traffic
		// the library exists to remove.
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "sol_station", in_transit: false },
		});

		const result = await new LibGoToPoi("sol_station").execute(makeLibGoalContext(account));

		expect(result.alreadySatisfied).toBe(true);
		expect(account.refreshCalls).toBe(0);
		expect(account.calls).toHaveLength(0);
	});

	test("does not short-circuit while in transit, even if the POI still matches", async () => {
		// The cache clears the POI on departure now, but in_transit is the
		// authoritative signal and this check must not race it.
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "sol_station", in_transit: true } },
			{ travel: () => fakeMutationResult("travel") },
		);
		account.refreshReturns = {
			location: { system_id: "sol", poi_id: "sol_station", in_transit: false },
		};

		const result = await new LibGoToPoi("sol_station").execute(makeLibGoalContext(account));

		expect(result.alreadySatisfied).toBe(true);
		// It resolved the transit rather than trusting a mid-flight position.
		expect(account.refreshCalls).toBeGreaterThan(0);
	});
});
