// Re-export the game-derived lib types so protocol consumers reference one place.
export type {
	V2GameState,
	MutationResult,
	QueryResult,
	Commands,
	MarketItem,
	ObservedPlayer,
	CloakedContact,
	ObservationView,
	NotificationPayloads,
	TypedNotificationType,
} from "@spacemolt/lib";

import type { NotificationPayloads, ObservationView } from "@spacemolt/lib";

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

/**
 * The element type of one of `ObservationView`'s entity maps.
 *
 * `@spacemolt/lib` exports `ObservationView` but not the four non-player
 * entity types it holds — those live only under its `dist/generated/` path,
 * which is not part of its public surface. Deriving them from the view keeps
 * this to one supported import rather than reaching past it, and keeps the
 * rule that API types are never hand-written.
 */
type ObservedEntity<K extends keyof ObservationView> = ObservationView[K] extends Map<
	string,
	infer T
>
	? T
	: never;

/** A pirate NPC present at a watched POI. */
export type ObservedPirate = ObservedEntity<"pirates">;
/** An empire NPC present at a watched POI. */
export type ObservedEmpireNpc = ObservedEntity<"empireNpcs">;
/** Wildlife present at a watched POI. Watch-only — creatures have no `location` equivalent. */
export type ObservedCreature = ObservedEntity<"creatures">;
/** An intact captured ship present at a watched POI. */
export type ObservedPrize = ObservedEntity<"prizes">;

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
