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

/**
 * An intercepted pirate transmission, as sent by the game server's
 * `pirate_radio` notification. Ambient colour rather than a call to action:
 * the message is flavour text, and `source_system`/`source_poi` name where
 * the transmission came from when the server discloses it.
 */
export type PirateRadioEvent = NotificationPayloads["pirate_radio"];

/**
 * A single `observation_update` push: the change-feed of what is present at
 * the account's watched POI and system. Carries `*_changed`/`*_departed`
 * pairs for players (`nearby`/`system`), pirates, creatures, empire NPCs and
 * prizes, plus the cloaked-contact hints.
 *
 * This is the raw frame the game server sends, relayed verbatim by
 * `GET /accounts/:playerId/observation/events`. It is deliberately not the
 * same shape as `ObservationSnapshot`, which is the lib's merged
 * `ObservationView` and today reflects only the player arrays.
 */
export type ObservationUpdateEvent = NotificationPayloads["observation_update"];

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
