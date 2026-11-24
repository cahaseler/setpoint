import { describe, expect, spyOn, test } from "bun:test";
import { ConnectionClosedError } from "@spacemolt/lib";
import { GameCallGate, ipBlockDurationMs } from "../../src/accounts/game-call-gate.js";

const BLOCK_MESSAGE =
	"Your IP has been temporarily blocked due to excessive rate limit violations. Try again in 120 seconds.";

/** A clock the test advances by hand; `sleep` moves it forward instead of waiting. */
function fakeClock(start = 1_000_000): {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	slept: number[];
} {
	let t = start;
	const slept: number[] = [];
	return {
		now: () => t,
		sleep: (ms) => {
			slept.push(ms);
			t += ms;
			return Promise.resolve();
		},
		slept,
	};
}

/**
 * An account double that sends each call's frame through the gate's
 * `scheduleSend`, as the lib does, and records the frames that went out.
 * `calls` lists the frames sent; a call can be told to fail.
 */
function fakeAccount(
	gate: GameCallGate,
	id: string,
): {
	readonly id: string;
	query: (...args: never[]) => Promise<unknown>;
	mutate: (...args: never[]) => Promise<unknown>;
	sendFrame: (tool: string, action: string, signal?: AbortSignal) => Promise<void>;
	calls: string[];
	failNextWith: Error | null;
} {
	const account = {
		id,
		calls: [] as string[],
		failNextWith: null as Error | null,
		sendFrame(tool: string, action: string, signal = new AbortController().signal): Promise<void> {
			return gate.scheduleSend(
				{ accountId: id, sessionId: "s1", signal, tool, action, requestId: "r1" },
				() => account.calls.push(action),
			);
		},
		async query(..._args: never[]): Promise<unknown> {
			await account.sendFrame("spacemolt", "query");
			const err = account.failNextWith;
			account.failNextWith = null;
			return err ? Promise.reject(err) : "ok";
		},
		async mutate(..._args: never[]): Promise<unknown> {
			await account.sendFrame("spacemolt", "mutate");
			return "ok";
		},
	};
	return account;
}

describe("ipBlockDurationMs", () => {
	test("reads the wait from the game's block notice", () => {
		expect(ipBlockDurationMs(new Error(BLOCK_MESSAGE))).toBe(120_000);
	});

	test("falls back to 120s when the notice states no wait", () => {
		expect(ipBlockDurationMs(new Error("Your IP has been temporarily blocked."))).toBe(120_000);
	});

	test("is undefined for any other error, including an ordinary rate limit", () => {
		expect(ipBlockDurationMs(new Error("rate_limited: slow down"))).toBeUndefined();
		expect(
			ipBlockDurationMs(new Error("No response to spacemolt/get_status within 15000ms")),
		).toBeUndefined();
	});
});

describe("GameCallGate", () => {
	test("passes calls straight through when nothing is in force", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const account = fakeAccount(gate, "Alpha");
		gate.install("p1", account);

		await account.query();
		await account.mutate();

		expect(account.calls).toEqual(["query", "mutate"]);
		expect(clock.slept).toEqual([]);
	});

	test("an IP block holds every account's next call until it lifts, plus a margin", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount(gate, "Alpha");
		const b = fakeAccount(gate, "Bravo");
		gate.install("p1", a);
		gate.install("p2", b);

		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		a.failNextWith = new Error(BLOCK_MESSAGE);
		await expect(a.query()).rejects.toThrow("temporarily blocked");
		warnSpy.mockRestore();

		expect(gate.ipBlockRemainingMs()).toBe(125_000);
		await b.query();
		// The other account's call waited out the block before going out.
		expect(clock.slept).toEqual([125_000]);
		expect(b.calls).toEqual(["query"]);
		expect(gate.ipBlockRemainingMs()).toBe(0);
	});

	test("a repeat block notice during a block does not shorten or re-log it", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

		gate.noteFailure(new Error(BLOCK_MESSAGE));
		gate.noteFailure(new Error(BLOCK_MESSAGE.replace("120", "30")));
		const warnings = warnSpy.mock.calls.length;
		warnSpy.mockRestore();

		expect(gate.ipBlockRemainingMs()).toBe(125_000);
		expect(warnings).toBe(1);
	});

	test("a rate-limited account holds only that account's new calls", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount(gate, "Alpha");
		const b = fakeAccount(gate, "Bravo");
		gate.install("p1", a);
		gate.install("p2", b);

		gate.noteRateLimited("p1", 40_000);
		await b.query();
		expect(clock.slept).toEqual([]);

		await a.query();
		expect(clock.slept).toEqual([40_000]);
	});

	test("the longer of two rate-limit windows wins", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount(gate, "Alpha");
		gate.install("p1", a);

		gate.noteRateLimited("p1", 50_000);
		gate.noteRateLimited("p1", 10_000);
		await a.mutate();

		expect(clock.slept).toEqual([50_000]);
	});

	test("an ordinary failure passes through and leaves no hold", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount(gate, "Alpha");
		gate.install("p1", a);

		a.failNextWith = new Error("not_docked: you must be docked");
		await expect(a.query()).rejects.toThrow("not_docked");
		await a.query();

		expect(gate.ipBlockRemainingMs()).toBe(0);
		expect(clock.slept).toEqual([]);
	});

	test("holds a call while its account is reconnecting, then lets it through", async () => {
		const clock = fakeClock();
		let pollsUntilBack = 3;
		const gate = new GameCallGate(clock);
		const account = {
			...fakeAccount(gate, "Alpha"),
			get authenticated(): boolean {
				return pollsUntilBack-- <= 0;
			},
		};
		gate.install("p1", account);

		const info = spyOn(console, "info").mockImplementation(() => {});
		await account.query();
		info.mockRestore();

		expect(account.calls).toEqual(["query"]);
		expect(clock.slept.length).toBeGreaterThanOrEqual(2);
	});

	test("gives up holding after the reconnect window and sends the call anyway", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate({ ...clock, reconnectHoldMs: 2_000 });
		const account = { ...fakeAccount(gate, "Alpha"), authenticated: false };
		gate.install("p1", account);

		const info = spyOn(console, "info").mockImplementation(() => {});
		await account.query();
		info.mockRestore();

		// Sent (and, against a real closed socket, failed) rather than held for ever.
		expect(account.calls).toEqual(["query"]);
		expect(clock.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2_000);
	});

	test("installing patches the account in place, keeping its identity", () => {
		const gate = new GameCallGate(fakeClock());
		const account = fakeAccount(gate, "Alpha");
		const before = account;
		const originalQuery = account.query;

		gate.install("p1", account);

		expect(account).toBe(before);
		expect(account.query).not.toBe(originalQuery);
	});

	test("an IP block holds the lib's own frames too, such as a retry of a throttled call", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const a = fakeAccount(gate, "Alpha");
		gate.install("p1", a);

		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		gate.noteFailure(new Error(BLOCK_MESSAGE));
		warnSpy.mockRestore();
		// A frame the lib sends by itself, past query/mutate.
		await a.sendFrame("spacemolt", "retry");

		expect(clock.slept).toEqual([125_000]);
		expect(a.calls).toEqual(["retry"]);
	});

	test("an account still authenticating, not yet installed, is held by an IP block only", async () => {
		const clock = fakeClock();
		const gate = new GameCallGate(clock);
		const fresh = fakeAccount(gate, "Newcomer");

		await fresh.sendFrame("spacemolt_auth", "login");
		expect(clock.slept).toEqual([]);

		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		gate.noteFailure(new Error(BLOCK_MESSAGE));
		warnSpy.mockRestore();
		await fresh.sendFrame("spacemolt_auth", "login");
		expect(clock.slept).toEqual([125_000]);
	});

	test("a held frame is dropped, not sent, when the lib aborts its socket", async () => {
		const gate = new GameCallGate({
			now: () => 0,
			// Never wakes: only the abort can end the hold.
			sleep: () => new Promise<void>(() => {}),
		});
		const a = fakeAccount(gate, "Alpha");
		gate.install("p1", a);
		gate.noteRateLimited("p1", 40_000);

		const controller = new AbortController();
		const sent = a.sendFrame("spacemolt", "mutate", controller.signal);
		controller.abort(new Error("socket closed"));

		await expect(sent).rejects.toThrow("socket closed");
		expect(a.calls).toEqual([]);
	});

	describe("connection refusals", () => {
		const refusal = (seconds: number): ConnectionClosedError =>
			new ConnectionClosedError(
				"WebSocket connection closed",
				4003,
				`rate_limited retry_after=${seconds}`,
			);
		const openRequest = (signal = new AbortController().signal) => ({
			accountId: "Alpha",
			sessionId: "s1",
			signal,
		});

		test("opens go straight through when nothing is in force", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate(clock);
			let opened = 0;
			await gate.scheduleOpen(openRequest(), async () => {
				opened++;
			});
			expect(opened).toBe(1);
			expect(clock.slept).toEqual([]);
		});

		test("a 4003 refusal holds every account's next open for its retry_after", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate(clock);
			const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
			gate.noteConnectionClosed(refusal(30));
			warnSpy.mockRestore();

			const start = clock.now();
			let openedAt = 0;
			await gate.scheduleOpen({ ...openRequest(), accountId: "Bravo" }, async () => {
				openedAt = clock.now();
			});
			expect(openedAt - start).toBe(30_000);
		});

		test("a refusal does not hold sends on open connections", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate(clock);
			const a = fakeAccount(gate, "Alpha");
			gate.install("p1", a);
			const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
			gate.noteConnectionClosed(refusal(30));
			warnSpy.mockRestore();
			await a.query();
			expect(clock.slept).toEqual([]);
		});

		test("a later, shorter refusal does not shorten the hold, and only the first is logged", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate(clock);
			const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
			gate.noteConnectionClosed(refusal(30));
			gate.noteConnectionClosed(refusal(5));
			const warnings = warnSpy.mock.calls.length;
			warnSpy.mockRestore();
			expect(warnings).toBe(1);

			const start = clock.now();
			await gate.scheduleOpen(openRequest(), async () => {});
			expect(clock.now() - start).toBe(30_000);
		});

		test("other closes leave no hold", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate(clock);
			gate.noteConnectionClosed(new ConnectionClosedError("gone", 1006, "Connection ended"));
			gate.noteConnectionClosed(new Error("not a close"));
			await gate.scheduleOpen(openRequest(), async () => {});
			expect(clock.slept).toEqual([]);
		});

		test("an IP block holds socket opens too", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate(clock);
			const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
			gate.noteFailure(new Error(BLOCK_MESSAGE));
			warnSpy.mockRestore();
			const start = clock.now();
			await gate.scheduleOpen(openRequest(), async () => {});
			expect(clock.now() - start).toBe(125_000);
		});

		test("opens a hold released go one per spacing, not all at once", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate({ ...clock, heldOpenSpacingMs: 600 });
			const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
			gate.noteConnectionClosed(refusal(1));
			warnSpy.mockRestore();

			// Held, then released first.
			await gate.scheduleOpen(openRequest(), async () => {});
			// Arrives while the release is still draining: waits one spacing.
			await gate.scheduleOpen(openRequest(), async () => {});
			// And the next one waits another.
			await gate.scheduleOpen(openRequest(), async () => {});
			expect(clock.slept).toEqual([1_000, 600, 600]);
		});

		test("with no hold, opens are not spaced by the gate", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate({ ...clock, heldOpenSpacingMs: 600 });
			await gate.scheduleOpen(openRequest(), async () => {});
			await gate.scheduleOpen(openRequest(), async () => {});
			expect(clock.slept).toEqual([]);
		});

		test("a held open is abandoned, not attempted, when the lib aborts it", async () => {
			const gate = new GameCallGate({ now: () => 0, sleep: () => new Promise<void>(() => {}) });
			const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
			gate.noteConnectionClosed(refusal(30));
			warnSpy.mockRestore();
			const controller = new AbortController();
			let opened = false;
			const pending = gate.scheduleOpen(openRequest(controller.signal), async () => {
				opened = true;
			});
			controller.abort(new Error("attempt abandoned"));
			await expect(pending).rejects.toThrow("attempt abandoned");
			expect(opened).toBe(false);
		});
	});

	describe("opens awaiting the game's answer", () => {
		const request = (signal = new AbortController().signal) => ({
			accountId: "Alpha",
			sessionId: "s1",
			signal,
		});
		/** An open the test answers by hand. */
		const pendingOpen = (): {
			open: () => Promise<void>;
			answer: () => void;
			started: () => boolean;
		} => {
			let answer: () => void = () => {};
			let started = false;
			return {
				open: () => {
					started = true;
					return new Promise<void>((resolve) => {
						answer = resolve;
					});
				},
				answer: () => answer(),
				started: () => started,
			};
		};
		/** Timers the test fires by hand. */
		const manualTimers = (): {
			setTimer: (ms: number, fire: () => void) => () => void;
			fireAll: () => void;
			live: () => number;
		} => {
			const timers = new Set<() => void>();
			return {
				setTimer: (_ms, fire) => {
					timers.add(fire);
					return () => timers.delete(fire);
				},
				fireAll: () => {
					for (const fire of [...timers]) {
						timers.delete(fire);
						fire();
					}
				},
				live: () => timers.size,
			};
		};
		const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

		test("further opens wait until one of two unanswered opens is answered, then go spaced", async () => {
			const clock = fakeClock();
			const timers = manualTimers();
			const gate = new GameCallGate({ ...clock, setTimer: timers.setTimer });
			const opens = [pendingOpen(), pendingOpen(), pendingOpen(), pendingOpen()];
			const [a, b, c, d] = opens as [
				ReturnType<typeof pendingOpen>,
				ReturnType<typeof pendingOpen>,
				ReturnType<typeof pendingOpen>,
				ReturnType<typeof pendingOpen>,
			];

			const done = opens.map((o) => gate.scheduleOpen(request(), o.open));
			await settle();
			expect(opens.map((o) => o.started())).toEqual([true, true, false, false]);

			a.answer();
			b.answer();
			await settle();
			expect([c.started(), d.started()]).toEqual([true, true]);
			// The first released goes at once, the next one connect spacing later.
			expect(clock.slept).toEqual([600]);

			c.answer();
			d.answer();
			await Promise.all(done);
			expect(timers.live()).toBe(0);
		});

		test("an open left unanswered gives up its place after the stall time, logged once", async () => {
			const clock = fakeClock();
			const timers = manualTimers();
			const gate = new GameCallGate({ ...clock, setTimer: timers.setTimer });
			const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
			const [a, b, c] = [pendingOpen(), pendingOpen(), pendingOpen()];

			void gate.scheduleOpen(request(), a.open);
			void gate.scheduleOpen(request(), b.open);
			void gate.scheduleOpen(request(), c.open);
			await settle();
			expect(c.started()).toBe(false);

			timers.fireAll();
			await settle();
			const warnings = warnSpy.mock.calls.length;
			warnSpy.mockRestore();
			expect(c.started()).toBe(true);
			expect(warnings).toBe(1);
		});

		test("an open aborted while waiting for a place rejects and takes none", async () => {
			const gate = new GameCallGate({ ...fakeClock(), setTimer: manualTimers().setTimer });
			const [a, b] = [pendingOpen(), pendingOpen()];
			void gate.scheduleOpen(request(), a.open);
			void gate.scheduleOpen(request(), b.open);
			await settle();

			const controller = new AbortController();
			let opened = false;
			const waiting = gate.scheduleOpen(request(controller.signal), async () => {
				opened = true;
			});
			controller.abort(new Error("abandoned"));
			await expect(waiting).rejects.toThrow("abandoned");

			a.answer();
			const next = pendingOpen();
			void gate.scheduleOpen(request(), next.open);
			await settle();
			expect(opened).toBe(false);
			expect(next.started()).toBe(true);
		});
	});

	describe("holding mutations after a handover", () => {
		/** An account whose state and live re-reads report a queued action for the first `pendingReads` reads. */
		function drainable(
			gate: GameCallGate,
			pendingReads: number,
		): ReturnType<typeof fakeAccount> & {
			state: { queue: { has_pending: boolean } };
			refresh: () => Promise<{ queue: { has_pending: boolean } }>;
			reads: number;
		} {
			const account = {
				...fakeAccount(gate, "Alpha"),
				reads: 0,
				state: { queue: { has_pending: pendingReads > 0 } },
				refresh: () => {
					account.reads++;
					account.state = { queue: { has_pending: account.reads < pendingReads } };
					return Promise.resolve(account.state);
				},
			};
			return account;
		}

		test("holds mutations until the handover re-read, then releases a clear account", async () => {
			const gate = new GameCallGate(fakeClock());
			const account = drainable(gate, 0);
			gate.install("p1", account);
			let reread = (): void => {};
			gate.holdAfterHandover(
				"p1",
				account,
				new Promise<void>((resolve) => {
					reread = resolve;
				}),
			);

			const sent = account.mutate();
			await Promise.resolve();
			expect(account.calls).toEqual([]);
			expect(gate.isHeldAfterHandover("p1")).toBe(true);

			reread();
			await sent;
			expect(account.calls).toEqual(["mutate"]);
			expect(account.reads).toBe(0);
			expect(gate.isHeldAfterHandover("p1")).toBe(false);
		});

		test("an account the re-read finds with a queued action stays held until a re-read shows it clear", async () => {
			const gate = new GameCallGate(fakeClock());
			const account = drainable(gate, 3);
			gate.install("p1", account);

			const info = spyOn(console, "info").mockImplementation(() => {});
			gate.holdAfterHandover("p1", account, Promise.resolve());
			await account.mutate();
			info.mockRestore();

			expect(account.reads).toBe(3);
			expect(account.calls).toEqual(["mutate"]);
		});

		test("does not hold queries", async () => {
			const gate = new GameCallGate(fakeClock());
			const account = drainable(gate, 0);
			gate.install("p1", account);
			gate.holdAfterHandover("p1", account, new Promise<void>(() => {}));

			await account.query();

			expect(account.calls).toEqual(["query"]);
			expect(gate.isHeldAfterHandover("p1")).toBe(true);
		});

		test("releases the account after the cap even if the action never clears", async () => {
			const clock = fakeClock();
			const gate = new GameCallGate({ ...clock, inheritedActionMaxWaitMs: 6_000 });
			const account = drainable(gate, Number.POSITIVE_INFINITY);
			gate.install("p1", account);

			const info = spyOn(console, "info").mockImplementation(() => {});
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			gate.holdAfterHandover("p1", account, Promise.resolve());
			await account.mutate();
			const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
			info.mockRestore();
			warn.mockRestore();

			expect(account.calls).toEqual(["mutate"]);
			expect(warnings).toContain("still pending after 6s");
		});

		test("a failed re-read while draining is logged and polling continues", async () => {
			const gate = new GameCallGate(fakeClock());
			let reads = 0;
			const account = {
				...fakeAccount(gate, "Alpha"),
				state: { queue: { has_pending: true } },
				refresh: () => {
					reads++;
					return reads === 1
						? Promise.reject(new Error("query timed out"))
						: Promise.resolve({ queue: { has_pending: false } });
				},
			};
			gate.install("p1", account);

			const info = spyOn(console, "info").mockImplementation(() => {});
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			gate.holdAfterHandover("p1", account, Promise.resolve());
			await account.mutate();
			const warnings = warn.mock.calls.map((c) => String(c[0])).join("\n");
			info.mockRestore();
			warn.mockRestore();

			expect(reads).toBe(2);
			expect(warnings).toContain("query timed out");
		});

		test("holding an account already held keeps the first hold", async () => {
			const gate = new GameCallGate(fakeClock());
			const account = drainable(gate, 0);
			gate.install("p1", account);
			let reread = (): void => {};
			gate.holdAfterHandover(
				"p1",
				account,
				new Promise<void>((resolve) => {
					reread = resolve;
				}),
			);
			gate.holdAfterHandover("p1", account, Promise.resolve());

			await Promise.resolve();
			expect(gate.isHeldAfterHandover("p1")).toBe(true);
			reread();
			await account.mutate();
			expect(gate.isHeldAfterHandover("p1")).toBe(false);
		});
	});
});
