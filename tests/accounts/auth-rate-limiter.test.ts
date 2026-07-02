import { describe, expect, test } from "bun:test";
import { AuthRateLimiter } from "../../src/accounts/manager.js";

/** Largest number of grants whose timestamps fall within any windowMs-wide span. */
function maxGrantsInAnyWindow(times: number[], windowMs: number): number {
	let max = 0;
	for (const t of times) {
		const count = times.filter((x) => x >= t && x < t + windowMs).length;
		if (count > max) {
			max = count;
		}
	}
	return max;
}

describe("AuthRateLimiter", () => {
	test("never grants more than maxPerWindow within any rolling window", async () => {
		const maxPerWindow = 3;
		const windowMs = 200;
		const limiter = new AuthRateLimiter(maxPerWindow, windowMs);

		const grantTimes: number[] = [];
		// Fire more than two windows' worth, all at once, with no external spacing.
		await Promise.all(
			Array.from({ length: 2 * maxPerWindow + 1 }, () =>
				limiter.acquire().then(() => {
					grantTimes.push(Date.now());
				}),
			),
		);

		expect(maxGrantsInAnyWindow(grantTimes, windowMs)).toBeLessThanOrEqual(maxPerWindow);
	});

	test("grants the first maxPerWindow immediately without waiting a full window", async () => {
		const maxPerWindow = 3;
		const windowMs = 1000;
		const limiter = new AuthRateLimiter(maxPerWindow, windowMs);

		const start = Date.now();
		await Promise.all(Array.from({ length: maxPerWindow }, () => limiter.acquire()));
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(windowMs);
	});

	test("delays the grant past maxPerWindow until the oldest leaves the window", async () => {
		const maxPerWindow = 2;
		const windowMs = 200;
		const limiter = new AuthRateLimiter(maxPerWindow, windowMs);

		const start = Date.now();
		await Promise.all(Array.from({ length: maxPerWindow }, () => limiter.acquire()));
		await limiter.acquire();
		const elapsed = Date.now() - start;

		// The (maxPerWindow+1)th grant must wait for the first grant to age out.
		expect(elapsed).toBeGreaterThanOrEqual(windowMs - 25);
	});
});
