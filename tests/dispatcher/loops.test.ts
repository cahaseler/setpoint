import { describe, expect, test } from "bun:test";
import type { Goal, GoalContext, GoalResult } from "../../src/dispatcher/goals.js";
import { runLoop } from "../../src/dispatcher/loops.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints } from "../fixtures/mock-endpoints.js";

function stubGoal(name: string, result: GoalResult): Goal {
	return {
		name,
		execute: async () => result,
	};
}

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 100 },
		ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
		cargo: undefined,
		location: { system_id: "sol", system_name: "Sol" },
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeCtx(overrides: Partial<GoalContext> = {}): GoalContext {
	return {
		endpoints: createMockEndpoints(),
		state: makeState(),
		...overrides,
	};
}

describe("runLoop", () => {
	test("runs factory for maxIterations", async () => {
		let callCount = 0;

		const result = await runLoop(
			() => {
				callCount++;
				return stubGoal("work", {
					success: true,
					message: "done",
					alreadySatisfied: false,
					ticksUsed: 2,
				});
			},
			makeCtx(),
			{ maxIterations: 3 },
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(3);
		expect(result.ticksUsed).toBe(6);
		expect(result.iterations).toHaveLength(3);
		expect(callCount).toBe(3);
	});

	test("stops on goal failure", async () => {
		let iteration = 0;

		const result = await runLoop(
			() => {
				iteration++;
				if (iteration === 2) {
					return stubGoal("fail", {
						success: false,
						message: "boom",
						alreadySatisfied: false,
						ticksUsed: 0,
					});
				}
				return stubGoal("work", {
					success: true,
					message: "ok",
					alreadySatisfied: false,
					ticksUsed: 1,
				});
			},
			makeCtx(),
			{ maxIterations: 5, maxConsecutiveFailures: 1 },
		);

		expect(result.success).toBe(false);
		expect(result.iterationCount).toBe(2);
		expect(result.ticksUsed).toBe(1);
		expect(result.iterations).toHaveLength(2);
		expect(result.message).toContain("boom");
	});

	test("retries iteration after goal failure", async () => {
		let attempts = 0;

		const result = await runLoop(
			() => {
				attempts++;
				const willSucceed = attempts > 1;
				return stubGoal("retry-me", {
					success: willSucceed,
					message: willSucceed ? "ok" : "fail",
					alreadySatisfied: false,
					ticksUsed: willSucceed ? 1 : 0,
				});
			},
			makeCtx(),
			{ maxIterations: 1, maxConsecutiveFailures: 2, retryDelayMs: 0 },
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(result.ticksUsed).toBe(1);
		expect(attempts).toBe(2);
	});

	test("resets consecutive failure counter after success", async () => {
		// Pattern: fail, succeed, fail, succeed — never reaches maxConsecutiveFailures: 2
		const outcomes = [false, true, false, true];
		let attempts = 0;

		const result = await runLoop(
			() => {
				const success = outcomes[attempts] ?? true;
				attempts++;
				return stubGoal("alternating", {
					success,
					message: success ? "ok" : "fail",
					alreadySatisfied: false,
					ticksUsed: success ? 1 : 0,
				});
			},
			makeCtx(),
			{ maxIterations: 2, maxConsecutiveFailures: 2, retryDelayMs: 0 },
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(result.ticksUsed).toBe(2);
	});

	test("stops after maxConsecutiveFailures thrown exceptions", async () => {
		const result = await runLoop(
			() => ({
				name: "exploder",
				execute: async (): Promise<GoalResult> => {
					throw new Error("kaboom");
				},
			}),
			makeCtx(),
			{ maxIterations: 10, maxConsecutiveFailures: 3, retryDelayMs: 0 },
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("kaboom");
		expect(result.message).toContain("3 consecutive");
	});

	test("stops when shouldContinue returns false", async () => {
		const result = await runLoop(
			() =>
				stubGoal("work", { success: true, message: "ok", alreadySatisfied: false, ticksUsed: 1 }),
			makeCtx(),
			{
				maxIterations: 10,
				shouldContinue: (i) => i < 2,
			},
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(result.ticksUsed).toBe(2);
	});

	test("stops when AbortSignal is aborted", async () => {
		const controller = new AbortController();

		let iteration = 0;
		const result = await runLoop(
			() => {
				iteration++;
				if (iteration >= 2) {
					controller.abort();
				}
				return stubGoal("work", {
					success: true,
					message: "ok",
					alreadySatisfied: false,
					ticksUsed: 1,
				});
			},
			makeCtx(),
			{ signal: controller.signal, maxIterations: 100 },
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(result.message).toContain("cancelled");
	});

	test("returns cancelled when an iteration fails due to abort, without counting a failure", async () => {
		const controller = new AbortController();
		let refreshCount = 0;
		const ctx = makeCtx({
			refreshState: async () => {
				refreshCount++;
				return makeState();
			},
		});

		const result = await runLoop(
			() => ({
				name: "abortable",
				execute: async () => {
					// Force abort lands mid-goal; the goal notices and returns a failed result.
					controller.abort();
					return {
						success: false,
						message: "Navigation to target aborted after 1 tick(s)",
						alreadySatisfied: false,
						ticksUsed: 1,
					};
				},
			}),
			ctx,
			{ signal: controller.signal, maxIterations: 100, retryDelayMs: 0 },
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("cancelled");
		expect(result.ticksUsed).toBe(1);
		// Only the initial refresh — no retry-path refresh after the aborted iteration.
		expect(refreshCount).toBe(1);
	});

	test("returns cancelled when an iteration throws after abort, without counting a failure", async () => {
		const controller = new AbortController();
		let refreshCount = 0;
		const ctx = makeCtx({
			refreshState: async () => {
				refreshCount++;
				return makeState();
			},
		});

		const result = await runLoop(
			() => ({
				name: "abortable",
				execute: async () => {
					controller.abort();
					throw new Error("connection dropped during abort");
				},
			}),
			ctx,
			{ signal: controller.signal, maxIterations: 100, retryDelayMs: 0 },
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("cancelled");
		expect(refreshCount).toBe(1);
	});

	test("refreshes state between iterations", async () => {
		let refreshCount = 0;
		const statesSeenByFactory: StoredGameState[] = [];
		const freshState = makeState({
			player: { id: "p1", username: "Test", credits: 999 },
		});

		const result = await runLoop(
			(state) => {
				statesSeenByFactory.push(state);
				return stubGoal("work", {
					success: true,
					message: "ok",
					alreadySatisfied: false,
					ticksUsed: 1,
				});
			},
			makeCtx({
				refreshState: async () => {
					refreshCount++;
					return freshState;
				},
			}),
			{ maxIterations: 2 },
		);

		expect(result.success).toBe(true);
		// Refresh at loop start, after iteration 0, and after iteration 1
		expect(refreshCount).toBe(3);
		// Factory sees refreshed state from the start (loop refreshes before first iteration)
		expect(statesSeenByFactory[0]?.player?.credits).toBe(999);
		expect(statesSeenByFactory[1]?.player?.credits).toBe(999);
	});

	test("factory receives current state", async () => {
		const statesReceived: StoredGameState[] = [];

		await runLoop(
			(state) => {
				statesReceived.push(state);
				return stubGoal("work", {
					success: true,
					message: "ok",
					alreadySatisfied: false,
					ticksUsed: 1,
				});
			},
			makeCtx(),
			{ maxIterations: 2 },
		);

		expect(statesReceived).toHaveLength(2);
		expect(statesReceived[0]?.player?.id).toBe("p1");
	});

	test("returns immediately with maxIterations 0", async () => {
		let callCount = 0;

		const result = await runLoop(
			() => {
				callCount++;
				return stubGoal("work", {
					success: true,
					message: "ok",
					alreadySatisfied: false,
					ticksUsed: 1,
				});
			},
			makeCtx(),
			{ maxIterations: 0 },
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(0);
		expect(result.ticksUsed).toBe(0);
		expect(result.iterations).toHaveLength(0);
		expect(callCount).toBe(0);
	});

	test("refreshes state before retrying failed iteration", async () => {
		let refreshCount = 0;
		let attempts = 0;

		const result = await runLoop(
			() => {
				attempts++;
				// First attempt always fails, second always succeeds.
				// The key assertion is that refreshState is called between retries.
				const willSucceed = attempts > 1;
				return stubGoal("work", {
					success: willSucceed,
					message: willSucceed ? "ok" : "fail",
					alreadySatisfied: false,
					ticksUsed: willSucceed ? 1 : 0,
				});
			},
			makeCtx({
				refreshState: async () => {
					refreshCount++;
					return makeState();
				},
			}),
			{ maxIterations: 1, maxConsecutiveFailures: 2, retryDelayMs: 0 },
		);

		expect(result.success).toBe(true);
		expect(attempts).toBe(2);
		// refreshState called: once at loop start, once before retry, once after success
		expect(refreshCount).toBe(3);
	});

	test("refreshes state before retrying after thrown exception", async () => {
		let refreshCount = 0;
		let attempts = 0;

		const result = await runLoop(
			() => {
				attempts++;
				if (attempts === 1) {
					return {
						name: "exploder",
						execute: async (): Promise<GoalResult> => {
							throw new Error("kaboom");
						},
					};
				}
				return stubGoal("work", {
					success: true,
					message: "ok",
					alreadySatisfied: false,
					ticksUsed: 1,
				});
			},
			makeCtx({
				refreshState: async () => {
					refreshCount++;
					return makeState();
				},
			}),
			{ maxIterations: 1, maxConsecutiveFailures: 2, retryDelayMs: 0 },
		);

		expect(result.success).toBe(true);
		expect(attempts).toBe(2);
		expect(refreshCount).toBeGreaterThanOrEqual(1);
	});

	test("accumulates ticks across iterations", async () => {
		let tick = 0;

		const result = await runLoop(
			() => {
				tick++;
				return stubGoal("work", {
					success: true,
					message: "ok",
					alreadySatisfied: false,
					ticksUsed: tick,
				});
			},
			makeCtx(),
			{ maxIterations: 3 },
		);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(6); // 1 + 2 + 3
		expect(result.iterations[0]?.result.ticksUsed).toBe(1);
		expect(result.iterations[1]?.result.ticksUsed).toBe(2);
		expect(result.iterations[2]?.result.ticksUsed).toBe(3);
	});
});
