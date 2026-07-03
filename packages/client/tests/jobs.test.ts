import { afterEach, describe, expect, test } from "bun:test";
import type { JobRecord } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";
import { TimeoutError } from "../src/errors.js";

describe("JobApi", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined; body: unknown }>;

	function parseBody(init: RequestInit | undefined): unknown {
		if (typeof init?.body !== "string") return undefined;
		return JSON.parse(init.body);
	}

	/** Queues a fixed sequence of responses, one per successive fetch call; repeats the last past the end. */
	function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
		fetchCalls = [];
		let call = 0;
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), method: init?.method, body: parseBody(init) });
			const next = responses[Math.min(call, responses.length - 1)];
			call++;
			return Promise.resolve(
				new Response(JSON.stringify(next?.body), {
					status: next?.status ?? 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("get() GETs /jobs/:id and returns the full JobRecord regardless of status", async () => {
		const runningJob: JobRecord = {
			jobId: "job-abc",
			accountId: "Player1",
			submittedAt: new Date().toISOString(),
			status: "running",
		};
		mockFetchSequence([{ status: 200, body: runningJob }]);
		const client = new SetpointClient();

		const result = await client.job("job-abc").get();

		expect(result).toEqual(runningJob);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/jobs/job-abc");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get() encodeURIComponent's the job id", async () => {
		mockFetchSequence([
			{
				status: 200,
				body: {
					jobId: "job abc",
					accountId: "Player1",
					submittedAt: new Date().toISOString(),
					status: "running",
				},
			},
		]);
		const client = new SetpointClient();

		await client.job("job abc").get();

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/jobs/job%20abc");
	});

	test("wait() polls /jobs/:id until a terminal status and returns the full JobRecord", async () => {
		const pendingJob: JobRecord = {
			jobId: "job-abc",
			accountId: "Player1",
			submittedAt: new Date().toISOString(),
			status: "pending",
		};
		const runningJob: JobRecord = { ...pendingJob, status: "running" };
		const completedJob: JobRecord = {
			...pendingJob,
			status: "completed",
			result: { success: true, message: "arrived", alreadySatisfied: false, ticksUsed: 3 },
		};
		mockFetchSequence([
			{ status: 200, body: pendingJob },
			{ status: 200, body: runningJob },
			{ status: 200, body: completedJob },
		]);
		const client = new SetpointClient();

		const result = await client.job("job-abc").wait({ pollMs: 0 });

		expect(result).toEqual(completedJob);
		expect(fetchCalls).toHaveLength(3);
		expect(fetchCalls[2]?.url).toBe("http://127.0.0.1:7580/jobs/job-abc");
		expect(fetchCalls[2]?.method).toBe("GET");
	});

	test("wait() resolves (does not throw) with a failed JobRecord", async () => {
		const failedJob: JobRecord = {
			jobId: "job-xyz",
			accountId: "Player1",
			submittedAt: new Date().toISOString(),
			status: "failed",
			error: "Unknown destination",
		};
		mockFetchSequence([{ status: 200, body: failedJob }]);
		const client = new SetpointClient();

		const result = await client.job("job-xyz").wait({ pollMs: 0 });

		expect(result).toEqual(failedJob);
	});

	test("wait() throws TimeoutError when timeoutMs elapses before a terminal status", async () => {
		const pendingJob: JobRecord = {
			jobId: "job-abc",
			accountId: "Player1",
			submittedAt: new Date().toISOString(),
			status: "pending",
		};
		mockFetchSequence([{ status: 200, body: pendingJob }]);
		const client = new SetpointClient();

		await expect(client.job("job-abc").wait({ pollMs: 0, timeoutMs: 5 })).rejects.toThrow(
			TimeoutError,
		);
	});
});
