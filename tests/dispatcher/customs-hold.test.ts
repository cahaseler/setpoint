import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { sendThroughCustoms } from "../../src/dispatcher/customs-hold.js";
import { activeHold, recordHoldUpdate } from "../../src/dispatcher/hold-state.js";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { customsRefusal, holdUpdate } from "./hold-fixtures.js";
import { FakeLibGoalAccount } from "./lib-fakes.js";

describe("sendThroughCustoms", () => {
	test("sends at once when no hold is recorded", async () => {
		const account = new FakeLibGoalAccount({});
		let sends = 0;
		const result = await sendThroughCustoms(makeLibGoalContext(account), "jumping", () => {
			sends++;
			return Promise.resolve("ok");
		});
		expect(result).toBe("ok");
		expect(sends).toBe(1);
	});

	test("a refusal before the hold's start push is waited out, then sent again", async () => {
		const account = new FakeLibGoalAccount({});
		let sends = 0;
		const result = await sendThroughCustoms(
			makeLibGoalContext(account),
			"jumping",
			() => {
				sends++;
				if (sends === 1) {
					setTimeout(() => recordHoldUpdate(account, holdUpdate("ended")), 5);
					return Promise.reject(customsRefusal("jump"));
				}
				return Promise.resolve("ok");
			},
			{ maxWaitMs: 60_000 },
		);
		expect(result).toBe("ok");
		expect(sends).toBe(2);
	});

	test("a recorded hold is waited out before the first send", async () => {
		const account = new FakeLibGoalAccount({});
		recordHoldUpdate(account, holdUpdate("started"));
		setTimeout(() => recordHoldUpdate(account, holdUpdate("ended")), 5);
		const heldAtSend: boolean[] = [];
		await sendThroughCustoms(
			makeLibGoalContext(account),
			"traveling",
			() => {
				heldAtSend.push(activeHold(account) !== undefined);
				return Promise.resolve();
			},
			{ maxWaitMs: 60_000 },
		);
		expect(heldAtSend).toEqual([false]);
	});

	test("a hold whose end push never comes is dropped after the wait, and the send goes ahead", async () => {
		const account = new FakeLibGoalAccount({});
		recordHoldUpdate(account, holdUpdate("started"));
		let sends = 0;
		await sendThroughCustoms(
			makeLibGoalContext(account),
			"docking",
			() => {
				sends++;
				return Promise.resolve();
			},
			{ maxWaitMs: 10 },
		);
		expect(sends).toBe(1);
		expect(activeHold(account)).toBeUndefined();
	});

	test("passes the refusal on after three refused attempts", async () => {
		const account = new FakeLibGoalAccount({});
		let sends = 0;
		await expect(
			sendThroughCustoms(
				makeLibGoalContext(account),
				"jumping",
				() => {
					sends++;
					return Promise.reject(customsRefusal("jump"));
				},
				{ maxWaitMs: 5 },
			),
		).rejects.toThrow("customs inspection");
		expect(sends).toBe(3);
	});

	test("a toll hold's refusal is passed straight on, not waited out", async () => {
		const account = new FakeLibGoalAccount({});
		recordHoldUpdate(account, holdUpdate("started", "toll"));
		let sends = 0;
		await expect(
			sendThroughCustoms(
				makeLibGoalContext(account),
				"jumping",
				() => {
					sends++;
					return Promise.reject(new SpacemoltError("hold_refused", "Raider holds you for a toll."));
				},
				{ maxWaitMs: 60_000 },
			),
		).rejects.toThrow("toll");
		expect(sends).toBe(1);
	});

	test("an unrelated error is passed straight on", async () => {
		const account = new FakeLibGoalAccount({});
		let sends = 0;
		await expect(
			sendThroughCustoms(makeLibGoalContext(account), "jumping", () => {
				sends++;
				return Promise.reject(new SpacemoltError("unknown_destination", "Unknown destination"));
			}),
		).rejects.toThrow("Unknown destination");
		expect(sends).toBe(1);
	});

	test("an abort during the wait ends it", async () => {
		const account = new FakeLibGoalAccount({});
		recordHoldUpdate(account, holdUpdate("started"));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);
		await expect(
			sendThroughCustoms(
				makeLibGoalContext(account, controller.signal),
				"jumping",
				() => Promise.resolve(),
				{ maxWaitMs: 60_000 },
			),
		).rejects.toThrow("aborted");
	});

	test("an abort already signalled before the wait ends it at once", async () => {
		const account = new FakeLibGoalAccount({});
		recordHoldUpdate(account, holdUpdate("started"));
		const controller = new AbortController();
		controller.abort();
		await expect(
			sendThroughCustoms(
				makeLibGoalContext(account, controller.signal),
				"jumping",
				() => Promise.resolve(),
				{ maxWaitMs: 60_000 },
			),
		).rejects.toThrow("aborted");
	});
});
