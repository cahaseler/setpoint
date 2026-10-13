import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { JobManager } from "../../src/server/job-manager.js";
import { JOB_RETENTION_MS, pruneFinishedJobs } from "../../src/server/job-pruner.js";
import { createMemoryDatabase } from "../../src/state/database.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Insert a job row directly, so its age and status can be set exactly. */
function insertJob(db: Database, jobId: string, status: string, ageMs: number): void {
	db.run("INSERT INTO jobs (job_id, account_id, submitted_at, status) VALUES (?, 'acct', ?, ?)", [
		jobId,
		new Date(NOW.getTime() - ageMs).toISOString(),
		status,
	]);
}

function remainingIds(db: Database): string[] {
	return db
		.query<{ job_id: string }, []>("SELECT job_id FROM jobs ORDER BY job_id")
		.all()
		.map((r) => r.job_id);
}

describe("pruneFinishedJobs", () => {
	test("deletes finished jobs past retention and keeps recent ones", async () => {
		const db = createMemoryDatabase();
		const jobs = new JobManager(db);
		insertJob(db, "old-completed", "completed", 10 * DAY);
		insertJob(db, "old-failed", "failed", 8 * DAY);
		insertJob(db, "new-completed", "completed", 2 * DAY);

		const deleted = await pruneFinishedJobs(jobs, { now: () => NOW });

		expect(deleted).toBe(2);
		expect(remainingIds(db)).toEqual(["new-completed"]);
	});

	test("never deletes a pending or running job, however old", async () => {
		// A resumable job can sit pending across a long outage; deleting it would
		// lose work a caller is still waiting on.
		const db = createMemoryDatabase();
		const jobs = new JobManager(db);
		insertJob(db, "old-pending", "pending", 30 * DAY);
		insertJob(db, "old-running", "running", 30 * DAY);

		const deleted = await pruneFinishedJobs(jobs, { now: () => NOW });

		expect(deleted).toBe(0);
		expect(remainingIds(db)).toEqual(["old-pending", "old-running"]);
	});

	test("keeps a job just inside the retention window", async () => {
		const db = createMemoryDatabase();
		const jobs = new JobManager(db);
		insertJob(db, "edge", "completed", JOB_RETENTION_MS - 60_000);

		expect(await pruneFinishedJobs(jobs, { now: () => NOW })).toBe(0);
	});

	test("clears a backlog in bounded batches, yielding between them", async () => {
		const db = createMemoryDatabase();
		const jobs = new JobManager(db);
		for (let i = 0; i < 25; i++)
			insertJob(db, `j${String(i).padStart(2, "0")}`, "completed", 9 * DAY);
		let yields = 0;

		const deleted = await pruneFinishedJobs(jobs, {
			now: () => NOW,
			batchSize: 10,
			yieldBetweenBatches: () => {
				yields++;
				return Promise.resolve();
			},
		});

		expect(deleted).toBe(25);
		expect(remainingIds(db)).toEqual([]);
		// Batches of 10, 10, 5: a yield after each full batch, none after the last.
		expect(yields).toBe(2);
	});
});

describe("job indexes", () => {
	test("the startup orphan sweep reads an index, not the whole table", () => {
		const db = createMemoryDatabase();
		const plan = db
			.query<{ detail: string }, []>(
				"EXPLAIN QUERY PLAN UPDATE jobs SET status = 'failed' WHERE status = 'running'",
			)
			.all()
			.map((r) => r.detail)
			.join(" ");
		expect(plan).toContain("idx_jobs_status_submitted");
	});
	test("the prune reads its age cutoff from the index, without sorting", () => {
		const db = createMemoryDatabase();
		const plan = db
			.query<{ detail: string }, [string]>(
				`EXPLAIN QUERY PLAN SELECT rowid FROM jobs
				 WHERE status IN ('completed', 'failed') AND submitted_at < ? LIMIT 1000`,
			)
			.all("2026-10-01")
			.map((r) => r.detail)
			.join(" ");
		expect(plan).toContain("idx_jobs_status_submitted (status=? AND submitted_at<?)");
		expect(plan).not.toContain("TEMP B-TREE");
	});
});
