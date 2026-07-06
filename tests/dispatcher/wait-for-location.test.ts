import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { waitForLocation } from "../../src/dispatcher/wait-for-location.js";
import { FakeLibGoalAccount } from "./lib-fakes.js";

describe("waitForLocation", () => {
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
