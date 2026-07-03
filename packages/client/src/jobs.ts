/** Shared async-job polling for `@setpoint/client` (goals and, later, direct job lookups). */

import type { GoalResult, JobRecord } from "@setpoint/protocol";
import type { SetpointClient } from "./client.js";

const DEFAULT_POLL_MS = 2000;

export interface WaitForJobOptions {
	/** Delay between polls, in milliseconds. Defaults to 2000. */
	pollMs?: number;
}

/**
 * Polls `GET /jobs/:jobId` until the job reaches a terminal status.
 *
 * Resolves with the job's `result` on `completed`, and throws (with the
 * job's `error` message) on `failed`. Kept standalone so both the
 * account-scoped `runToCompletion` and a future direct `job(id).wait()`
 * accessor can share the same polling logic.
 */
export async function waitForJob(
	client: SetpointClient,
	jobId: string,
	opts?: WaitForJobOptions,
): Promise<GoalResult> {
	const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;

	for (;;) {
		const job = (await client.request("GET", `/jobs/${encodeURIComponent(jobId)}`)) as JobRecord;

		if (job.status === "completed") {
			return job.result as GoalResult;
		}
		if (job.status === "failed") {
			throw new Error(job.error ?? `Job ${jobId} failed`);
		}

		await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
	}
}
