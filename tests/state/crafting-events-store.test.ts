import { describe, expect, test } from "bun:test";
import type { CraftingUpdateEvent } from "@setpoint/protocol";
import { CraftingEventsStore } from "../../src/state/crafting-events-store.js";

function makeEvent(jobId: string, runsDone: number): CraftingUpdateEvent {
	return {
		tick: 100 + runsDone,
		jobs: [
			{
				job_id: jobId,
				completed: false,
				deposited: [],
				mode: "craft",
				recipe: "widget",
				runs_done: runsDone,
				runs_remaining: 5 - runsDone,
				storage: "personal",
				venue: "workshop",
			},
		],
	};
}

describe("CraftingEventsStore", () => {
	test("recent() is empty for an account with no recorded events", () => {
		const store = new CraftingEventsStore();
		expect(store.recent("p1")).toEqual([]);
	});

	test("record() appends to recent() in order, timestamped on receipt", () => {
		const store = new CraftingEventsStore();
		store.record("p1", makeEvent("job-1", 1));
		store.record("p1", makeEvent("job-1", 2));

		const recent = store.recent("p1");
		expect(recent).toHaveLength(2);
		expect(recent[0]?.event.jobs[0]?.runs_done).toBe(1);
		expect(recent[1]?.event.jobs[0]?.runs_done).toBe(2);
		expect(typeof recent[0]?.receivedAt).toBe("string");
		expect(() => new Date(recent[0]?.receivedAt as string)).not.toThrow();
	});

	test("events for different accounts are isolated", () => {
		const store = new CraftingEventsStore();
		store.record("p1", makeEvent("job-1", 1));
		store.record("p2", makeEvent("job-2", 1));

		expect(store.recent("p1")).toHaveLength(1);
		expect(store.recent("p2")).toHaveLength(1);
		expect(store.recent("p1")[0]?.event.jobs[0]?.job_id).toBe("job-1");
	});

	test("caps retention at 50 events per account, dropping the oldest", () => {
		const store = new CraftingEventsStore();
		for (let i = 0; i < 60; i++) {
			store.record("p1", makeEvent("job-1", i));
		}

		const recent = store.recent("p1");
		expect(recent).toHaveLength(50);
		// oldest 10 (runs_done 0..9) dropped — first retained is runs_done 10
		expect(recent[0]?.event.jobs[0]?.runs_done).toBe(10);
		expect(recent[49]?.event.jobs[0]?.runs_done).toBe(59);
	});

	test("subscribe() delivers events recorded after subscribing, not the backlog", () => {
		const store = new CraftingEventsStore();
		store.record("p1", makeEvent("job-1", 1));

		const received: CraftingUpdateEvent[] = [];
		store.subscribe("p1", (envelope) => received.push(envelope.event));

		expect(received).toHaveLength(0);
		store.record("p1", makeEvent("job-1", 2));
		expect(received).toHaveLength(1);
		expect(received[0]?.jobs[0]?.runs_done).toBe(2);
	});

	test("unsubscribe stops delivery", () => {
		const store = new CraftingEventsStore();
		const received: CraftingUpdateEvent[] = [];
		const unsubscribe = store.subscribe("p1", (envelope) => received.push(envelope.event));

		store.record("p1", makeEvent("job-1", 1));
		expect(received).toHaveLength(1);

		unsubscribe();
		store.record("p1", makeEvent("job-1", 2));
		expect(received).toHaveLength(1);
	});

	test("a subscriber on one account is not notified by another account's events", () => {
		const store = new CraftingEventsStore();
		const received: CraftingUpdateEvent[] = [];
		store.subscribe("p1", (envelope) => received.push(envelope.event));

		store.record("p2", makeEvent("job-2", 1));
		expect(received).toHaveLength(0);
	});
});
