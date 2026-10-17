import { describe, expect, test } from "bun:test";
import { MarketSubscriptionKeeper } from "../../src/state/market-subscription.js";

/**
 * Minimal double for the slice of the lib's account surface the keeper reads.
 * Models the server dropping the subscription on undock.
 */
class FakeMarketAccount {
	marketSubscribed = false;
	readonly state: { location: { docked_at: string | null } } = { location: { docked_at: null } };
	calls = 0;
	error: Error | null = null;

	subscribeMarket(): Promise<unknown> {
		this.calls++;
		if (this.error) return Promise.reject(this.error);
		this.marketSubscribed = true;
		return Promise.resolve(undefined);
	}

	dock(baseId: string): void {
		this.state.location.docked_at = baseId;
	}

	/** Undocking voids the subscription server-side; the lib mirrors that. */
	undock(): void {
		this.state.location.docked_at = null;
		this.marketSubscribed = false;
	}
}

describe("MarketSubscriptionKeeper", () => {
	test("subscribes immediately when the account is docked", async () => {
		const account = new FakeMarketAccount();
		account.dock("sol_base");
		const keeper = new MarketSubscriptionKeeper();

		await keeper.acquire("p1", account);

		expect(account.calls).toBe(1);
		expect(account.marketSubscribed).toBe(true);
	});

	test("holds an undocked subscriber and subscribes at the next dock", async () => {
		const account = new FakeMarketAccount();
		const keeper = new MarketSubscriptionKeeper();

		await keeper.acquire("p1", account);
		expect(account.calls).toBe(0);
		expect(keeper.hasSubscribers("p1")).toBe(true);

		account.dock("sol_base");
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();

		expect(account.calls).toBe(1);
		expect(account.marketSubscribed).toBe(true);
	});

	test("re-subscribes at each new station after an undock", async () => {
		const account = new FakeMarketAccount();
		account.dock("sol_base");
		const keeper = new MarketSubscriptionKeeper();
		await keeper.acquire("p1", account);

		account.undock();
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();
		// In flight there is no station to watch.
		expect(account.calls).toBe(1);

		account.dock("vega_base");
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();
		expect(account.calls).toBe(2);
	});

	test("does not re-subscribe when a subscription is already live", async () => {
		const account = new FakeMarketAccount();
		account.dock("sol_base");
		account.marketSubscribed = true;
		const keeper = new MarketSubscriptionKeeper();

		await keeper.acquire("p1", account);
		keeper.resubscribeIfDropped("p1", account);

		expect(account.calls).toBe(0);
	});

	test("a failed subscribe while docked propagates and leaves no holder", async () => {
		const account = new FakeMarketAccount();
		account.dock("sol_base");
		account.error = new Error("market unavailable");
		const keeper = new MarketSubscriptionKeeper();

		await expect(keeper.acquire("p1", account)).rejects.toThrow("market unavailable");
		expect(keeper.hasSubscribers("p1")).toBe(false);
	});

	test("stops following docks once the last subscriber releases", async () => {
		const account = new FakeMarketAccount();
		const keeper = new MarketSubscriptionKeeper();
		const release = await keeper.acquire("p1", account);

		release();
		account.dock("sol_base");
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();

		expect(account.calls).toBe(0);
	});

	test("a re-subscribe failure is swallowed and retried at the next location change", async () => {
		const account = new FakeMarketAccount();
		const keeper = new MarketSubscriptionKeeper();
		await keeper.acquire("p1", account);

		account.dock("sol_base");
		account.error = new Error("transient");
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();
		await Promise.resolve();
		expect(keeper.hasSubscribers("p1")).toBe(true);

		account.error = null;
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();
		expect(account.marketSubscribed).toBe(true);
	});
});
