/**
 * Pure per-account combat detection state machine. No I/O, no timers — the
 * stateful `CombatReactor` (`combat-reactor.ts`) owns a `CombatDetectorState`
 * per account, feeds every combat-relevant notification through
 * `reduceCombatEvent`, and calls `reduceTimeout` on its own interval.
 *
 * Self-identification is deliberately conservative: a transition into
 * combat only fires when a notification positively identifies the account
 * as a participant, never merely because a battle notification was
 * received (several of these types — `battle_alert`/`battle_started` in
 * particular — can be broadcast to bystanders in the same system who are
 * not actually in the fight).
 */

import type { NotificationPayloads } from "@spacemolt/lib";

export type CombatDetectorEvent =
	| { type: "battle_alert"; payload: NotificationPayloads["battle_alert"] }
	| { type: "battle_started"; payload: NotificationPayloads["battle_started"] }
	| { type: "battle_joined"; payload: NotificationPayloads["battle_joined"] }
	| { type: "battle_update"; payload: NotificationPayloads["battle_update"] }
	| { type: "battle_damage"; payload: NotificationPayloads["battle_damage"] }
	| { type: "battle_ended"; payload: NotificationPayloads["battle_ended"] }
	| { type: "battle_left"; payload: NotificationPayloads["battle_left"] }
	| { type: "player_died"; payload: NotificationPayloads["player_died"] }
	| { type: "player_kill"; payload: NotificationPayloads["player_kill"] };

export type CombatPhase = "idle" | "in-combat";

export interface CombatDetectorState {
	phase: CombatPhase;
	activeBattleId: string | undefined;
	/** Wall-clock ms of the last combat-relevant activity for this account, used by the timeout fallback. */
	lastActivityAt: number;
}

export const INITIAL_COMBAT_STATE: CombatDetectorState = {
	phase: "idle",
	activeBattleId: undefined,
	lastActivityAt: 0,
};

/** Placeholder used when a transition needs a battleId but the detector never learned the real one. */
export const UNKNOWN_BATTLE_ID = "unknown";

export type CombatTransition =
	| { kind: "entered"; battleId: string }
	| { kind: "exited"; battleId: string; reason: "battle_ended" | "battle_left" | "timeout" }
	| { kind: "died" };

export interface CombatReducerResult {
	state: CombatDetectorState;
	transition?: CombatTransition;
}

function enter(
	state: CombatDetectorState,
	battleId: string | undefined,
	now: number,
): CombatReducerResult {
	const wasIdle = state.phase === "idle";
	const nextState: CombatDetectorState = {
		phase: "in-combat",
		activeBattleId: battleId ?? state.activeBattleId,
		lastActivityAt: now,
	};
	if (!wasIdle) {
		return { state: nextState };
	}
	return {
		state: nextState,
		transition: { kind: "entered", battleId: nextState.activeBattleId ?? UNKNOWN_BATTLE_ID },
	};
}

function exit(
	battleId: string | undefined,
	reason: "battle_ended" | "battle_left" | "timeout",
): CombatReducerResult {
	return {
		state: { ...INITIAL_COMBAT_STATE },
		transition: { kind: "exited", battleId: battleId ?? UNKNOWN_BATTLE_ID, reason },
	};
}

/**
 * Applies one combat-relevant notification to the current state. Returns
 * the next state and, if this event caused a phase change, the
 * transition that fired.
 */
export function reduceCombatEvent(
	state: CombatDetectorState,
	event: CombatDetectorEvent,
	selfId: string,
	now: number,
): CombatReducerResult {
	switch (event.type) {
		case "battle_alert":
		case "battle_started": {
			const isSelf = event.payload.participants.some((p) => p.player_id === selfId);
			if (!isSelf) return { state };
			return enter(state, event.payload.battle_id, now);
		}
		case "battle_update": {
			// The server only ever sends this to actual participants — receiving
			// one at all, regardless of prior state, means self is in combat.
			return enter(state, event.payload.battle_id, now);
		}
		case "battle_joined": {
			if (event.payload.player_id !== selfId) return { state };
			// No battle_id on this payload — carry forward whatever we already know,
			// which a following battle_update will typically fill in/correct.
			return enter(state, state.activeBattleId, now);
		}
		case "battle_damage": {
			const isSelf = event.payload.attacker_id === selfId || event.payload.target_id === selfId;
			if (!isSelf) return { state };
			return enter(state, state.activeBattleId, now);
		}
		case "battle_ended": {
			// Scoped to the battle we're actually tracking — an unrelated nearby
			// battle ending must not clear this account's in-combat state.
			if (state.phase !== "in-combat" || event.payload.battle_id !== state.activeBattleId) {
				return { state };
			}
			return exit(event.payload.battle_id, "battle_ended");
		}
		case "battle_left": {
			if (event.payload.player_id !== selfId) return { state };
			return exit(state.activeBattleId, "battle_left");
		}
		case "player_died": {
			return {
				state: { ...INITIAL_COMBAT_STATE },
				transition: { kind: "died" },
			};
		}
		case "player_kill": {
			// Informational push to the killer, not a combat-state signal for this account.
			return { state };
		}
		default:
			return { state };
	}
}

/**
 * Wall-clock timeout fallback: if no combat notification has arrived for
 * `timeoutMs` while the account is tracked as in-combat, presume the fight
 * resolved and exit. Without this, a single dropped `battle_left`/
 * `battle_ended` push would strand the account "in combat" permanently and
 * recovery would never run.
 */
export function reduceTimeout(
	state: CombatDetectorState,
	now: number,
	timeoutMs: number,
): CombatReducerResult {
	if (state.phase !== "in-combat") return { state };
	if (now - state.lastActivityAt < timeoutMs) return { state };
	return exit(state.activeBattleId, "timeout");
}
