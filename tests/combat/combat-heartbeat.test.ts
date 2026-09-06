import { describe, expect, test } from "bun:test";
import { CombatHeartbeatStore } from "../../src/combat/combat-heartbeat.js";

describe("CombatHeartbeatStore", () => {
	test("reports how long a driver has been silent", () => {
		const store = new CombatHeartbeatStore();
		store.beat("p1", 1_000);
		expect(store.sinceLast("p1", 6_000)).toBe(5_000);
	});

	test("a driver that never checked in is undefined, not zero", () => {
		// Distinguishing "never seen" from "just seen" matters: the watchdog must
		// not treat an unknown account as freshly alive.
		expect(new CombatHeartbeatStore().sinceLast("p1")).toBeUndefined();
	});

	test("a later beat resets the silence", () => {
		const store = new CombatHeartbeatStore();
		store.beat("p1", 1_000);
		store.beat("p1", 9_000);
		expect(store.sinceLast("p1", 10_000)).toBe(1_000);
	});

	test("clearing forgets the account so the next battle starts clean", () => {
		const store = new CombatHeartbeatStore();
		store.beat("p1", 1_000);
		store.clear("p1");
		expect(store.sinceLast("p1", 2_000)).toBeUndefined();
	});

	test("accounts are tracked independently", () => {
		const store = new CombatHeartbeatStore();
		store.beat("p1", 1_000);
		store.beat("p2", 5_000);
		expect(store.sinceLast("p1", 6_000)).toBe(5_000);
		expect(store.sinceLast("p2", 6_000)).toBe(1_000);
	});
});
