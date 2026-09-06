import { describe, expect, test } from "bun:test";
import { JobManager } from "../../src/server/job-manager.js";
import { createMemoryDatabase } from "../../src/state/database.js";

function makeJobManager(): JobManager {
	return new JobManager(createMemoryDatabase());
}

describe("JobManager.create", () => {
	test("creates a running job with goalType and goalOptions", () => {
		const jm = makeJobManager();
		const opts = { targetSystemId: "sirius" };
		const job = jm.create("p1", "navigate-to-system", opts);

		expect(job.status).toBe("running");
		expect(job.goalType).toBe("navigate-to-system");
		expect(job.goalOptions).toEqual(opts);
		expect(typeof job.jobId).toBe("string");
		expect(job.accountId).toBe("p1");
	});

	test("creates a job without options", () => {
		const jm = makeJobManager();
		const job = jm.create("p1");

		expect(job.status).toBe("running");
		expect(job.goalType).toBeUndefined();
		expect(job.goalOptions).toBeUndefined();
	});

	test("creates a job with goalType but no options", () => {
		const jm = makeJobManager();
		const job = jm.create("p1", "ensure-undocked");

		expect(job.goalType).toBe("ensure-undocked");
		expect(job.goalOptions).toBeUndefined();
	});

	test("persists goalOptions and retrieves them via get()", () => {
		const jm = makeJobManager();
		const opts = { targetSystemId: "sirius", someFlag: true };
		const job = jm.create("p1", "navigate-to-system", opts);

		const retrieved = jm.get(job.jobId);
		expect(retrieved?.goalOptions).toEqual(opts);
		expect(retrieved?.goalType).toBe("navigate-to-system");
	});
});

describe("JobManager orphan handling on restart", () => {
	test("marks running jobs with goal_options as pending", () => {
		// Simulate a job created in a previous daemon run
		const jm1 = makeJobManager();
		const job = jm1.create("p1", "navigate-to-system", { targetSystemId: "sol" });
		expect(job.status).toBe("running");

		// Simulate daemon restart by creating a new JobManager on the same DB
		const db = (jm1 as unknown as { db: import("bun:sqlite").Database }).db;
		// Reconstruct on same DB — triggers markOrphanedJobs()
		const jm2 = new JobManager(db);

		const retrieved = jm2.get(job.jobId);
		expect(retrieved?.status).toBe("pending");
		expect(retrieved?.goalOptions).toEqual({ targetSystemId: "sol" });
		// error should not be set for pending jobs
		expect(retrieved?.error).toBeUndefined();
	});

	test("marks running jobs without goal_options as failed", () => {
		const jm1 = makeJobManager();
		const job = jm1.create("p1"); // no options
		expect(job.status).toBe("running");

		const db = (jm1 as unknown as { db: import("bun:sqlite").Database }).db;
		const jm2 = new JobManager(db);

		const retrieved = jm2.get(job.jobId);
		expect(retrieved?.status).toBe("failed");
		expect(retrieved?.error).toContain("Daemon restarted");
	});

	test("does not affect already-completed or already-failed jobs", () => {
		const jm1 = makeJobManager();
		const j1 = jm1.create("p1", "ensure-undocked", {});
		const j2 = jm1.create("p1", "ensure-undocked", {});
		jm1.complete(j1.jobId, {
			success: true,
			alreadySatisfied: false,
			message: "done",
			ticksUsed: 0,
		});
		jm1.fail(j2.jobId, "something went wrong");

		const db = (jm1 as unknown as { db: import("bun:sqlite").Database }).db;
		const jm2 = new JobManager(db);

		expect(jm2.get(j1.jobId)?.status).toBe("completed");
		expect(jm2.get(j2.jobId)?.status).toBe("failed");
	});
});

describe("JobManager.listPendingForAccount", () => {
	test("returns pending jobs for the account in submission order", () => {
		const jm1 = makeJobManager();
		const j1 = jm1.create("p1", "navigate-to-system", { targetSystemId: "sol" });
		const j2 = jm1.create("p1", "ensure-fueled", {});
		jm1.create("p2", "navigate-to-system", { targetSystemId: "alpha" }); // different account

		const db = (jm1 as unknown as { db: import("bun:sqlite").Database }).db;
		const jm2 = new JobManager(db);

		const pending = jm2.listPendingForAccount("p1");
		expect(pending).toHaveLength(2);
		expect(pending[0]?.jobId).toBe(j1.jobId);
		expect(pending[1]?.jobId).toBe(j2.jobId);
	});

	test("returns empty array when no pending jobs", () => {
		const jm = makeJobManager();
		expect(jm.listPendingForAccount("p1")).toHaveLength(0);
	});

	test("does not include running-without-options or completed jobs", () => {
		const jm1 = makeJobManager();
		const running = jm1.create("p1", "ensure-fueled"); // no options → cannot resume
		const completed = jm1.create("p1", "ensure-fueled", {});
		jm1.complete(completed.jobId, {
			success: true,
			alreadySatisfied: false,
			message: "done",
			ticksUsed: 0,
		});

		const db = (jm1 as unknown as { db: import("bun:sqlite").Database }).db;
		const jm2 = new JobManager(db);

		// running without options → failed on restart; completed stays completed
		expect(jm2.listPendingForAccount("p1")).toHaveLength(0);
		expect(jm2.get(running.jobId)?.status).toBe("failed");
		expect(jm2.get(completed.jobId)?.status).toBe("completed");
	});
});

describe("JobManager.requeue", () => {
	test("marks a pending job as running", () => {
		const jm1 = makeJobManager();
		const job = jm1.create("p1", "navigate-to-system", { targetSystemId: "sol" });

		const db = (jm1 as unknown as { db: import("bun:sqlite").Database }).db;
		const jm2 = new JobManager(db);

		expect(jm2.get(job.jobId)?.status).toBe("pending");
		jm2.requeue(job.jobId);
		expect(jm2.get(job.jobId)?.status).toBe("running");
		// isRunning should reflect this
		expect(jm2.isRunning("p1")).toBe(true);
	});
});

describe("job outcome", () => {
	test("a goal that ran to conclusion but failed its preconditions is outcome failed", () => {
		// The trap: status "completed" means the job finished, not that the thing
		// happened. A travel goal that fails its fuel check completes instantly
		// and the ship never moves.
		const jm = makeJobManager();
		const { jobId } = jm.create("acct-1", "navigate-to-system", {});
		jm.complete(jobId, {
			success: false,
			message: "insufficient fuel",
			alreadySatisfied: false,
			ticksUsed: 0,
		});
		const record = jm.get(jobId);
		expect(record?.status).toBe("completed");
		expect(record?.outcome).toBe("failed");
	});

	test("a goal that did the thing is outcome succeeded", () => {
		const jm = makeJobManager();
		const { jobId } = jm.create("acct-1", "dock-at", {});
		jm.complete(jobId, {
			success: true,
			message: "docked",
			alreadySatisfied: false,
			ticksUsed: 1,
		});
		expect(jm.get(jobId)?.outcome).toBe("succeeded");
	});

	test("a job cancelled by force-release is outcome aborted, not failed", () => {
		const jm = makeJobManager();
		const { jobId } = jm.create("acct-1", "mine-until-full", {});
		jm.failAllRunning("acct-1");
		const record = jm.get(jobId);
		expect(record?.status).toBe("failed");
		expect(record?.outcome).toBe("aborted");
	});

	test("outcome is absent while a job is still running", () => {
		const jm = makeJobManager();
		const { jobId } = jm.create("acct-1", "mine-until-full", {});
		expect(jm.get(jobId)?.outcome).toBeUndefined();
	});
});
