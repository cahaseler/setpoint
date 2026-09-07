import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { DEFAULT_MAX_WAIT_MS, waitForLocation } from "../../src/dispatcher/wait-for-location.js";
import { FakeLibGoalAccount } from "./lib-fakes.js";

describe("waitForLocation", () => {
	test("default max wait is generous enough for a real multi-tick transit, not just the ~60s ETA quote", () => {
		// The prior 90s default was tuned to the game's own "~60s until arrival"
		// error message with little margin — real transits observed running
		// longer than that caused goals to give up while still genuinely
		// mid-transit. 600s matches the lib's own mutationTimeoutMs assumption
		// for jump/travel mutations.
		expect(DEFAULT_MAX_WAIT_MS).toBe(600_000);
	});

	test("returns immediately if the predicate is already satisfied on the first live check", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "sol" } });
		const ctx = makeLibGoalContext(account);
		const state = await waitForLocation(ctx, (s) => s.location?.system_id !== undefined, {
			maxWaitMs: 1000,
			pollIntervalMs: 10,
		});
		expect(state.location?.system_id).toBe("sol");
		expect(account.refreshCalls).toBe(1);
	});

	test("polls until the predicate is satisfied, then stops", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		let calls = 0;
		account.refresh = () => {
			calls++;
			if (calls >= 3) {
				account.setState({ location: { system_id: "sol" } });
			}
			return Promise.resolve(account.state);
		};
		const ctx = makeLibGoalContext(account);
		const state = await waitForLocation(ctx, (s) => s.location?.system_id !== undefined, {
			maxWaitMs: 1000,
			pollIntervalMs: 5,
		});
		expect(state.location?.system_id).toBe("sol");
		expect(calls).toBe(3);
	});

	test("gives up and returns the last state once maxWaitMs elapses", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const ctx = makeLibGoalContext(account);
		const state = await waitForLocation(ctx, (s) => s.location?.system_id !== undefined, {
			maxWaitMs: 30,
			pollIntervalMs: 10,
		});
		expect(state.location?.system_id).toBeUndefined();
		expect(account.refreshCalls).toBeGreaterThan(1);
	});

	test("stops polling early if the signal aborts", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const controller = new AbortController();
		let calls = 0;
		account.refresh = () => {
			calls++;
			if (calls === 2) controller.abort();
			return Promise.resolve(account.state);
		};
		const ctx = makeLibGoalContext(account, controller.signal);
		await waitForLocation(ctx, (s) => s.location?.system_id !== undefined, {
			maxWaitMs: 10_000,
			pollIntervalMs: 5,
		});
		// aborted after the 2nd refresh — the loop must not keep polling past that
		expect(calls).toBe(2);
	});
});

describe("waitForLocation deadline", () => {
	test("does not sleep past maxWaitMs", async () => {
		// A full poll interval with milliseconds of budget left would overshoot
		// the caller's timeout by orders of magnitude.
		const account = new FakeLibGoalAccount({ location: { system_id: "sol", in_transit: true } });
		const started = Date.now();

		await waitForLocation(makeLibGoalContext(account), () => false, {
			maxWaitMs: 30,
			pollIntervalMs: 5_000,
		});

		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("waitForLocation cache mode", () => {
	/** Counts live reads while the predicate stays false for a fixed number of polls. */
	async function pollsBeforeArrival(
		opts: { useCache?: boolean; liveReadIntervalMs?: number },
		polls: number,
	): Promise<{ refreshCalls: number }> {
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "origin", in_transit: false },
		});
		let seen = 0;
		await waitForLocation(
			makeLibGoalContext(account),
			() => {
				seen++;
				return seen > polls;
			},
			{ pollIntervalMs: 1, maxWaitMs: 5_000, ...opts },
		);
		return { refreshCalls: account.refreshCalls };
	}

	test("cache mode does not query on every poll", async () => {
		// The saving is the point: a fleet member's arrival is pushed, so
		// querying each ship every poll is traffic the push already carries.
		const cached = await pollsBeforeArrival({ useCache: true }, 8);
		const forced = await pollsBeforeArrival({}, 8);

		expect(forced.refreshCalls).toBeGreaterThanOrEqual(8);
		// One baseline read, then the cache — not one per poll.
		expect(cached.refreshCalls).toBe(1);
	});

	test("cache mode still takes a live read periodically", async () => {
		// isStateStale cannot be the backstop: markStateFresh fires on EVERY
		// state section, so a cargo delta keeps `location` looking fresh while
		// it is wrong. Without this, a dropped location push would go unseen for
		// the whole wait and report a ship as never having arrived.
		const { refreshCalls } = await pollsBeforeArrival({ useCache: true, liveReadIntervalMs: 1 }, 8);
		expect(refreshCalls).toBeGreaterThan(4);
	});

	test("the first read is always live, in either mode", async () => {
		const cached = await pollsBeforeArrival({ useCache: true }, 0);
		expect(cached.refreshCalls).toBe(1);
	});
});
