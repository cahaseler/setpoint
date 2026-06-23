import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { BandwidthTracker } from "../../src/util/bandwidth-tracker.js";
import type { Logger } from "../../src/util/logger.js";

function makeMockLogger(): Logger & { infoMessages: string[]; debugMessages: string[] } {
	const infoMessages: string[] = [];
	const debugMessages: string[] = [];
	return {
		infoMessages,
		debugMessages,
		debug: (msg: string) => debugMessages.push(msg),
		info: (msg: string) => infoMessages.push(msg),
		warn: mock(() => {}),
		error: mock(() => {}),
	};
}

describe("BandwidthTracker", () => {
	describe("record()", () => {
		test("accumulates bytes per account and endpoint", () => {
			const tracker = new BandwidthTracker();
			tracker.record("Player1", "/api/v2/spacemolt/travel", 1000);
			tracker.record("Player2", "/api/v2/spacemolt/get_state", 500);
			tracker.record("Player1", "/api/v2/spacemolt/get_state", 200);

			const stats = tracker.getStats();
			expect(stats.requests).toBe(3);
			expect(stats.bytes).toBe(1700);
			expect(stats.byAccount.get("Player1")).toBe(1200);
			expect(stats.byAccount.get("Player2")).toBe(500);
			expect(stats.byEndpoint.get("/api/v2/spacemolt/travel")).toBe(1000);
			expect(stats.byEndpoint.get("/api/v2/spacemolt/get_state")).toBe(700);
		});

		test("logs a debug line per request", () => {
			const logger = makeMockLogger();
			const tracker = new BandwidthTracker({ logger });
			tracker.record("Player1", "/api/v2/spacemolt/travel", 1000);

			expect(logger.debugMessages).toHaveLength(1);
			expect(logger.debugMessages[0]).toContain("Player1");
			expect(logger.debugMessages[0]).toContain("/api/v2/spacemolt/travel");
			expect(logger.debugMessages[0]).toContain("1000");
		});
	});

	describe("flush()", () => {
		test("resets the accumulator after flushing", () => {
			const tracker = new BandwidthTracker();
			tracker.record("Player1", "/api/v2/spacemolt/travel", 1000);
			tracker.flush();

			const stats = tracker.getStats();
			expect(stats.requests).toBe(0);
			expect(stats.bytes).toBe(0);
			expect(stats.byAccount.size).toBe(0);
			expect(stats.byEndpoint.size).toBe(0);
		});

		test("logs an info summary with totals and breakdowns", () => {
			const logger = makeMockLogger();
			const tracker = new BandwidthTracker({ logger });
			tracker.record("Player1", "/api/v2/spacemolt/travel", 2000);
			tracker.record("Player2", "/api/v2/spacemolt/get_state", 1000);
			tracker.flush();

			expect(logger.infoMessages).toHaveLength(1);
			const msg = logger.infoMessages[0] ?? "";
			expect(msg).toContain("Player1");
			expect(msg).toContain("Player2");
			expect(msg).toContain("/api/v2/spacemolt/travel");
			expect(msg).toContain("/api/v2/spacemolt/get_state");
		});

		test("skips logging when no requests recorded", () => {
			const logger = makeMockLogger();
			const tracker = new BandwidthTracker({ logger });
			tracker.flush();

			expect(logger.infoMessages).toHaveLength(0);
		});

		test("summary lists accounts ordered by bytes descending", () => {
			const logger = makeMockLogger();
			const tracker = new BandwidthTracker({ logger });
			tracker.record("LowBandwidth", "/api/v2/spacemolt/get_state", 100);
			tracker.record("HighBandwidth", "/api/v2/spacemolt/travel", 9000);
			tracker.flush();

			const msg = logger.infoMessages[0] ?? "";
			const highPos = msg.indexOf("HighBandwidth");
			const lowPos = msg.indexOf("LowBandwidth");
			expect(highPos).toBeGreaterThanOrEqual(0);
			expect(lowPos).toBeGreaterThan(highPos);
		});

		test("caps account list at 5 entries", () => {
			const tracker = new BandwidthTracker();
			for (let i = 0; i < 8; i++) {
				tracker.record(`Player${i}`, "/api/v2/spacemolt/get_state", 100 * (i + 1));
			}
			const stats = tracker.getStats();
			// getStats should return all 8
			expect(stats.byAccount.size).toBe(8);

			const logger = makeMockLogger();
			const tracker2 = new BandwidthTracker({ logger });
			for (let i = 0; i < 8; i++) {
				tracker2.record(`Player${i}`, "/api/v2/spacemolt/get_state", 100 * (i + 1));
			}
			tracker2.flush();

			// The summary should mention at most 5 accounts
			const msg = logger.infoMessages[0] ?? "";
			const accountMatches = msg.match(/Player\d/g) ?? [];
			expect(accountMatches.length).toBeLessThanOrEqual(5);
		});
	});

	describe("start() / stop()", () => {
		let tracker: BandwidthTracker;

		beforeEach(() => {
			tracker = new BandwidthTracker();
		});

		afterEach(() => {
			tracker.stop();
		});

		test("stop() is safe to call when not started", () => {
			expect(() => tracker.stop()).not.toThrow();
		});

		test("start() then stop() does not throw", () => {
			tracker.start(60_000);
			expect(() => tracker.stop()).not.toThrow();
		});

		test("calling start() twice replaces the existing timer", () => {
			tracker.start(60_000);
			expect(() => tracker.start(60_000)).not.toThrow();
		});
	});
});
