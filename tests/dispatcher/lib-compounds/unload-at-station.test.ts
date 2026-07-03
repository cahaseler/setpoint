import { describe, expect, test } from "bun:test";
import { LibUnloadAtStation } from "../../../src/dispatcher/lib-compounds/unload-at-station.js";
import type { UnloadDestType } from "../../../src/dispatcher/lib-compounds/unload-at-station.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibUnloadAtStation", () => {
	test("market destType lists priced cargo for sale", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 10,
				},
				cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
			},
			{ create_sell_order: () => fakeMutationResult("create_sell_order") },
		);

		const result = await new LibUnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "market",
			items: [{ itemId: "iron_ore", minPrice: 5 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "create_sell_order")).toBe(true);
	});

	test("gift destType gifts each cargo stack to the target player", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 10,
				},
				cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
			},
			{ deposit: () => fakeMutationResult("deposit") },
		);

		const result = await new LibUnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "gift",
			targetPlayer: "Someone",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		const depositCall = account.calls.find((c) => c.action === "deposit");
		expect(depositCall?.params).toMatchObject({
			item_id: "iron_ore",
			quantity: 10,
			target: "Someone",
		});
	});

	test("fails fast on an unknown destType without touching the network", async () => {
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
		});

		const result = await new LibUnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "bogus" as UnloadDestType,
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.message).toContain("Unknown destType");
		expect(account.calls).toHaveLength(0);
	});
});
