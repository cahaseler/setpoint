import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Lifecycle } from "../../src/lifecycle/lifecycle.js";

describe("Lifecycle", () => {
	const originalWarn = console.warn;
	let lines: string[];
	beforeEach(() => {
		lines = [];
		console.warn = mock((...args: unknown[]) => {
			lines.push(String(args[0]));
		});
	});
	afterEach(() => {
		console.warn = originalWarn;
	});

	test("a restart notice is logged under [setpoint-lifecycle] and reported in status", () => {
		const lifecycle = new Lifecycle("abc123", () => new Date("2026-11-13T12:00:00Z"));
		lifecycle.announceRestart(120, "deploying the hazard response");

		expect(lines[0]).toContain("[setpoint-lifecycle] RESTART PENDING");
		expect(lines[0]).toContain("2026-11-13T12:02:00.000Z");
		expect(lines[0]).toContain("deploying the hazard response");
		expect(lifecycle.status().restartPending).toEqual({
			at: "2026-11-13T12:02:00.000Z",
			reason: "deploying the hazard response",
		});
	});

	test("READY clears a pending restart and names the release", () => {
		const lifecycle = new Lifecycle("abc123");
		lifecycle.announceRestart(60, "deploy");
		lifecycle.enterActive(290);

		expect(lifecycle.phase).toBe("active");
		expect(lifecycle.status().restartPending).toBeUndefined();
		expect(lines.at(-1)).toContain("READY");
		expect(lines.at(-1)).toContain("release abc123");
		expect(lines.at(-1)).toContain("290 account(s)");
	});

	test("only a draining process refuses requests, and only mutating ones", () => {
		const lifecycle = new Lifecycle();
		lifecycle.enterActive(1);
		lifecycle.onHandoverRequested(() => {});
		expect(lifecycle.refusesRequest("POST", "/accounts/p1/loop")).toBe(false);

		lifecycle.requestHandover();

		expect(lifecycle.refusesRequest("POST", "/accounts/p1/loop")).toBe(true);
		expect(lifecycle.refusesRequest("DELETE", "/accounts/p1/loop")).toBe(true);
		expect(lifecycle.refusesRequest("GET", "/accounts/p1/state")).toBe(false);
		expect(lifecycle.refusesRequest("POST", "/lifecycle/handover")).toBe(false);
	});

	test("a handover request is accepted once, only from an active process, and runs the listener", async () => {
		const lifecycle = new Lifecycle();
		let handedOver = 0;
		lifecycle.onHandoverRequested(() => {
			handedOver++;
		});

		expect(lifecycle.requestHandover()).toBe(false); // still starting

		lifecycle.enterActive(1);
		expect(lifecycle.requestHandover()).toBe(true);
		expect(lifecycle.requestHandover()).toBe(false); // already draining
		await Promise.resolve();

		expect(handedOver).toBe(1);
		expect(lines.some((l) => l.includes("HANDOVER CUTOVER"))).toBe(true);
	});

	test("STOPPING is not logged for a process that is handing over", () => {
		const lifecycle = new Lifecycle();
		lifecycle.enterActive(1);
		lifecycle.onHandoverRequested(() => {});
		lifecycle.requestHandover();
		lifecycle.enterStopping();

		expect(lines.some((l) => l.includes("STOPPING"))).toBe(false);
		expect(lifecycle.phase).toBe("draining");
	});
});
