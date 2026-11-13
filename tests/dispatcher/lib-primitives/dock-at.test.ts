import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import type { NotificationHoldUpdate } from "@spacemolt/lib";
import { activeHold, recordHoldUpdate } from "../../../src/dispatcher/hold-state.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibDockAt } from "../../../src/dispatcher/lib-primitives/dock-at.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibDockAt", () => {
	test("already satisfied when docked at target", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" } });
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("docks and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{ dock: () => fakeMutationResult("dock") },
		);
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls[0]).toEqual({ action: "dock" });
	});

	test("fails when not at a POI, after waiting it out", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibDockAt("station-1", { maxWaitMs: 20, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("not at a POI");
	});

	test("waits out an unresolved POI, then docks once it resolves", async () => {
		let refreshCalls = 0;
		const account = new FakeLibGoalAccount(
			{ location: {} },
			{ dock: () => fakeMutationResult("dock") },
		);
		account.refresh = () => {
			refreshCalls++;
			if (refreshCalls >= 2) {
				account.setState({ location: { poi_id: "poi-1" } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibDockAt("station-1", { maxWaitMs: 1000, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(refreshCalls).toBeGreaterThanOrEqual(2);
	});

	test("waits out in_transit even when poi_id still reads as a stale value", async () => {
		let refreshCalls = 0;
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1", in_transit: true } },
			{ dock: () => fakeMutationResult("dock") },
		);
		account.refresh = () => {
			refreshCalls++;
			if (refreshCalls >= 2) {
				account.setState({ location: { poi_id: "poi-1", in_transit: false } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibDockAt("station-1", { maxWaitMs: 1000, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(refreshCalls).toBeGreaterThanOrEqual(2);
	});

	test("fails when still in_transit after waiting it out, even with a defined poi_id", async () => {
		const account = new FakeLibGoalAccount({ location: { poi_id: "poi-1", in_transit: true } });
		const result = await new LibDockAt("station-1", { maxWaitMs: 20, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("mid-transit");
	});

	test("already_docked error resolves as already satisfied", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{
				dock: () => {
					throw new SpacemoltError("already_docked", "Already docked");
				},
			},
		);
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});

	test("mutation_timeout is treated as success if a live refresh shows the dock landed", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{
				dock: () => {
					// The outcome frame arrived late (after the caller gave up), but
					// its delta still updated the push-fed cache.
					account.setState({ location: { poi_id: "poi-1", docked_at: "station-1" } });
					throw new SpacemoltError(
						"mutation_timeout",
						"No action_result for mutation r1 within 180000ms",
					);
				},
			},
		);
		const result = await new LibDockAt("station-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(account.refreshCalls).toBe(1);
	});

	test("mutation_timeout is a real failure if a live refresh shows the dock never landed", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { poi_id: "poi-1" } },
			{
				dock: () => {
					throw new SpacemoltError(
						"mutation_timeout",
						"No action_result for mutation r1 within 180000ms",
					);
				},
			},
		);
		await expect(new LibDockAt("station-1").execute(makeLibGoalContext(account))).rejects.toThrow(
			"No action_result",
		);
	});
});

describe("LibDockAt — customs holds", () => {
	// The live refusal's wording. Its code is undocumented, so the goal must not
	// depend on it; this one is a stand-in.
	const customsRefusal = (): SpacemoltError =>
		new SpacemoltError(
			"hold_refused",
			"[CUSTOMS] Pact Border I - The Rampart Checkpoint holds you with a warp scrambler for a customs inspection, so you cannot dock. The hold ends when the inspection ends.",
		);
	const hold = (
		event: "started" | "ended",
		source: NotificationHoldUpdate["source"] = "customs",
	): NotificationHoldUpdate => ({
		event,
		holder_id: "npc-customs",
		holder_name: "Pact Border I",
		message: "Customs inspection",
		source,
		start_tick: 100,
		target_id: "pid-a",
		target_name: "Alpha",
		...(event === "ended" ? { reason: "scan_over" as const } : {}),
	});
	const atPoi = { location: { poi_id: "poi-1" } };

	test("a refusal before the hold's start push is waited out, then the dock goes through", async () => {
		let docks = 0;
		const account = new FakeLibGoalAccount(atPoi, {
			dock: () => {
				docks++;
				if (docks === 1) {
					setTimeout(() => recordHoldUpdate(account, hold("ended")), 5);
					throw customsRefusal();
				}
				return fakeMutationResult("dock");
			},
		});
		const result = await new LibDockAt("station-1", {}, 1_000).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(docks).toBe(2);
	});

	test("a hold already recorded is waited out before the first dock is sent", async () => {
		const account = new FakeLibGoalAccount(atPoi, {
			dock: () => {
				// Sent only once the inspection is over.
				expect(activeHold(account)).toBeUndefined();
				return fakeMutationResult("dock");
			},
		});
		recordHoldUpdate(account, hold("started"));
		setTimeout(() => recordHoldUpdate(account, hold("ended")), 5);
		const result = await new LibDockAt("station-1", {}, 1_000).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
	});

	test("a hold whose end push never comes is dropped after the wait, and the dock is tried", async () => {
		let docks = 0;
		const account = new FakeLibGoalAccount(atPoi, {
			dock: () => {
				docks++;
				return fakeMutationResult("dock");
			},
		});
		recordHoldUpdate(account, hold("started"));
		const result = await new LibDockAt("station-1", {}, 10).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(docks).toBe(1);
		expect(activeHold(account)).toBeUndefined();
	});

	test("gives up with the refusal after three refused attempts", async () => {
		let docks = 0;
		const account = new FakeLibGoalAccount(atPoi, {
			dock: () => {
				docks++;
				throw customsRefusal();
			},
		});
		await expect(
			new LibDockAt("station-1", {}, 5).execute(makeLibGoalContext(account)),
		).rejects.toThrow("customs inspection");
		expect(docks).toBe(3);
	});

	test("a toll hold's refusal is not waited out", async () => {
		let docks = 0;
		const account = new FakeLibGoalAccount(atPoi, {
			dock: () => {
				docks++;
				throw new SpacemoltError(
					"hold_refused",
					"Raider holds you for a toll, so you cannot dock.",
				);
			},
		});
		recordHoldUpdate(account, hold("started", "toll"));
		await expect(
			new LibDockAt("station-1", {}, 60_000).execute(makeLibGoalContext(account)),
		).rejects.toThrow("toll");
		expect(docks).toBe(1);
	});

	test("an abort during the wait ends the goal", async () => {
		const account = new FakeLibGoalAccount(atPoi, { dock: () => fakeMutationResult("dock") });
		recordHoldUpdate(account, hold("started"));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);
		await expect(
			new LibDockAt("station-1", {}, 60_000).execute(
				makeLibGoalContext(account, controller.signal),
			),
		).rejects.toThrow("aborted");
	});
});
