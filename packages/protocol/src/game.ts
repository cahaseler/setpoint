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

// @spacemolt/lib has no exported canonical Empire type — the five empire names
// only appear as inline string-literal unions on individual generated command
// params (e.g. RegisterParams.empire). Declare the enum here.
export const EMPIRES = ["solarian", "voidborn", "crimson", "nebula", "outerrim"] as const;
export type Empire = (typeof EMPIRES)[number];
