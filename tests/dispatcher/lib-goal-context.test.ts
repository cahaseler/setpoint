import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
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

	test("signal is omitted when not provided, present when provided", () => {
		const account = new FakeLibGoalAccount();
		expect(makeLibGoalContext(account).signal).toBeUndefined();
		const controller = new AbortController();
		expect(makeLibGoalContext(account, controller.signal).signal).toBe(controller.signal);
	});
});
