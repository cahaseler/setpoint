import { describe, expect, test } from "bun:test";
import { createEventBuffer } from "../../src/state/event-buffer.js";

describe("createEventBuffer", () => {
	test("recent() is empty for a key with no recorded items", () => {
		const buffer = createEventBuffer<string>();
		expect(buffer.recent("p1")).toEqual([]);
	});

	test("record() appends to recent() in order", () => {
		const buffer = createEventBuffer<string>();
		buffer.record("p1", "a");
		buffer.record("p1", "b");
		expect(buffer.recent("p1")).toEqual(["a", "b"]);
	});

	test("items for different keys are isolated", () => {
		const buffer = createEventBuffer<string>();
		buffer.record("p1", "a");
		buffer.record("p2", "b");
		expect(buffer.recent("p1")).toEqual(["a"]);
		expect(buffer.recent("p2")).toEqual(["b"]);
	});

	test("caps retention at maxBuffered per key, dropping the oldest", () => {
		const buffer = createEventBuffer<number>(5);
		for (let i = 0; i < 8; i++) {
			buffer.record("p1", i);
		}
		expect(buffer.recent("p1")).toEqual([3, 4, 5, 6, 7]);
	});

	test("defaults to a cap of 50 when unspecified", () => {
		const buffer = createEventBuffer<number>();
		for (let i = 0; i < 60; i++) {
			buffer.record("p1", i);
		}
		const recent = buffer.recent("p1");
		expect(recent).toHaveLength(50);
		expect(recent[0]).toBe(10);
		expect(recent[49]).toBe(59);
	});

	test("subscribe() delivers items recorded after subscribing, not the backlog", () => {
		const buffer = createEventBuffer<string>();
		buffer.record("p1", "a");

		const received: string[] = [];
		buffer.subscribe("p1", (item) => received.push(item));

		expect(received).toHaveLength(0);
		buffer.record("p1", "b");
		expect(received).toEqual(["b"]);
	});

	test("unsubscribe stops delivery", () => {
		const buffer = createEventBuffer<string>();
		const received: string[] = [];
		const unsubscribe = buffer.subscribe("p1", (item) => received.push(item));

		buffer.record("p1", "a");
		expect(received).toEqual(["a"]);

		unsubscribe();
		buffer.record("p1", "b");
		expect(received).toEqual(["a"]);
	});

	test("a subscriber on one key is not notified by another key's items", () => {
		const buffer = createEventBuffer<string>();
		const received: string[] = [];
		buffer.subscribe("p1", (item) => received.push(item));

		buffer.record("p2", "b");
		expect(received).toHaveLength(0);
	});

	test("record() still buffers the item even if every subscriber throws", () => {
		const buffer = createEventBuffer<string>();
		buffer.subscribe("p1", () => {
			throw new Error("controller already closed");
		});

		expect(() => buffer.record("p1", "a")).not.toThrow();
		expect(buffer.recent("p1")).toEqual(["a"]);
	});

	test("a throwing subscriber does not prevent other subscribers on the same key from receiving the item", () => {
		const buffer = createEventBuffer<string>();
		const received: string[] = [];
		buffer.subscribe("p1", () => {
			throw new Error("controller already closed");
		});
		buffer.subscribe("p1", (item) => received.push(item));

		buffer.record("p1", "a");
		expect(received).toEqual(["a"]);
	});
});
