import type { V2GameState } from "@spacemolt/lib";

type RawCargoEntry = NonNullable<V2GameState["cargo"]>[number];

/** A cargo entry narrowed to the fields required to act on it. */
export type CargoStack = RawCargoEntry & { item_id: string; quantity: number };

/**
 * Narrows raw cargo entries to actionable stacks: a known item_id and a
 * positive quantity. The positive-quantity check is the substantive one — the
 * spec types every cargo field as required, but a zero-quantity stack is a
 * normal thing for the server to report and acting on one is always a bug. The
 * item_id guard is kept as a runtime backstop, since the types describe what
 * the server promises rather than what it can actually put on the wire.
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
