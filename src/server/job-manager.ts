import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { GoalResult, ProgressRef } from "../dispatcher/goals.js";

export interface JobRecord {
	jobId: string;
	accountId: string;
	goalType?: string;
	goalOptions?: unknown;
	submittedAt: string;
	status: "pending" | "running" | "completed" | "failed";
	completedAt?: string;
	result?: GoalResult;
	error?: string;
}

interface JobRow {
	job_id: string;
	account_id: string;
	goal_type: string | null;
	goal_options: string | null;
	submitted_at: string;
	status: string;
	completed_at: string | null;
	result: string | null;
	error: string | null;
}

function rowToRecord(row: JobRow): JobRecord {
	const record: JobRecord = {
		jobId: row.job_id,
		accountId: row.account_id,
		submittedAt: row.submitted_at,
		status: row.status as JobRecord["status"],
	};
	if (row.goal_type !== null) record.goalType = row.goal_type;
	if (row.goal_options !== null) record.goalOptions = JSON.parse(row.goal_options) as unknown;
	if (row.completed_at !== null) record.completedAt = row.completed_at;
	if (row.result !== null) record.result = JSON.parse(row.result) as GoalResult;
	if (row.error !== null) record.error = row.error;
	return record;
}

/**
 * SQLite-backed store for async goal jobs.
 *
 * Jobs persist across daemon restarts. Running jobs from a previous daemon
 * instance are marked pending (if goal options were stored, so they can be
 * resumed) or failed (if options were not stored).
 */
export class JobManager {
	private readonly db: Database;
	/** Maps jobId → accountId for currently-running jobs. */
	private readonly runningJobs = new Map<string, string>();
	/** In-memory abort controllers and progress refs for running jobs. */
	private readonly jobExecution = new Map<
		string,
		{ controller: AbortController; progress: ProgressRef; promise: Promise<unknown> }
	>();

	constructor(db: Database) {
		this.db = db;
		this.markOrphanedJobs();
	}

	/**
	 * Mark jobs that were still "running" when the daemon last shut down.
	 * Jobs with stored goal_options are marked pending so they can be re-queued.
	 * Jobs without options are marked failed (cannot be resumed).
	 */
	private markOrphanedJobs(): void {
		const now = new Date().toISOString();
		// Can resume: options are stored
		this.db.run(
			`UPDATE jobs SET status = 'pending', completed_at = ?
			 WHERE status = 'running' AND goal_options IS NOT NULL`,
			[now],
		);
		// Cannot resume: no options stored
		this.db.run(
			`UPDATE jobs SET status = 'failed', completed_at = ?, error = ?
			 WHERE status = 'running' AND goal_options IS NULL`,
			[now, "Daemon restarted before job completed"],
		);
	}

	/** Create a new job record in "running" state and return it. */
	create(accountId: string, goalType?: string, goalOptions?: unknown): JobRecord {
		const jobId = randomBytes(8).toString("hex");
		const submittedAt = new Date().toISOString();
		const optionsJson = goalOptions !== undefined ? JSON.stringify(goalOptions) : null;
		this.db.run(
			`INSERT INTO jobs (job_id, account_id, goal_type, goal_options, submitted_at, status)
			 VALUES (?, ?, ?, ?, ?, 'running')`,
			[jobId, accountId, goalType ?? null, optionsJson, submittedAt],
		);
		this.runningJobs.set(jobId, accountId);
		const record: JobRecord = { jobId, accountId, submittedAt, status: "running" };
		if (goalType !== undefined) record.goalType = goalType;
		if (goalOptions !== undefined) record.goalOptions = goalOptions;
		return record;
	}

	/** Look up a job by ID. Returns undefined if not found. */
	get(jobId: string): JobRecord | undefined {
		const row = this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
		return row ? rowToRecord(row) : undefined;
	}

	/** Register abort controller and progress ref for a running job. */
	registerExecution(
		jobId: string,
		controller: AbortController,
		progress: ProgressRef,
		promise: Promise<unknown>,
	): void {
		this.jobExecution.set(jobId, { controller, progress, promise });
	}

	/** Get the execution info (controller, progress) for a running job. */
	getExecution(
		jobId: string,
	): { controller: AbortController; progress: ProgressRef; promise: Promise<unknown> } | undefined {
		return this.jobExecution.get(jobId);
	}

	/** Get the execution info for a running job on a given account. */
	getExecutionForAccount(
		accountId: string,
	): { controller: AbortController; progress: ProgressRef; promise: Promise<unknown> } | undefined {
		for (const [jobId, aid] of this.runningJobs.entries()) {
			if (aid === accountId) return this.jobExecution.get(jobId);
		}
		return undefined;
	}

	/** Mark a job as completed with its result. */
	complete(jobId: string, result: GoalResult): void {
		this.db.run(
			`UPDATE jobs SET status = 'completed', completed_at = ?, result = ?
			 WHERE job_id = ?`,
			[new Date().toISOString(), JSON.stringify(result), jobId],
		);
		this.runningJobs.delete(jobId);
		this.jobExecution.delete(jobId);
	}

	/** Mark a job as failed with an error message. */
	fail(jobId: string, error: string): void {
		this.db.run(
			`UPDATE jobs SET status = 'failed', completed_at = ?, error = ?
			 WHERE job_id = ?`,
			[new Date().toISOString(), error, jobId],
		);
		this.runningJobs.delete(jobId);
		this.jobExecution.delete(jobId);
	}

	/** Mark a pending job as running again so it can be re-executed. */
	requeue(jobId: string): void {
		const job = this.get(jobId);
		this.db.run("UPDATE jobs SET status = 'running', completed_at = NULL WHERE job_id = ?", [
			jobId,
		]);
		if (job) this.runningJobs.set(jobId, job.accountId);
	}

	/** Returns true if there is a running job for the given account. */
	isRunning(accountId: string): boolean {
		for (const aid of this.runningJobs.values()) {
			if (aid === accountId) return true;
		}
		return false;
	}

	/** Get the running job record for an account, if any. */
	getRunningJob(accountId: string): JobRecord | undefined {
		for (const [jobId, aid] of this.runningJobs.entries()) {
			if (aid === accountId) return this.get(jobId);
		}
		return undefined;
	}

	/**
	 * Force-fail all running jobs for the given account.
	 * Returns the number of jobs that were cleared.
	 */
	failAllRunning(accountId: string): number {
		const toFail: string[] = [];
		for (const [jobId, aid] of this.runningJobs) {
			if (aid === accountId) toFail.push(jobId);
		}
		for (const jobId of toFail) {
			this.fail(jobId, "Aborted by user");
		}
		return toFail.length;
	}

	/** Return all pending jobs for the given account (jobs interrupted by a daemon restart). */
	listPendingForAccount(accountId: string): JobRecord[] {
		const rows = this.db
			.query<JobRow, [string]>(
				"SELECT * FROM jobs WHERE account_id = ? AND status = 'pending' ORDER BY submitted_at ASC, rowid ASC",
			)
			.all(accountId);
		return rows.map(rowToRecord);
	}

	/** Return the most recent N jobs for an account, newest first. */
	listByAccount(accountId: string, limit: number): JobRecord[] {
		const rows = this.db
			.query<JobRow, [string, number]>(
				"SELECT * FROM jobs WHERE account_id = ? ORDER BY submitted_at DESC LIMIT ?",
			)
			.all(accountId, limit);
		return rows.map(rowToRecord);
	}
}
