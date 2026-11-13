import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { bindWithRetry, findIncumbent, takeOverFrom } from "../../src/lifecycle/handover.js";

/** A fetch double that answers by path, recording each call. */
function fakeFetch(handler: (path: string, method: string) => Response | Error): {
	fetchImpl: typeof fetch;
	calls: string[];
} {
	const calls: string[] = [];
	const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
		const path = new URL(input.toString()).pathname;
		const method = init?.method ?? "GET";
		calls.push(`${method} ${path}`);
		const result = handler(path, method);
		return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

const refused = (): Error => new TypeError("Unable to connect");

describe("findIncumbent", () => {
	test("finds a setpoint answering on the port, with its pid", async () => {
		const { fetchImpl } = fakeFetch(() =>
			Response.json({ status: "ok", lifecycle: { pid: 4242 } }),
		);
		expect(await findIncumbent(7580, fetchImpl)).toEqual({ pid: 4242 });
	});

	test("finds a setpoint too old to report its pid", async () => {
		const { fetchImpl } = fakeFetch(() => Response.json({ status: "ok" }));
		expect(await findIncumbent(7580, fetchImpl)).toEqual({ pid: undefined });
	});

	test("finds nothing when the port does not answer", async () => {
		const { fetchImpl } = fakeFetch(() => refused());
		expect(await findIncumbent(7580, fetchImpl)).toBeUndefined();
	});
});

describe("takeOverFrom", () => {
	const originalWarn = console.warn;
	const originalInfo = console.info;
	beforeEach(() => {
		console.warn = mock(() => {});
		console.info = mock(() => {});
	});
	afterEach(() => {
		console.warn = originalWarn;
		console.info = originalInfo;
	});

	test("asks the incumbent to hand over, then waits until it has exited and released the port", async () => {
		let healthChecks = 0;
		const { fetchImpl, calls } = fakeFetch((path, method) => {
			if (method === "POST" && path === "/lifecycle/handover")
				return Response.json({ pid: 4242 }, { status: 202 });
			healthChecks++;
			return healthChecks < 3
				? Response.json({ status: "ok", lifecycle: { pid: 4242 } })
				: refused();
		});
		let aliveChecks = 0;

		await takeOverFrom(
			7580,
			{ pid: 4242 },
			{
				fetchImpl,
				sleep: () => Promise.resolve(),
				// Still running for one check after the port goes quiet.
				isAlive: () => ++aliveChecks < 4,
			},
		);

		expect(calls[0]).toBe("POST /lifecycle/handover");
		expect(calls.filter((c) => c === "POST /lifecycle/handover")).toHaveLength(1);
		expect(aliveChecks).toBeGreaterThanOrEqual(3);
	});

	test("an incumbent that predates handover is waited out until it is stopped by hand", async () => {
		let healthChecks = 0;
		const { fetchImpl } = fakeFetch((_path, method) => {
			if (method === "POST") return new Response("Not Found", { status: 404 });
			healthChecks++;
			return healthChecks < 5 ? Response.json({ status: "ok" }) : refused();
		});
		const warn = mock((..._args: unknown[]) => {});
		console.warn = warn;

		await takeOverFrom(7580, { pid: undefined }, { fetchImpl, sleep: () => Promise.resolve() });

		expect(healthChecks).toBe(5);
		// Told once how to proceed, not on every poll.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("kill -TERM");
	});

	test("an incumbent not ready to hand over is asked again", async () => {
		let asks = 0;
		const { fetchImpl } = fakeFetch((_path, method) => {
			if (method === "POST") {
				asks++;
				return asks < 3
					? Response.json({ error: "starting" }, { status: 409 })
					: Response.json({ pid: 1 }, { status: 202 });
			}
			return refused();
		});

		await takeOverFrom(
			7580,
			{ pid: 1 },
			{ fetchImpl, sleep: () => Promise.resolve(), isAlive: () => false },
		);

		expect(asks).toBe(3);
	});
});

describe("bindWithRetry", () => {
	test("retries while the port is still held, then binds", async () => {
		let attempts = 0;
		const result = await bindWithRetry(
			() => {
				attempts++;
				if (attempts < 3)
					throw new Error("Failed to start server. Is port 7580 in use? EADDRINUSE");
				return "bound";
			},
			{ sleep: () => Promise.resolve() },
		);

		expect(result).toBe("bound");
		expect(attempts).toBe(3);
	});

	test("does not retry an unrelated error", async () => {
		let attempts = 0;
		await expect(
			bindWithRetry(
				() => {
					attempts++;
					throw new Error("permission denied");
				},
				{ sleep: () => Promise.resolve() },
			),
		).rejects.toThrow("permission denied");
		expect(attempts).toBe(1);
	});
});
