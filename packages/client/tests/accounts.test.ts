import { afterEach, describe, expect, test } from "bun:test";
import type { AccountDetail, AccountsListResult } from "../src/account.js";
import { SetpointClient } from "../src/client.js";

describe("SetpointClient.accounts", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined; body: unknown }>;

	function parseBody(init: RequestInit | undefined): unknown {
		if (typeof init?.body !== "string") return undefined;
		return JSON.parse(init.body);
	}

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

	test("list() GETs /accounts and returns the account list", async () => {
		const listBody: AccountsListResult = {
			accounts: [
				{
					player_id: "p1",
					username: "Player1",
					status: "connected",
					credits: 5000,
					ship: null,
					location: null,
					loop: null,
				},
			],
		};
		mockFetchSequence([{ status: 200, body: listBody }]);
		const client = new SetpointClient();

		const result = await client.accounts.list();

		expect(result).toEqual(listBody);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get(id) GETs /accounts/:id and returns the account detail", async () => {
		const detail: AccountDetail = {
			player_id: "p1",
			username: "Player1",
			status: "connected",
			state: null,
			loop: null,
			hasRunningJob: false,
			runningJob: null,
			hasExecutingGoal: false,
			executingGoal: null,
			recentJobs: [],
		};
		mockFetchSequence([{ status: 200, body: detail }]);
		const client = new SetpointClient();

		const result = await client.accounts.get("Player1");

		expect(result).toEqual(detail);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get(id) encodeURIComponent's the account id", async () => {
		mockFetchSequence([{ status: 200, body: {} }]);
		const client = new SetpointClient();

		await client.accounts.get("Player One");

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player%20One");
	});

	test("add(username) POSTs /accounts with body {username}", async () => {
		mockFetchSequence([
			{
				status: 202,
				body: {
					username: "Player1",
					status: "connecting",
					message: "Account queued for connection",
				},
			},
		]);
		const client = new SetpointClient();

		const result = await client.accounts.add("Player1");

		expect(result).toEqual({
			username: "Player1",
			status: "connecting",
			message: "Account queued for connection",
		});
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({ username: "Player1" });
	});

	test("register({username, empire}) POSTs /accounts/register with body {username, empire}", async () => {
		mockFetchSequence([
			{
				status: 201,
				body: {
					player_id: "p1",
					username: "Player1",
					password: "generated-password",
					empire: "solarian",
					status: "connected",
					message: "Account registered and connected",
				},
			},
		]);
		const client = new SetpointClient();

		const result = await client.accounts.register({ username: "Player1", empire: "solarian" });

		expect(result).toEqual({
			player_id: "p1",
			username: "Player1",
			password: "generated-password",
			empire: "solarian",
			status: "connected",
			message: "Account registered and connected",
		});
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/register");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({ username: "Player1", empire: "solarian" });
	});

	test("register() rejects an invalid empire at compile time", async () => {
		mockFetchSequence([{ status: 201, body: {} }]);
		const client = new SetpointClient();

		// @ts-expect-error — "klingon" is not a valid Empire
		await client.accounts.register({ username: "Player1", empire: "klingon" });
	});

	test("remove(id) DELETEs /accounts/:id", async () => {
		mockFetchSequence([
			{ status: 200, body: { message: "Account disconnected", player_id: "p1" } },
		]);
		const client = new SetpointClient();

		const result = await client.accounts.remove("Player1");

		expect(result).toEqual({ message: "Account disconnected", player_id: "p1" });
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1");
		expect(fetchCalls[0]?.method).toBe("DELETE");
	});
});
