import { afterEach, describe, expect, test } from "bun:test";
import type { GoalResult, JobRecord } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("AccountApi", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined; body: unknown }>;

	function parseBody(init: RequestInit | undefined): unknown {
		if (typeof init?.body !== "string") return undefined;
		return JSON.parse(init.body);
	}

	/** Queues a fixed sequence of responses, one per successive fetch call. */
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

	const goalResult: GoalResult = {
		success: true,
		message: "arrived",
		alreadySatisfied: false,
		ticksUsed: 3,
	};

	test("goal() POSTs /accounts/:id/goal with {type, options} and returns the GoalResult", async () => {
		mockFetchSequence([{ status: 200, body: goalResult }]);
		const client = new SetpointClient();

		const result = await client
			.account("Player1")
			.goal("navigate-to-system", { targetSystemId: "sol" });

		expect(result).toEqual(goalResult);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/goal");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({
			type: "navigate-to-system",
			options: { targetSystemId: "sol" },
		});
	});

	test("goal() encodeURIComponent's the account id", async () => {
		mockFetchSequence([{ status: 200, body: goalResult }]);
		const client = new SetpointClient();

		await client.account("Player One").goal("ensure-fueled", {});

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player%20One/goal");
	});

	test("goalAsync() POSTs /accounts/:id/goal/async and returns {job_id}", async () => {
		mockFetchSequence([{ status: 202, body: { job_id: "job-abc" } }]);
		const client = new SetpointClient();

		const result = await client
			.account("Player1")
			.goalAsync("navigate-to-system", { targetSystemId: "sol" });

		expect(result).toEqual({ job_id: "job-abc" });
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/goal/async");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({
			type: "navigate-to-system",
			options: { targetSystemId: "sol" },
		});
	});

	test("runToCompletion() submits async then polls /jobs/:id until completed, returning the result", async () => {
		const completedJob: JobRecord = {
			jobId: "job-abc",
			accountId: "Player1",
			submittedAt: new Date().toISOString(),
			status: "completed",
			result: goalResult,
		};
		mockFetchSequence([
			{ status: 202, body: { job_id: "job-abc" } },
			{ status: 200, body: completedJob },
		]);
		const client = new SetpointClient();

		const result = await client
			.account("Player1")
			.runToCompletion("navigate-to-system", { targetSystemId: "sol" }, { pollMs: 0 });

		expect(result).toEqual(goalResult);
		expect(fetchCalls).toHaveLength(2);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/goal/async");
		expect(fetchCalls[1]?.url).toBe("http://127.0.0.1:7580/jobs/job-abc");
		expect(fetchCalls[1]?.method).toBe("GET");
	});

	test("runToCompletion() throws with the job's error when the job fails", async () => {
		const failedJob: JobRecord = {
			jobId: "job-xyz",
			accountId: "Player1",
			submittedAt: new Date().toISOString(),
			status: "failed",
			error: "Unknown destination",
		};
		mockFetchSequence([
			{ status: 202, body: { job_id: "job-xyz" } },
			{ status: 200, body: failedJob },
		]);
		const client = new SetpointClient();

		await expect(
			client
				.account("Player1")
				.runToCompletion("navigate-to-system", { targetSystemId: "sol" }, { pollMs: 0 }),
		).rejects.toThrow("Unknown destination");
	});

	test("abort({force:true}) DELETEs /accounts/:id/abort with body {force:true}", async () => {
		mockFetchSequence([{ status: 200, body: { message: "Account aborted." } }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").abort({ force: true });

		expect(result).toEqual({ message: "Account aborted." });
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/abort");
		expect(fetchCalls[0]?.method).toBe("DELETE");
		expect(fetchCalls[0]?.body).toEqual({ force: true });
	});

	test("abort() with no options sends no body", async () => {
		mockFetchSequence([{ status: 200, body: { message: "Account is idle, nothing to abort." } }]);
		const client = new SetpointClient();

		await client.account("Player1").abort();

		expect(fetchCalls[0]?.body).toBeUndefined();
	});

	test("goal() rejects mistyped options at compile time", async () => {
		mockFetchSequence([{ status: 200, body: goalResult }]);
		const client = new SetpointClient();

		// @ts-expect-error — "wrong" is not a valid option for navigate-to-system
		await client.account("Player1").goal("navigate-to-system", { wrong: 1 });
	});
});
