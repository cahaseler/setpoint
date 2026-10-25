import { describe, expect, spyOn, test } from "bun:test";
import { GameCallGate, ipBlockDurationMs } from "../../src/accounts/game-call-gate.js";

const BLOCK_MESSAGE =
	"Your IP has been temporarily blocked due to excessive rate limit violations. Try again in 120 seconds.";

/** A clock the test advances by hand; `sleep` moves it forward instead of waiting. */
function fakeClock(start = 1_000_000): {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	slept: number[];
} {
	let t = start;
	const slept: number[] = [];
	return {
		now: () => t,
		sleep: (ms) => {
			slept.push(ms);
			t += ms;
			return Promise.resolve();
		},
		slept,
	};
}

/** An account double whose query/mutate record calls and can be told to fail. */
function fakeAccount(): {
	query: (...args: never[]) => Promise<unknown>;
	mutate: (...args: never[]) => Promise<unknown>;
	calls: string[];
	failNextWith: Error | null;
} {
	const account = {
		calls: [] as string[],
		failNextWith: null as Error | null,
		query(..._args: never[]): Promise<unknown> {
			account.calls.push("query");
			const err = account.failNextWith;
			account.failNextWith = null;
			return err ? Promise.reject(err) : Promise.resolve("ok");
		},
		mutate(..._args: never[]): Promise<unknown> {
			account.calls.push("mutate");
			return Promise.resolve("ok");
		},
	};
	return account;
}

describe("ipBlockDurationMs", () => {
	test("reads the wait from the game's block notice", () => {
		expect(ipBlockDurationMs(new Error(BLOCK_MESSAGE))).toBe(120_000);
	});

	test("falls back to 120s when the notice states no wait", () => {
		expect(ipBlockDurationMs(new Error("Your IP has been temporarily blocked."))).toBe(120_000);
	});

	test("is undefined for any other error, including an ordinary rate limit", () => {
		expect(ipBlockDurationMs(new Error("rate_limited: slow down"))).toBeUndefined();
		expect(
			ipBlockDurationMs(new Error("No response to spacemolt/get_status within 15000ms")),
		).toBeUndefined();
	});
});

describe("GameCallGate", () => {
	test("passes calls straight through when nothing is in force", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const account = fakeAccount();
		gate.install("p1", account);

		await account.query();
		await account.mutate();

		expect(account.calls).toEqual(["query", "mutate"]);
		expect(clock.slept).toEqual([]);
	});

	test("an IP block holds every account's next call until it lifts, plus a margin", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount();
		const b = fakeAccount();
		gate.install("p1", a);
		gate.install("p2", b);

		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		a.failNextWith = new Error(BLOCK_MESSAGE);
		await expect(a.query()).rejects.toThrow("temporarily blocked");
		warnSpy.mockRestore();

		expect(gate.ipBlockRemainingMs()).toBe(125_000);
		await b.query();
		// The other account's call waited out the block before going out.
		expect(clock.slept).toEqual([125_000]);
		expect(b.calls).toEqual(["query"]);
		expect(gate.ipBlockRemainingMs()).toBe(0);
	});

	test("a repeat block notice during a block does not shorten or re-log it", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

		gate.noteFailure(new Error(BLOCK_MESSAGE));
		gate.noteFailure(new Error(BLOCK_MESSAGE.replace("120", "30")));
		const warnings = warnSpy.mock.calls.length;
		warnSpy.mockRestore();

		expect(gate.ipBlockRemainingMs()).toBe(125_000);
		expect(warnings).toBe(1);
	});

	test("a rate-limited account holds only that account's new calls", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount();
		const b = fakeAccount();
		gate.install("p1", a);
		gate.install("p2", b);

		gate.noteRateLimited("p1", 40_000);
		await b.query();
		expect(clock.slept).toEqual([]);

		await a.query();
		expect(clock.slept).toEqual([40_000]);
	});

	test("the longer of two rate-limit windows wins", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount();
		gate.install("p1", a);

		gate.noteRateLimited("p1", 50_000);
		gate.noteRateLimited("p1", 10_000);
		await a.mutate();

		expect(clock.slept).toEqual([50_000]);
	});

	test("an ordinary failure passes through and leaves no hold", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount();
		gate.install("p1", a);

		a.failNextWith = new Error("not_docked: you must be docked");
		await expect(a.query()).rejects.toThrow("not_docked");
		await a.query();

		expect(gate.ipBlockRemainingMs()).toBe(0);
		expect(clock.slept).toEqual([]);
	});

	test("installing patches the account in place, keeping its identity", () => {
		const gate = new GameCallGate(fakeClock());
		const account = fakeAccount();
		const before = account;
		const originalQuery = account.query;

		gate.install("p1", account);

		expect(account).toBe(before);
		expect(account.query).not.toBe(originalQuery);
	});
});
