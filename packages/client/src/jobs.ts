/** Shared async-job polling for `@setpoint/client` (goals and direct job lookups). */

import type { JobRecord } from "@setpoint/protocol";
import type { SetpointClient } from "./client.js";
import { TimeoutError } from "./errors.js";

const DEFAULT_POLL_MS = 2000;

export interface WaitForJobOptions {
	/** Delay between polls, in milliseconds. Defaults to 2000. */
	pollMs?: number;
	/** Overall wall-clock budget, in milliseconds. Throws `TimeoutError` if exceeded before a terminal status is reached. Unset means wait forever. */
	timeoutMs?: number;
}

/**
 * Polls `GET /jobs/:jobId` until the job reaches a terminal status
 * (`completed` or `failed`), returning the full `JobRecord`.
 *
 * Does NOT throw on `failed` — callers that want "throw on failure"
 * semantics (e.g. `AccountApi.runToCompletion`) inspect `.status` and
 * `.error` themselves. Kept standalone so both `runToCompletion` and the
 * direct `job(id).wait()` accessor share the same polling logic.
 */
export async function waitForJob(
	client: SetpointClient,
	jobId: string,
	opts?: WaitForJobOptions,
): Promise<JobRecord> {
	const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
	const timeoutMs = opts?.timeoutMs;
	const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

	for (;;) {
		const job = (await client.request("GET", `/jobs/${encodeURIComponent(jobId)}`)) as JobRecord;

		if (job.status === "completed" || job.status === "failed") {
			return job;
		}

		if (deadline !== undefined && Date.now() >= deadline) {
			throw new TimeoutError(client.baseUrl, timeoutMs ?? 0, `/jobs/${jobId}`);
		}

		await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
	}
}

/** Direct job lookup/wait API (`sp.job(jobId)`), for jobs submitted outside `runToCompletion`. */
export class JobApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly jobId: string,
	) {}

	/** Gets the job's current record, whatever its status. */
	async get(): Promise<JobRecord> {
		const result = await this.client.request("GET", `/jobs/${encodeURIComponent(this.jobId)}`);
		return result as JobRecord;
	}

	/** Polls until the job reaches a terminal status, returning the full `JobRecord`. */
	async wait(opts?: WaitForJobOptions): Promise<JobRecord> {
		return waitForJob(this.client, this.jobId, opts);
	}
}
