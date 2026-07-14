import { describe, expect, test } from "bun:test";
import type { ExecutingGoalEntry } from "../../src/server/account-release.js";
import { forceReleaseAccount } from "../../src/server/account-release.js";
import type { JobManager } from "../../src/server/job-manager.js";
import type { LoopManager } from "../../src/server/loop-manager.js";

function fakeProgress() {
	return { goalType: "test-goal", goalOptions: {}, completedSteps: [], remainingSteps: [] };
}

describe("forceReleaseAccount", () => {
	test("force-removes a running loop, deletes its config, aborts a sync goal and job, and clears bookkeeping", () => {
		const forceRemoveCalls: string[] = [];
		const deleteConfigCalls: string[] = [];
		const loopManager = {
			getStatus: () => ({ type: "mining", startedAt: "now", running: true, options: {} }),
			forceRemove: (id: string) => {
				forceRemoveCalls.push(id);
				return true;
			},
			deleteLoopConfig: (id: string) => {
				deleteConfigCalls.push(id);
				return Promise.resolve();
			},
		};

		const syncController = new AbortController();
		const executingGoals = new Map<string, ExecutingGoalEntry>([
			[
				"p1",
				{
					goalType: "navigate-to-system",
					startedAt: "now",
					controller: syncController,
					progress: fakeProgress(),
					promise: Promise.resolve(),
				},
			],
		]);

		const jobController = new AbortController();
		let failAllRunningCalledWith: string | undefined;
		const jobManager = {
			getRunningJob: () => ({ jobId: "job-1" }),
			getExecutionForAccount: () => ({ controller: jobController, progress: fakeProgress() }),
			failAllRunning: (id: string) => {
				failAllRunningCalledWith = id;
			},
		};

		forceReleaseAccount(
			{
				loopManager: loopManager as unknown as LoopManager,
				jobManager: jobManager as unknown as JobManager,
				executingGoals,
				configDir: "/tmp/config",
			},
			"p1",
		);

		expect(forceRemoveCalls).toEqual(["p1"]);
		expect(deleteConfigCalls).toEqual(["p1"]);
		expect(syncController.signal.aborted).toBe(true);
		expect(jobController.signal.aborted).toBe(true);
		expect(executingGoals.has("p1")).toBe(false);
		expect(failAllRunningCalledWith).toBe("p1");
	});

	test("no-ops on loop/job release when nothing is running, but still clears executingGoals and calls failAllRunning", () => {
		let forceRemoveCalled = false;
		const loopManager = {
			getStatus: () => undefined,
			forceRemove: () => {
				forceRemoveCalled = true;
				return false;
			},
			deleteLoopConfig: () => Promise.resolve(),
		};

		let failAllRunningCalledWith: string | undefined;
		const jobManager = {
			getRunningJob: () => undefined,
			getExecutionForAccount: () => undefined,
			failAllRunning: (id: string) => {
				failAllRunningCalledWith = id;
			},
		};

		const executingGoals = new Map<string, ExecutingGoalEntry>();

		forceReleaseAccount(
			{
				loopManager: loopManager as unknown as LoopManager,
				jobManager: jobManager as unknown as JobManager,
				executingGoals,
				configDir: "/tmp/config",
			},
			"p1",
		);

		expect(forceRemoveCalled).toBe(false);
		expect(failAllRunningCalledWith).toBe("p1");
	});
});
