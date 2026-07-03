import type { V2GameState } from "@spacemolt/lib";

type RawCargoEntry = NonNullable<V2GameState["cargo"]>[number];

/** A cargo entry narrowed to the fields required to act on it. */
export type CargoStack = RawCargoEntry & { item_id: string; quantity: number };

/**
 * Narrows raw cargo entries to actionable stacks: a known item_id and a
 * positive quantity. The v2 spec marks every cargo field optional, so all
 * consumers must filter through here before acting on a stack.
 */
export function actionableStacks(cargo: readonly RawCargoEntry[] | undefined): CargoStack[] {
	return (cargo ?? []).filter(
		(item): item is CargoStack => item.item_id !== undefined && (item.quantity ?? 0) > 0,
	);
}

/** Display name for a cargo stack: resolved item name, falling back to the item id. */
export function stackName(item: CargoStack): string {
	return item.item_name ?? item.item_id;
}
