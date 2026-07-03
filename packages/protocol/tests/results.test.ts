import { expect, test } from "bun:test";
import type {
	CompoundGoalResult,
	GoalResult,
	IterationResult,
	JobRecord,
	JobStatus,
	LoopResult,
	LoopStatus,
	RawEnvelope,
	StepResult,
} from "../src/results.js";

test("GoalResult shape", () => {
	const r: GoalResult = { success: true, message: "ok", alreadySatisfied: false, ticksUsed: 0 };
	expect(r.success).toBe(true);
});

test("StepResult and CompoundGoalResult shape", () => {
	const step: StepResult = {
		goalName: "navigate-to-system",
		result: { success: true, message: "arrived", alreadySatisfied: false, ticksUsed: 3 },
	};
	const compound: CompoundGoalResult = {
		success: true,
		message: "sequence complete",
		alreadySatisfied: false,
		ticksUsed: 3,
		steps: [step],
	};
	expect(compound.steps).toHaveLength(1);
});

test("IterationResult and LoopResult shape", () => {
	const iteration: IterationResult = {
		iteration: 1,
		result: { success: true, message: "mined", alreadySatisfied: false, ticksUsed: 1 },
	};
	const loop: LoopResult = {
		success: true,
		message: "loop finished",
		alreadySatisfied: false,
		ticksUsed: 1,
		iterations: [iteration],
		iterationCount: 1,
	};
	expect(loop.iterationCount).toBe(1);
});

test("LoopStatus shape, including optional fields omitted", () => {
	const minimal: LoopStatus = {
		type: "mining",
		startedAt: new Date().toISOString(),
		running: true,
	};
	const withOptions: LoopStatus = {
		type: "mining",
		startedAt: new Date().toISOString(),
		running: true,
		lastStep: "mined 50 ore",
		options: { miningSystemId: "sol" },
		result: {
			success: true,
			message: "done",
			alreadySatisfied: false,
			ticksUsed: 2,
			iterations: [],
			iterationCount: 0,
		},
	};
	expect(minimal.running).toBe(true);
	expect(withOptions.options?.["miningSystemId"]).toBe("sol");
});

test("JobStatus union and JobRecord shape", () => {
	const statuses: JobStatus[] = ["pending", "running", "completed", "failed"];
	expect(statuses).toHaveLength(4);

	const pendingJob: JobRecord = {
		jobId: "job-1",
		accountId: "acct-1",
		submittedAt: new Date().toISOString(),
		status: "pending",
	};

	const completedJob: JobRecord = {
		jobId: "job-2",
		accountId: "acct-1",
		goalType: "navigate-to-system",
		goalOptions: { targetSystemId: "sol" },
		submittedAt: new Date().toISOString(),
		status: "completed",
		completedAt: new Date().toISOString(),
		result: { success: true, message: "arrived", alreadySatisfied: false, ticksUsed: 4 },
	};

	const failedJob: JobRecord = {
		jobId: "job-3",
		accountId: "acct-1",
		submittedAt: new Date().toISOString(),
		status: "failed",
		error: "something broke",
	};

	expect(pendingJob.status).toBe("pending");
	expect(completedJob.result?.success).toBe(true);
	expect(failedJob.error).toBe("something broke");
});

test("RawEnvelope shape (single shape for mutation and query responses)", () => {
	const env: RawEnvelope = {
		result: "You travel to Sol.",
		structuredContent: { location: { system_id: "sol" } },
		notifications: [],
	};
	expect(env.notifications).toEqual([]);
});
