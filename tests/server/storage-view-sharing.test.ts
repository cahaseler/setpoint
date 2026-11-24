import { describe, expect, test } from "bun:test";
import type { QueryResult, StateSection } from "@spacemolt/lib";
import {
	STORAGE_VIEW_SHARE_MAX_AGE_MS,
	type StorageViewAccount,
	forgetStorageViews,
	shareStorageView,
	storageViewKey,
} from "../../src/server/storage-view-sharing.js";

type TestAccount = StorageViewAccount & {
	currentTick: number;
	emitStateChange(): void;
};

function makeAccount(tick = 100): TestAccount {
	const listeners: Array<(changed: StateSection[]) => void> = [];
	return {
		currentTick: tick,
		onStateChange: (listener) => {
			listeners.push(listener);
		},
		emitStateChange: () => {
			for (const listener of listeners) listener(["cargo"]);
		},
	};
}

function countingRead(): { read: () => Promise<QueryResult>; calls: () => number } {
	let calls = 0;
	return {
		read: () => {
			calls++;
			return Promise.resolve({ result: `view ${calls}`, structuredContent: { n: calls } });
		},
		calls: () => calls,
	};
}

const FACTION = { target: "faction", station_id: "sol_station" };

describe("shareStorageView", () => {
	test("answers a repeat in the same tick from the first view", async () => {
		const account = makeAccount();
		const { read, calls } = countingRead();

		const first = await shareStorageView(account, FACTION, read);
		const second = await shareStorageView(account, { ...FACTION }, read);

		expect(calls()).toBe(1);
		expect(first.shared).toBe(false);
		expect(second.shared).toBe(true);
		expect(second.result).toEqual(first.result);
	});

	test("shares a view that is still in flight", async () => {
		const account = makeAccount();
		let calls = 0;
		let resolve: (r: QueryResult) => void = () => {};
		const read = (): Promise<QueryResult> => {
			calls++;
			return new Promise((r) => {
				resolve = r;
			});
		};

		const first = shareStorageView(account, FACTION, read);
		const second = shareStorageView(account, FACTION, read);
		resolve({ result: "view" });

		expect((await first).shared).toBe(false);
		expect((await second).shared).toBe(true);
		expect(calls).toBe(1);
	});

	test("reads again for different params", async () => {
		const account = makeAccount();
		const { read, calls } = countingRead();

		await shareStorageView(account, FACTION, read);
		await shareStorageView(account, { ...FACTION, bucket: "ore" }, read);
		await shareStorageView(account, { target: "self", station_id: "sol_station" }, read);

		expect(calls()).toBe(3);
	});

	test("reads again once the account's tick has moved", async () => {
		const account = makeAccount(100);
		const { read, calls } = countingRead();

		await shareStorageView(account, FACTION, read);
		account.currentTick = 101;
		const next = await shareStorageView(account, FACTION, read);

		expect(calls()).toBe(2);
		expect(next.shared).toBe(false);
	});

	test("reads again after the age cap even if no new tick was seen", async () => {
		const account = makeAccount();
		const { read, calls } = countingRead();
		let clock = 1_000;
		const now = (): number => clock;

		await shareStorageView(account, FACTION, read, now);
		clock += STORAGE_VIEW_SHARE_MAX_AGE_MS - 1;
		await shareStorageView(account, FACTION, read, now);
		expect(calls()).toBe(1);
		clock += 1;
		await shareStorageView(account, FACTION, read, now);
		expect(calls()).toBe(2);
	});

	test("reads again after the account's state changes", async () => {
		const account = makeAccount();
		const { read, calls } = countingRead();

		await shareStorageView(account, FACTION, read);
		account.emitStateChange();
		await shareStorageView(account, FACTION, read);

		expect(calls()).toBe(2);
	});

	test("reads again after forgetStorageViews", async () => {
		const account = makeAccount();
		const { read, calls } = countingRead();

		await shareStorageView(account, FACTION, read);
		forgetStorageViews(account);
		await shareStorageView(account, FACTION, read);

		expect(calls()).toBe(2);
	});

	test("does not keep a failed view, and every sharer sees the failure", async () => {
		const account = makeAccount();
		let calls = 0;
		const failing = (): Promise<QueryResult> => {
			calls++;
			return Promise.reject(new Error("refused"));
		};

		const outcomes = await Promise.allSettled([
			shareStorageView(account, FACTION, failing),
			shareStorageView(account, FACTION, failing),
		]);
		expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
		expect(calls).toBe(1);

		const { read } = countingRead();
		expect((await shareStorageView(account, FACTION, read)).shared).toBe(false);
	});

	test("never shares between accounts", async () => {
		const { read, calls } = countingRead();

		await shareStorageView(makeAccount(), FACTION, read);
		await shareStorageView(makeAccount(), FACTION, read);

		expect(calls()).toBe(2);
	});
});

describe("storageViewKey", () => {
	test("ignores field order but not values", () => {
		expect(storageViewKey({ a: 1, b: "x" })).toBe(storageViewKey({ b: "x", a: 1 }));
		expect(storageViewKey({ a: 1 })).not.toBe(storageViewKey({ a: 2 }));
	});
});
