import { describe, expect, test } from "bun:test";
import { ObservationSubscriptionKeeper } from "../../src/state/observation-subscription.js";

/**
 * Minimal double for the slice of the lib's account surface the keeper reads.
 * Models the one behaviour that matters: the server drops the watch silently
 * when the ship moves, so `observationSubscribed` goes false on its own.
 */
class FakeSubscribable {
	observationSubscribed = false;
	observationActiveScan = false;
	readonly calls: boolean[] = [];
	error: Error | null = null;
	/** Resolves the next subscribe manually, for testing concurrent opens. */
	gate: { resolve: () => void; promise: Promise<void> } | null = null;

	subscribeObservation(activeScan = false): Promise<unknown> {
		this.calls.push(activeScan);
		if (this.error) return Promise.reject(this.error);
		const apply = (): void => {
			this.observationSubscribed = true;
			this.observationActiveScan = activeScan;
		};
		if (this.gate) return this.gate.promise.then(apply);
		apply();
		return Promise.resolve(undefined);
	}

	/** Simulates the server dropping the watch when the ship leaves the POI. */
	drop(): void {
		this.observationSubscribed = false;
		this.observationActiveScan = false;
	}

	openGate(): void {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		this.gate = { resolve, promise };
	}
}

describe("ObservationSubscriptionKeeper", () => {
	test("subscribes when acquiring for an account with no watch", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();

		await keeper.acquire("p1", account, false);

		expect(account.calls).toEqual([false]);
		expect(account.observationSubscribed).toBe(true);
		expect(keeper.hasSubscribers("p1")).toBe(true);
	});

	test("does not re-subscribe when a watch is already live", async () => {
		const account = new FakeSubscribable();
		account.observationSubscribed = true;
		const keeper = new ObservationSubscriptionKeeper();

		await keeper.acquire("p1", account, false);

		expect(account.calls).toEqual([]);
	});

	test("passes activeScan through to the subscribe call", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();

		await keeper.acquire("p1", account, true);

		expect(account.calls).toEqual([true]);
		expect(account.observationActiveScan).toBe(true);
	});

	test("escalates to an active sweep when a later subscriber asks for one", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();

		await keeper.acquire("p1", account, false);
		await keeper.acquire("p1", account, true);

		expect(account.calls).toEqual([false, true]);
		expect(account.observationActiveScan).toBe(true);
	});

	test("a running sweep satisfies a subscriber that did not ask for one", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();

		await keeper.acquire("p1", account, true);
		await keeper.acquire("p1", account, false);

		expect(account.calls).toEqual([true]);
		expect(account.observationActiveScan).toBe(true);
	});

	test("concurrent opens share one subscribe call", async () => {
		const account = new FakeSubscribable();
		account.openGate();
		const keeper = new ObservationSubscriptionKeeper();

		const both = Promise.all([
			keeper.acquire("p1", account, false),
			keeper.acquire("p1", account, false),
		]);
		account.gate?.resolve();
		await both;

		expect(account.calls).toEqual([false]);
	});

	test("a failed acquire propagates and leaves no holder behind", async () => {
		const account = new FakeSubscribable();
		account.error = new Error("not at a POI");
		const keeper = new ObservationSubscriptionKeeper();

		await expect(keeper.acquire("p1", account, false)).rejects.toThrow("not at a POI");
		expect(keeper.hasSubscribers("p1")).toBe(false);
	});

	test("re-subscribes when the server drops the watch and a subscriber remains", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();
		await keeper.acquire("p1", account, false);

		account.drop();
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();

		expect(account.calls).toEqual([false, false]);
		expect(account.observationSubscribed).toBe(true);
	});

	test("re-subscribing preserves the active sweep the subscriber asked for", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();
		await keeper.acquire("p1", account, true);

		account.drop();
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();

		expect(account.calls).toEqual([true, true]);
		expect(account.observationActiveScan).toBe(true);
	});

	test("does not re-subscribe once the last subscriber has released", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();
		const release = await keeper.acquire("p1", account, false);

		release();
		account.drop();
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();

		expect(account.calls).toEqual([false]);
		expect(keeper.hasSubscribers("p1")).toBe(false);
	});

	test("keeps the watch while one of two subscribers releases", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();
		const releaseA = await keeper.acquire("p1", account, false);
		await keeper.acquire("p1", account, false);

		releaseA();
		account.drop();
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();

		expect(account.calls).toEqual([false, false]);
		expect(keeper.hasSubscribers("p1")).toBe(true);
	});

	test("releasing twice does not double-decrement the reference count", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();
		const release = await keeper.acquire("p1", account, false);
		await keeper.acquire("p1", account, false);

		release();
		release();

		expect(keeper.hasSubscribers("p1")).toBe(true);
	});

	test("a re-subscribe failure is swallowed and leaves the holder for the next attempt", async () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();
		await keeper.acquire("p1", account, false);

		account.drop();
		account.error = new Error("in transit");
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();
		await Promise.resolve();

		expect(keeper.hasSubscribers("p1")).toBe(true);

		account.error = null;
		keeper.resubscribeIfDropped("p1", account);
		await Promise.resolve();
		expect(account.observationSubscribed).toBe(true);
	});

	test("is a no-op for an account that never had a subscriber", () => {
		const account = new FakeSubscribable();
		const keeper = new ObservationSubscriptionKeeper();

		keeper.resubscribeIfDropped("p1", account);

		expect(account.calls).toEqual([]);
	});
});
