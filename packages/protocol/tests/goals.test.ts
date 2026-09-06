import { expect, test } from "bun:test";
import {
	DEPRECATED_GOAL_TYPES,
	type GoalOptionsMap,
	type GoalType,
	deprecatedGoalMessage,
	goalSchemas,
} from "../src/goals.js";

test("navigate-to-system parses valid + rejects invalid", () => {
	expect(goalSchemas["navigate-to-system"].parse({ targetSystemId: "sol" })).toEqual({
		targetSystemId: "sol",
	});
	expect(() => goalSchemas["navigate-to-system"].parse({})).toThrow();
	// optional fuelReserve accepted:
	expect(
		goalSchemas["navigate-to-system"].parse({ targetSystemId: "sol", fuelReserve: 5 }).fuelReserve,
	).toBe(5);
});

test("buy-items item array shape", () => {
	const ok = goalSchemas["buy-items"].parse({ items: [{ itemId: "iron_ore", maxPrice: 10 }] });
	expect(ok.items[0]?.itemId).toBe("iron_ore");
	expect(() => goalSchemas["buy-items"].parse({ items: [{ itemId: "x" }] })).toThrow(); // maxPrice required
	// requireItemArray in goal-registry.ts throws on an empty array — mirrored here as .min(1):
	expect(() => goalSchemas["buy-items"].parse({ items: [] })).toThrow();
});

test("GoalType includes all 45 registry types", () => {
	const types: GoalType[] = Object.keys(goalSchemas) as GoalType[];
	expect(types).toContain("navigate-to-system");
	expect(types).toContain("transfer-storage");
	expect(types.length).toBe(45);
});

// A compile-time check: GoalOptionsMap["navigate-to-system"] has targetSystemId: string.
const _t: GoalOptionsMap["navigate-to-system"] = { targetSystemId: "x" };

test("unload-at-station enum + optional item array", () => {
	const parsed = goalSchemas["unload-at-station"].parse({
		systemId: "sol",
		poiId: "poi-1",
		baseId: "base-1",
		destType: "faction-storage",
	});
	expect(parsed.destType).toBe("faction-storage");
	expect(() =>
		goalSchemas["unload-at-station"].parse({
			systemId: "sol",
			poiId: "poi-1",
			baseId: "base-1",
			destType: "not-a-real-dest",
		}),
	).toThrow();
});

test("ensure-marketbook requires side/quantity/price on each target order", () => {
	const ok = goalSchemas["ensure-marketbook"].parse({
		targetOrders: [{ itemId: "iron_ore", side: "sell", quantity: 10, price: 5 }],
	});
	expect(ok.targetOrders[0]?.side).toBe("sell");
	expect(() =>
		goalSchemas["ensure-marketbook"].parse({
			targetOrders: [{ itemId: "iron_ore", side: "invalid-side", quantity: 10, price: 5 }],
		}),
	).toThrow();
	// requireItemArray throws on empty targetOrders — mirrored as .min(1):
	expect(() => goalSchemas["ensure-marketbook"].parse({ targetOrders: [] })).toThrow();
	// registry validates priceTolerance is in [0, 1]:
	expect(() =>
		goalSchemas["ensure-marketbook"].parse({
			targetOrders: [{ itemId: "iron_ore", side: "sell", quantity: 10, price: 5 }],
			priceTolerance: 1.5,
		}),
	).toThrow();
});

test("transfer-storage-to-faction and scan take no options", () => {
	expect(goalSchemas["transfer-storage-to-faction"].parse({})).toEqual({});
	expect(goalSchemas.scan.parse({})).toEqual({});
});

test("deprecated goal types return the daemon's verbatim deprecation message", () => {
	for (const type of DEPRECATED_GOAL_TYPES) {
		expect(deprecatedGoalMessage(type)).toContain(
			"DEPRECATED: managed crafting goals/loops were removed",
		);
	}
	expect(deprecatedGoalMessage("navigate-to-system")).toBeUndefined();
});
