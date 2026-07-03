import { describe, expect, test } from "bun:test";
import {
	STATE_FRESHNESS_TTL_MS,
	isStateStale,
	markStateFresh,
} from "../../src/dispatcher/state-freshness.js";

describe("state-freshness", () => {
	test("a just-marked account is not stale", () => {
		const account = {};
		markStateFresh(account, 1_000_000);
		expect(isStateStale(account, STATE_FRESHNESS_TTL_MS, 1_000_000)).toBe(false);
	});

	test("marked with an old timestamp is stale once the TTL has elapsed", () => {
		const account = {};
		markStateFresh(account, 0);
		expect(isStateStale(account, STATE_FRESHNESS_TTL_MS, STATE_FRESHNESS_TTL_MS + 1)).toBe(true);
	});

	test("querying with a future now makes a fresh mark stale", () => {
		const account = {};
		markStateFresh(account, 1_000_000);
		const future = 1_000_000 + STATE_FRESHNESS_TTL_MS + 1;
		expect(isStateStale(account, STATE_FRESHNESS_TTL_MS, future)).toBe(true);
	});

	test("exactly at the TTL boundary is not yet stale", () => {
		const account = {};
		markStateFresh(account, 0);
		expect(isStateStale(account, STATE_FRESHNESS_TTL_MS, STATE_FRESHNESS_TTL_MS)).toBe(false);
	});

	test("an unmarked account is not stale", () => {
		const account = {};
		expect(isStateStale(account)).toBe(false);
	});
});
