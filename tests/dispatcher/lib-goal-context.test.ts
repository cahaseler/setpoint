import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { markStateFresh } from "../../src/dispatcher/state-freshness.js";
import { FakeLibGoalAccount } from "./lib-fakes.js";

describe("makeLibGoalContext", () => {
	test("state getter reflects live account.state (not a snapshot)", () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 10 } });
		const ctx = makeLibGoalContext(account);
		expect(ctx.state.ship?.fuel).toBe(10);
		account.setState({ ship: { fuel: 42 } });
		expect(ctx.state.ship?.fuel).toBe(42);
	});

	test("refreshState() without force returns account.state and does NOT call refresh", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 7 } });
		const ctx = makeLibGoalContext(account);
		const result = await ctx.refreshState();
		expect(result.ship?.fuel).toBe(7);
		expect(account.refreshCalls).toBe(0);
	});

	test("refreshState({ force: true }) calls account.refresh once", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 1 } });
		account.refreshReturns = { ship: { fuel: 99 } };
		const ctx = makeLibGoalContext(account);
		const result = await ctx.refreshState({ force: true });
		expect(account.refreshCalls).toBe(1);
		expect(result.ship?.fuel).toBe(99);
	});

	test("non-forced refreshState() escalates to account.refresh() when the cache is stale", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 1 } });
		markStateFresh(account, Date.now() - 1_000_000); // long past the TTL
		account.refreshReturns = { ship: { fuel: 42 } };
		const ctx = makeLibGoalContext(account);
		const result = await ctx.refreshState();
		expect(account.refreshCalls).toBe(1);
		expect(result.ship?.fuel).toBe(42);
	});

	test("non-forced refreshState() does NOT refresh a freshly-marked account", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 7 } });
		markStateFresh(account);
		const ctx = makeLibGoalContext(account);
		const result = await ctx.refreshState();
		expect(account.refreshCalls).toBe(0);
		expect(result.ship?.fuel).toBe(7);
	});

	test("forced refreshState() always refreshes even when the cache is fresh", async () => {
		const account = new FakeLibGoalAccount({ ship: { fuel: 7 } });
		markStateFresh(account);
		account.refreshReturns = { ship: { fuel: 8 } };
		const ctx = makeLibGoalContext(account);
		const result = await ctx.refreshState({ force: true });
		expect(account.refreshCalls).toBe(1);
		expect(result.ship?.fuel).toBe(8);
	});

	test("signal is omitted when not provided, present when provided", () => {
		const account = new FakeLibGoalAccount();
		expect(makeLibGoalContext(account).signal).toBeUndefined();
		const controller = new AbortController();
		expect(makeLibGoalContext(account, controller.signal).signal).toBe(controller.signal);
	});

	describe("built from a resolver function", () => {
		test("ctx.account re-resolves on every access instead of pinning the first instance", () => {
			const first = new FakeLibGoalAccount({ ship: { fuel: 1 } });
			const second = new FakeLibGoalAccount({ ship: { fuel: 2 } });
			let current: FakeLibGoalAccount = first;
			const ctx = makeLibGoalContext(() => current);

			expect(ctx.account).toBe(first);
			current = second;
			expect(ctx.account).toBe(second);
		});

		test("ctx.state reads through to whatever account the resolver currently returns", () => {
			const first = new FakeLibGoalAccount({ ship: { fuel: 1 } });
			const second = new FakeLibGoalAccount({ ship: { fuel: 99 } });
			let current: FakeLibGoalAccount = first;
			const ctx = makeLibGoalContext(() => current);

			expect(ctx.state.ship?.fuel).toBe(1);
			current = second;
			expect(ctx.state.ship?.fuel).toBe(99);
		});

		test("refreshState() calls refresh() on the account the resolver returns at call time", async () => {
			const first = new FakeLibGoalAccount({ ship: { fuel: 1 } });
			const second = new FakeLibGoalAccount({ ship: { fuel: 1 } });
			second.refreshReturns = { ship: { fuel: 55 } };
			let current: FakeLibGoalAccount = first;
			const ctx = makeLibGoalContext(() => current);

			current = second;
			const result = await ctx.refreshState({ force: true });
			expect(first.refreshCalls).toBe(0);
			expect(second.refreshCalls).toBe(1);
			expect(result.ship?.fuel).toBe(55);
		});

		test("a resolver that throws (account no longer connected) propagates the error", () => {
			const ctx = makeLibGoalContext(() => {
				throw new Error("Account p1 is no longer connected");
			});
			expect(() => ctx.account).toThrow("Account p1 is no longer connected");
			expect(() => ctx.state).toThrow("Account p1 is no longer connected");
		});
	});
});
