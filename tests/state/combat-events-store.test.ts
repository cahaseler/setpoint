import { describe, expect, test } from "bun:test";
import type { CombatEnvelope } from "@setpoint/protocol";
import { CombatEventsStore } from "../../src/state/combat-events-store.js";

function battleStarted(playerId: string): CombatEnvelope {
	return {
		receivedAt: new Date().toISOString(),
		type: "battle_started",
		payload: {
			battle_id: "b1",
			system_id: "sol",
			participants: [{ player_id: playerId, username: "p1", side_id: "a" }],
			sides: [{ side_id: "a", player_count: 1 }],
		} as CombatEnvelope["payload"],
	} as CombatEnvelope;
}

function interrupted(battleId: string): CombatEnvelope {
	return {
		receivedAt: new Date().toISOString(),
		type: "combat_interrupted",
		payload: { battleId, previousLoopType: "mining" },
	};
}

describe("CombatEventsStore", () => {
	test("recent() is empty for an account with no recorded events", () => {
		const store = new CombatEventsStore();
		expect(store.recent("p1")).toEqual([]);
	});

	test("record() appends to recent() in order", () => {
		const store = new CombatEventsStore();
		store.record("p1", battleStarted("p1"));
		store.record("p1", interrupted("b1"));

		const recent = store.recent("p1");
		expect(recent).toHaveLength(2);
		expect(recent[0]?.type).toBe("battle_started");
		expect(recent[1]?.type).toBe("combat_interrupted");
	});

	test("events for different accounts are isolated", () => {
		const store = new CombatEventsStore();
		store.record("p1", battleStarted("p1"));
		store.record("p2", battleStarted("p2"));

		expect(store.recent("p1")).toHaveLength(1);
		expect(store.recent("p2")).toHaveLength(1);
	});

	test("subscribe() delivers events recorded after subscribing, not the backlog", () => {
		const store = new CombatEventsStore();
		store.record("p1", battleStarted("p1"));

		const received: CombatEnvelope[] = [];
		store.subscribe("p1", (envelope) => received.push(envelope));

		expect(received).toHaveLength(0);
		store.record("p1", interrupted("b1"));
		expect(received).toHaveLength(1);
		expect(received[0]?.type).toBe("combat_interrupted");
	});

	test("unsubscribe stops delivery", () => {
		const store = new CombatEventsStore();
		const received: CombatEnvelope[] = [];
		const unsubscribe = store.subscribe("p1", (envelope) => received.push(envelope));

		store.record("p1", battleStarted("p1"));
		expect(received).toHaveLength(1);

		unsubscribe();
		store.record("p1", interrupted("b1"));
		expect(received).toHaveLength(1);
	});
});
