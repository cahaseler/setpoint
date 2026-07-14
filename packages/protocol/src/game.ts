// Re-export the game-derived lib types so protocol consumers reference one place.
export type {
	V2GameState,
	MutationResult,
	QueryResult,
	Commands,
	MarketItem,
	ObservedPlayer,
	CloakedContact,
	NotificationPayloads,
	TypedNotificationType,
} from "@spacemolt/lib";

import type { NotificationPayloads } from "@spacemolt/lib";

/** Per-job crafting progress push, as sent by the game server's `crafting_update` notification. */
export type CraftingUpdateEvent = NotificationPayloads["crafting_update"];

/** The subset of notification types setpoint's combat detector treats as combat-relevant. */
export const COMBAT_NOTIFICATION_TYPES = [
	"battle_alert",
	"battle_started",
	"battle_joined",
	"battle_update",
	"battle_damage",
	"battle_ended",
	"battle_left",
	"player_died",
	"player_kill",
] as const;
export type CombatNotificationType = (typeof COMBAT_NOTIFICATION_TYPES)[number];

// @spacemolt/lib has no exported canonical Empire type — the five empire names
// only appear as inline string-literal unions on individual generated command
// params (e.g. RegisterParams.empire). Declare the enum here.
export const EMPIRES = ["solarian", "voidborn", "crimson", "nebula", "outerrim"] as const;
export type Empire = (typeof EMPIRES)[number];
