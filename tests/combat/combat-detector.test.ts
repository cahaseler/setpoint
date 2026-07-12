import { describe, expect, test } from "bun:test";
import type { NotificationPayloads } from "@spacemolt/lib";
import {
	type CombatDetectorEvent,
	type CombatDetectorState,
	INITIAL_COMBAT_STATE,
	UNKNOWN_BATTLE_ID,
	reduceCombatEvent,
	reduceTimeout,
} from "../../src/combat/combat-detector.js";

const SELF = "p1";
const OTHER = "p2";
const NOW = 1_000_000;

function battleParticipants(
	participantIds: string[],
): NotificationPayloads["battle_alert"]["participants"] {
	return participantIds.map((id) => ({ player_id: id, side_id: 1, username: id, zone: "outer" }));
}

function battleAlert(participantIds: string[], battleId = "b1"): CombatDetectorEvent {
	return {
		type: "battle_alert",
		payload: {
			battle_id: battleId,
			message: "",
			system_id: "sol",
			participants: battleParticipants(participantIds),
			sides: [{ side_id: 1, player_count: participantIds.length }],
		},
	};
}

function battleStarted(participantIds: string[], battleId = "b1"): CombatDetectorEvent {
	return {
		type: "battle_started",
		payload: {
			battle_id: battleId,
			system_id: "sol",
			participants: battleParticipants(participantIds),
			sides: [{ side_id: 1, player_count: participantIds.length }],
		},
	};
}

function battleUpdate(battleId = "b1"): CombatDetectorEvent {
	return {
		type: "battle_update",
		payload: {
			auto_pilot: false,
			battle_id: battleId,
			participants: [],
			sides: [],
			tick: 1,
			your_side_id: 1,
			your_stance: "fire",
			your_zone: "outer",
		},
	};
}

function battleJoined(playerId: string): CombatDetectorEvent {
	return {
		type: "battle_joined",
		payload: { player_id: playerId, side_id: 1, username: playerId },
	};
}

function battleDamage(attackerId: string, targetId: string): CombatDetectorEvent {
	return {
		type: "battle_damage",
		payload: {
			attacker_id: attackerId,
			damage_type: "kinetic",
			hit_success: true,
			hull_hit: 1,
			shield_hit: 0,
			target_id: targetId,
			tick: 1,
			total_damage: 1,
			weapons_fired: [],
		},
	};
}

function battleEnded(battleId: string): CombatDetectorEvent {
	return {
		type: "battle_ended",
		payload: {
			battle_id: battleId,
			duration: 10,
			reason: "resolved",
			ships_destroyed: 0,
			total_damage: 0,
			winning_side: 1,
		},
	};
}

function battleLeft(playerId: string): CombatDetectorEvent {
	return {
		type: "battle_left",
		payload: { player_id: playerId, reason: "fled", username: playerId },
	};
}

function playerDied(): CombatDetectorEvent {
	return {
		type: "player_died",
		payload: {
			clone_cost: 100,
			insurance_payout: 0,
			respawn_base: "home_base",
			ship_lost: "frigate",
		},
	};
}

function playerKill(): CombatDetectorEvent {
	return { type: "player_kill", payload: { victim: OTHER } };
}

const inCombat = (battleId = "b1"): CombatDetectorState => ({
	phase: "in-combat",
	activeBattleId: battleId,
	lastActivityAt: NOW,
});

describe("reduceCombatEvent", () => {
	describe("battle_alert / battle_started", () => {
		test("bystander (self not in participants) causes no transition", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleAlert([OTHER]), SELF, NOW);
			expect(result.transition).toBeUndefined();
			expect(result.state.phase).toBe("idle");
		});

		test("self in participants enters combat", () => {
			const result = reduceCombatEvent(
				INITIAL_COMBAT_STATE,
				battleStarted([SELF, OTHER]),
				SELF,
				NOW,
			);
			expect(result.transition).toEqual({ kind: "entered", battleId: "b1" });
			expect(result.state).toEqual({
				phase: "in-combat",
				activeBattleId: "b1",
				lastActivityAt: NOW,
			});
		});

		test("already in-combat: refreshes activity but does not re-fire entered", () => {
			const result = reduceCombatEvent(inCombat(), battleAlert([SELF]), SELF, NOW + 5000);
			expect(result.transition).toBeUndefined();
			expect(result.state.lastActivityAt).toBe(NOW + 5000);
		});
	});

	describe("battle_update", () => {
		test("always self — enters combat on receipt alone", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleUpdate("b2"), SELF, NOW);
			expect(result.transition).toEqual({ kind: "entered", battleId: "b2" });
		});

		test("refreshes/corrects the tracked battleId while already in combat", () => {
			const result = reduceCombatEvent(inCombat("b1"), battleUpdate("b2"), SELF, NOW + 10);
			expect(result.transition).toBeUndefined();
			expect(result.state.activeBattleId).toBe("b2");
		});
	});

	describe("battle_joined", () => {
		test("someone else joining causes no transition", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleJoined(OTHER), SELF, NOW);
			expect(result.transition).toBeUndefined();
		});

		test("self joining with no prior known battleId enters combat with UNKNOWN_BATTLE_ID", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleJoined(SELF), SELF, NOW);
			expect(result.transition).toEqual({ kind: "entered", battleId: UNKNOWN_BATTLE_ID });
			expect(result.state.activeBattleId).toBeUndefined();
		});
	});

	describe("battle_damage", () => {
		test("damage between two other players causes no transition", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleDamage(OTHER, "p3"), SELF, NOW);
			expect(result.transition).toBeUndefined();
		});

		test("self as attacker enters combat", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleDamage(SELF, OTHER), SELF, NOW);
			expect(result.transition?.kind).toBe("entered");
		});

		test("self as target enters combat", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleDamage(OTHER, SELF), SELF, NOW);
			expect(result.transition?.kind).toBe("entered");
		});
	});

	describe("battle_ended", () => {
		test("unrelated battle_id does not clear in-combat state", () => {
			const result = reduceCombatEvent(inCombat("b1"), battleEnded("b2"), SELF, NOW);
			expect(result.transition).toBeUndefined();
			expect(result.state.phase).toBe("in-combat");
		});

		test("matching battle_id clears state and fires exited", () => {
			const result = reduceCombatEvent(inCombat("b1"), battleEnded("b1"), SELF, NOW);
			expect(result.transition).toEqual({ kind: "exited", battleId: "b1", reason: "battle_ended" });
			expect(result.state).toEqual(INITIAL_COMBAT_STATE);
		});

		test("no-op while already idle", () => {
			const result = reduceCombatEvent(INITIAL_COMBAT_STATE, battleEnded("b1"), SELF, NOW);
			expect(result.transition).toBeUndefined();
		});
	});

	describe("battle_left", () => {
		test("someone else leaving causes no transition", () => {
			const result = reduceCombatEvent(inCombat(), battleLeft(OTHER), SELF, NOW);
			expect(result.transition).toBeUndefined();
			expect(result.state.phase).toBe("in-combat");
		});

		test("self leaving clears state and fires exited", () => {
			const result = reduceCombatEvent(inCombat("b1"), battleLeft(SELF), SELF, NOW);
			expect(result.transition).toEqual({ kind: "exited", battleId: "b1", reason: "battle_left" });
			expect(result.state).toEqual(INITIAL_COMBAT_STATE);
		});
	});

	describe("player_died", () => {
		test("always fires died, regardless of prior phase", () => {
			const fromIdle = reduceCombatEvent(INITIAL_COMBAT_STATE, playerDied(), SELF, NOW);
			expect(fromIdle.transition).toEqual({ kind: "died" });
			expect(fromIdle.state).toEqual(INITIAL_COMBAT_STATE);

			const fromCombat = reduceCombatEvent(inCombat(), playerDied(), SELF, NOW);
			expect(fromCombat.transition).toEqual({ kind: "died" });
			expect(fromCombat.state).toEqual(INITIAL_COMBAT_STATE);
		});
	});

	describe("player_kill", () => {
		test("never causes a transition", () => {
			const result = reduceCombatEvent(inCombat(), playerKill(), SELF, NOW);
			expect(result.transition).toBeUndefined();
			expect(result.state.phase).toBe("in-combat");
		});
	});
});

describe("reduceTimeout", () => {
	test("no-op while idle", () => {
		const result = reduceTimeout(INITIAL_COMBAT_STATE, NOW + 1_000_000, 60_000);
		expect(result.transition).toBeUndefined();
	});

	test("no-op while in-combat but under the timeout threshold", () => {
		const result = reduceTimeout(inCombat(), NOW + 59_000, 60_000);
		expect(result.transition).toBeUndefined();
		expect(result.state.phase).toBe("in-combat");
	});

	test("fires a timeout exit once the threshold is exceeded", () => {
		const result = reduceTimeout(inCombat(), NOW + 60_000, 60_000);
		expect(result.transition).toEqual({ kind: "exited", battleId: "b1", reason: "timeout" });
		expect(result.state).toEqual(INITIAL_COMBAT_STATE);
	});
});
