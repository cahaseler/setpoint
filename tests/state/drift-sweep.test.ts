import { describe, expect, test } from "bun:test";
import { startDriftSweep } from "../../src/state/drift-sweep.js";
import { FakeLibManagedAccount, makeFakeLibManager } from "../dispatcher/lib-fakes.js";

describe("startDriftSweep", () => {
	test("runOnce() refreshes every connected account", async () => {
		const a1 = new FakeLibManagedAccount({ playerId: "p1", username: "Alpha" });
		const a2 = new FakeLibManagedAccount({ playerId: "p2", username: "Beta" });
		const manager = makeFakeLibManager([a1, a2]);

		const sweep = startDriftSweep(manager, { intervalMs: 60_000 });
		await sweep.runOnce();
		sweep.stop();

		expect(a1.refreshCalls).toBe(1);
		expect(a2.refreshCalls).toBe(1);
	});

	test("a failing refresh on one account does not stop the rest", async () => {
		const a1 = new FakeLibManagedAccount({ playerId: "p1", username: "Alpha" });
		const a2 = new FakeLibManagedAccount({ playerId: "p2", username: "Beta" });
		a1.refresh = (): Promise<never> => Promise.reject(new Error("boom"));
		const manager = makeFakeLibManager([a1, a2]);

		const sweep = startDriftSweep(manager, { intervalMs: 60_000 });
		await sweep.runOnce();
		sweep.stop();

		expect(a2.refreshCalls).toBe(1);
	});

	test("a second runOnce() while the first is still in flight is skipped", async () => {
		const a1 = new FakeLibManagedAccount({ playerId: "p1", username: "Alpha" });
		let callCount = 0;
		let resolveRefresh: (() => void) | undefined;
		a1.refresh = () => {
			callCount++;
			return new Promise((resolve) => {
				resolveRefresh = () => resolve(a1.state);
			});
		};
		const manager = makeFakeLibManager([a1]);

		const sweep = startDriftSweep(manager, { intervalMs: 60_000 });
		const first = sweep.runOnce();
		const second = sweep.runOnce(); // should return immediately without calling refresh again

		await second;
		resolveRefresh?.();
		await first;
		sweep.stop();

		expect(callCount).toBe(1);
	});
});
