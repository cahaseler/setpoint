import { describe, expect, test } from "bun:test";
import type { V2CargoItem } from "@spacemolt/lib";
import { type CargoStack, actionableStacks, stackName } from "../../src/dispatcher/cargo";
import { partial } from "../helpers/deep-partial.js";

describe("actionableStacks", () => {
	test("returns empty array for undefined cargo", () => {
		expect(actionableStacks(undefined)).toEqual([]);
	});

	test("keeps stacks with item_id and positive quantity", () => {
		const stacks = actionableStacks(
			partial<V2CargoItem[]>([
				{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 5, size: 1 },
				{ item_id: "copper_ore", quantity: 2 },
			]),
		);
		expect(stacks).toHaveLength(2);
		expect(stacks[0]?.item_id).toBe("iron_ore");
	});

	test("drops stacks missing item_id", () => {
		expect(
			actionableStacks(partial<V2CargoItem[]>([{ item_name: "Mystery", quantity: 3 }])),
		).toEqual([]);
	});

	test("drops stacks with zero, negative, or missing quantity", () => {
		const stacks = actionableStacks(
			partial<V2CargoItem[]>([
				{ item_id: "a", quantity: 0 },
				{ item_id: "b", quantity: -1 },
				{ item_id: "c" },
			]),
		);
		expect(stacks).toEqual([]);
	});
});

describe("stackName", () => {
	test("prefers the resolved item name", () => {
		expect(
			stackName(partial<CargoStack>({ item_id: "iron_ore", item_name: "Iron Ore", quantity: 1 })),
		).toBe("Iron Ore");
	});

	test("falls back to the item id", () => {
		expect(stackName(partial<CargoStack>({ item_id: "iron_ore", quantity: 1 }))).toBe("iron_ore");
	});
});
