// Re-export the game-derived lib types so protocol consumers reference one place.
export type {
	V2GameState,
	MutationResult,
	QueryResult,
	Commands,
	MarketItem,
	ObservedPlayer,
	CloakedContact,
} from "@spacemolt/lib";

// @spacemolt/lib has no exported canonical Empire type — the five empire names
// only appear as inline string-literal unions on individual generated command
// params (e.g. RegisterParams.empire). Declare the enum here.
export const EMPIRES = ["solarian", "voidborn", "crimson", "nebula", "outerrim"] as const;
export type Empire = (typeof EMPIRES)[number];
