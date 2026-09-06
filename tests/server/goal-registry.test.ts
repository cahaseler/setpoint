import { describe, expect, test } from "bun:test";
import type { GameState } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { createGoal, getGoalTypes } from "../../src/server/goal-registry.js";
import { FakeLibGoalAccount } from "../dispatcher/lib-fakes.js";

describe("goal-registry", () => {
	test("getGoalTypes returns all registered types", () => {
		const types = getGoalTypes();
		expect(types.length).toBeGreaterThan(30);
		// existing
		expect(types).toContain("navigate-to-system");
		expect(types).toContain("dock-at");
		// new
		expect(types).toContain("buy-items");
		expect(types).toContain("list-cargo-for-sale");
		expect(types).toContain("buy-at-station");
		expect(types).toContain("unload-at-station");
	});

	test("throws on unknown goal type", () => {
		expect(() => createGoal("nonexistent", {})).toThrow("Unknown goal type");
	});

	// --- Primitives with no options ---

	test("creates ensure-undocked with no options", () => {
		const goal = createGoal("ensure-undocked", {});
		expect(goal.name).toBe("ensure-undocked");
	});

	test("creates ensure-repaired with no options", () => {
		const goal = createGoal("ensure-repaired", {});
		expect(goal.name).toBe("ensure-repaired");
	});

	test("creates sell-or-deposit-cargo with no options", () => {
		const goal = createGoal("sell-or-deposit-cargo", {});
		expect(goal.name).toBe("sell-or-deposit-cargo");
	});

	test("creates ensure-empty-cargo with no options", () => {
		const goal = createGoal("ensure-empty-cargo", {});
		expect(goal.name).toBe("ensure-empty-cargo");
	});

	test("creates scan with no options", () => {
		const goal = createGoal("scan", {});
		expect(goal.name).toBe("scan");
	});

	// --- Primitives with required options ---

	test("creates navigate-to-system with targetSystemId", () => {
		const goal = createGoal("navigate-to-system", { targetSystemId: "sol" });
		expect(goal.name).toBe("navigate-to-system");
	});

	test("navigate-to-system throws without targetSystemId", () => {
		expect(() => createGoal("navigate-to-system", {})).toThrow("options.targetSystemId");
	});

	test("navigate-to-system passes fuelReserve through to the pre-flight check", async () => {
		// The route fits the tank (need 10, have 100); the 1000-unit reserve from
		// options must reach the primitive and fail the trip before any jump.
		const state = {
			location: { system_id: "alpha", system_name: "Alpha", poi_id: "alpha_poi" },
			ship: { id: "s1", fuel: 100, max_fuel: 100 },
		} as GameState;
		const account = new FakeLibGoalAccount(state, {
			find_route: () => ({
				result: "",
				structuredContent: {
					found: true,
					message: "Route found",
					route: [{ system_id: "sol" }],
					total_jumps: 1,
					estimated_fuel: 10,
					fuel_available: 100,
				},
			}),
		});
		const ctx = makeLibGoalContext(account);

		const goal = createGoal("navigate-to-system", { targetSystemId: "sol", fuelReserve: 1000 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Insufficient fuel");
		expect(result.message).toContain("(incl. 1000 reserve)");
		expect(account.calls.some((c) => c.action === "jump")).toBe(false);
	});

	test("creates go-to-poi with targetPoiId", () => {
		const goal = createGoal("go-to-poi", { targetPoiId: "belt_1" });
		expect(goal.name).toBe("go-to-poi");
	});

	test("creates dock-at with targetBaseId", () => {
		const goal = createGoal("dock-at", { targetBaseId: "sol_base" });
		expect(goal.name).toBe("dock-at");
	});

	test("creates ensure-fueled with optional targetFuel", () => {
		const goal = createGoal("ensure-fueled", {});
		expect(goal.name).toBe("ensure-fueled");

		const goalWithTarget = createGoal("ensure-fueled", { targetFuel: 50 });
		expect(goalWithTarget.name).toBe("ensure-fueled");
	});

	test("creates jettison-cargo with itemId and quantity", () => {
		const goal = createGoal("jettison-cargo", { itemId: "ore", quantity: 10 });
		expect(goal.name).toBe("jettison-cargo");
	});

	test("jettison-cargo throws without required fields", () => {
		expect(() => createGoal("jettison-cargo", {})).toThrow("options.itemId");
		expect(() => createGoal("jettison-cargo", { itemId: "ore" })).toThrow("options.quantity");
	});

	test("creates load-from-storage with itemId", () => {
		const goal = createGoal("load-from-storage", { itemId: "ore" });
		expect(goal.name).toBe("load-from-storage");
	});

	test("throws DEPRECATED for the removed craft goal", () => {
		expect(() => createGoal("craft", { recipeId: "iron_bar" })).toThrow("DEPRECATED");
	});

	test("creates use-item with itemId", () => {
		const goal = createGoal("use-item", { itemId: "repair_kit" });
		expect(goal.name).toBe("use-item");
	});

	test("creates create-buy-order with all fields", () => {
		const goal = createGoal("create-buy-order", { itemId: "ore", quantity: 10, price: 5 });
		expect(goal.name).toBe("create-buy-order");
	});

	test("creates create-sell-order with all fields", () => {
		const goal = createGoal("create-sell-order", { itemId: "ore", quantity: 10, price: 5 });
		expect(goal.name).toBe("create-sell-order");
	});

	test("creates accept-mission with missionId", () => {
		const goal = createGoal("accept-mission", { missionId: "m1" });
		expect(goal.name).toBe("accept-mission");
	});

	test("creates complete-mission with missionId", () => {
		const goal = createGoal("complete-mission", { missionId: "m1" });
		expect(goal.name).toBe("complete-mission");
	});

	test("creates abandon-mission with missionId", () => {
		const goal = createGoal("abandon-mission", { missionId: "m1" });
		expect(goal.name).toBe("abandon-mission");
	});

	test("creates install-mod with moduleId", () => {
		const goal = createGoal("install-mod", { moduleId: "mod1" });
		expect(goal.name).toBe("install-mod");
	});

	test("creates uninstall-mod with moduleId", () => {
		const goal = createGoal("uninstall-mod", { moduleId: "mod1" });
		expect(goal.name).toBe("uninstall-mod");
	});

	// --- Compounds ---

	test("creates mine-until-full with optional fields", () => {
		const goal = createGoal("mine-until-full", {});
		expect(goal.name).toBe("mine-until-full");

		const goalWithOpts = createGoal("mine-until-full", { fullThreshold: 0.8, maxAttempts: 50 });
		expect(goalWithOpts.name).toBe("mine-until-full");
	});

	test("creates prepare-at-station with required fields", () => {
		const goal = createGoal("prepare-at-station", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
		});
		expect(goal.name).toBe("prepare-at-station");
	});

	test("prepare-at-station throws without systemId", () => {
		expect(() => createGoal("prepare-at-station", {})).toThrow("options.systemId");
	});

	test("creates sell-at-station with required fields", () => {
		const goal = createGoal("sell-at-station", {
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
		});
		expect(goal.name).toBe("sell-at-station");
	});

	test("creates mining-run with required fields", () => {
		const goal = createGoal("mining-run", {
			systemId: "sol",
			beltPoiId: "belt_1",
		});
		expect(goal.name).toBe("mining-run");
	});

	test("creates enhanced-mining-run with required fields", () => {
		const goal = createGoal("enhanced-mining-run", {
			systemId: "sol",
			beltPoiId: "belt_1",
			junkItemIds: ["junk1"],
		});
		expect(goal.name).toBe("enhanced-mining-run");
	});

	test("enhanced-mining-run throws without junkItemIds", () => {
		expect(() =>
			createGoal("enhanced-mining-run", { systemId: "sol", beltPoiId: "belt_1" }),
		).toThrow("options.junkItemIds");
	});

	test("creates mine-with-jettison with required fields", () => {
		const goal = createGoal("mine-with-jettison", {
			junkItemIds: ["junk1", "junk2"],
		});
		expect(goal.name).toBe("mine-with-jettison");
	});

	test("throws DEPRECATED for the removed craft-batch goal", () => {
		expect(() => createGoal("craft-batch", { recipeId: "iron_bar" })).toThrow("DEPRECATED");
	});

	test("throws DEPRECATED for the removed craft-from-faction goal", () => {
		expect(() => createGoal("craft-from-faction", { recipeId: "iron_bar" })).toThrow("DEPRECATED");
	});

	// --- New Trading/Hauling Primitives ---

	test("creates buy-items with items array", () => {
		const goal = createGoal("buy-items", {
			items: [{ itemId: "ore", maxPrice: 100, maxQuantity: 50 }],
		});
		expect(goal.name).toBe("buy-items");
	});

	test("buy-items throws without items", () => {
		expect(() => createGoal("buy-items", {})).toThrow("options.items");
	});

	test("creates list-cargo-for-sale with items array", () => {
		const goal = createGoal("list-cargo-for-sale", {
			items: [{ itemId: "ore", minPrice: 200 }],
		});
		expect(goal.name).toBe("list-cargo-for-sale");
	});

	test("list-cargo-for-sale throws without items", () => {
		expect(() => createGoal("list-cargo-for-sale", {})).toThrow("options.items");
	});

	test("creates deposit-to-faction-storage with itemId and quantity", () => {
		const goal = createGoal("deposit-to-faction-storage", {
			itemId: "ore",
			quantity: 10,
		});
		expect(goal.name).toBe("deposit-to-faction-storage");
	});

	test("deposit-to-faction-storage throws without required fields", () => {
		expect(() => createGoal("deposit-to-faction-storage", {})).toThrow("options.itemId");
	});

	test("creates withdraw-from-faction-storage with itemId", () => {
		const goal = createGoal("withdraw-from-faction-storage", { itemId: "ore" });
		expect(goal.name).toBe("withdraw-from-faction-storage");
	});

	test("creates withdraw-from-faction-storage with optional quantity", () => {
		const goal = createGoal("withdraw-from-faction-storage", {
			itemId: "ore",
			quantity: 50,
		});
		expect(goal.name).toBe("withdraw-from-faction-storage");
	});

	test("creates gift-to-player with all fields", () => {
		const goal = createGoal("gift-to-player", {
			targetName: "Friend",
			itemId: "ore",
			quantity: 10,
		});
		expect(goal.name).toBe("gift-to-player");
	});

	test("gift-to-player throws without targetName", () => {
		expect(() => createGoal("gift-to-player", { itemId: "ore", quantity: 10 })).toThrow(
			"options.targetName",
		);
	});

	test("creates load-from-faction-storage with itemId", () => {
		const goal = createGoal("load-from-faction-storage", { itemId: "ore" });
		expect(goal.name).toBe("load-from-faction-storage");
	});

	test("creates load-from-faction-storage with optional maxQuantity", () => {
		const goal = createGoal("load-from-faction-storage", {
			itemId: "ore",
			maxQuantity: 50,
		});
		expect(goal.name).toBe("load-from-faction-storage");
	});

	// --- New Compounds ---

	test("creates buy-at-station with required fields", () => {
		const goal = createGoal("buy-at-station", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "ore", maxPrice: 100 }],
		});
		expect(goal.name).toBe("buy-at-station");
	});

	test("buy-at-station throws without items", () => {
		expect(() =>
			createGoal("buy-at-station", {
				systemId: "sol",
				poiId: "sol_station",
				baseId: "sol_base",
			}),
		).toThrow("options.items");
	});

	test("creates sell-at-station-priced with required fields", () => {
		const goal = createGoal("sell-at-station-priced", {
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "ore", minPrice: 200 }],
		});
		expect(goal.name).toBe("sell-at-station-priced");
	});

	test("creates load-at-station with required fields", () => {
		const goal = createGoal("load-at-station", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			sourceType: "personal-storage",
			items: [{ itemId: "ore" }],
		});
		expect(goal.name).toBe("load-at-station");
	});

	test("load-at-station throws without sourceType", () => {
		expect(() =>
			createGoal("load-at-station", {
				systemId: "sol",
				poiId: "sol_station",
				baseId: "sol_base",
				items: [{ itemId: "ore" }],
			}),
		).toThrow("options.sourceType");
	});

	test("creates unload-at-station with required fields", () => {
		const goal = createGoal("unload-at-station", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "personal-storage",
		});
		expect(goal.name).toBe("unload-at-station");
	});

	test("unload-at-station throws without destType", () => {
		expect(() =>
			createGoal("unload-at-station", {
				systemId: "sol",
				poiId: "sol_station",
				baseId: "sol_base",
			}),
		).toThrow("options.destType");
	});

	test("creates navigate-via-route with a route array", () => {
		const goal = createGoal("navigate-via-route", { route: ["a", "b", "target"] });
		expect(goal.name).toBe("navigate-via-route");
	});

	test("navigate-via-route throws without route", () => {
		expect(() => createGoal("navigate-via-route", {})).toThrow("options.route");
	});

	test("creates prepare-at-station with an explicit route", () => {
		const goal = createGoal("prepare-at-station", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			route: ["a", "b", "sol"],
		});
		expect(goal.name).toBe("prepare-at-station");
	});

	test("unload-at-station throws on invalid destType value", () => {
		expect(() =>
			createGoal("unload-at-station", {
				systemId: "sol",
				poiId: "sol_station",
				baseId: "sol_base",
				destType: "faction",
			}),
		).toThrow("options.destType: Invalid enum value");
	});

	// --- ensure-credits-from-faction ---

	test("creates ensure-credits-from-faction with no options", () => {
		const goal = createGoal("ensure-credits-from-faction", {});
		expect(goal.name).toBe("ensure-credits-from-faction");
	});

	test("creates ensure-credits-from-faction with minCredits", () => {
		const goal = createGoal("ensure-credits-from-faction", { minCredits: 5000 });
		expect(goal.name).toBe("ensure-credits-from-faction");
	});

	// --- ensure-loadout ---

	test("creates ensure-loadout with required fields", () => {
		const goal = createGoal("ensure-loadout", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["shield_mod", "laser_mod"],
		});
		expect(goal.name).toBe("ensure-loadout");
	});

	test("creates ensure-loadout with optional ammo map", () => {
		const goal = createGoal("ensure-loadout", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["laser_mod"],
			ammo: { laser_type_1: "laser_ammo_a" },
		});
		expect(goal.name).toBe("ensure-loadout");
	});

	test("ensure-loadout no longer accepts ammo — ensure-magazines owns magazine loading", () => {
		// Two goals filling magazines with different semantics is how a loadout
		// could report success with most of its guns empty.
		const goal = createGoal("ensure-loadout", {
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["laser_mod"],
			ammo: { laser_type_1: "laser_ammo_a" },
		});
		expect(goal.name).toBe("ensure-loadout");
		expect(
			(goal as unknown as { options: Record<string, unknown> }).options["ammo"],
		).toBeUndefined();
	});

	test("creates ensure-loadout with each phase value", () => {
		for (const phase of ["strip", "fit", "both"] as const) {
			expect(
				createGoal("ensure-loadout", {
					systemId: "sol",
					poiId: "sol_station",
					baseId: "sol_base",
					modules: ["laser_mod"],
					phase,
				}).name,
			).toBe("ensure-loadout");
		}
	});

	test("ensure-loadout rejects an unknown phase", () => {
		expect(() =>
			createGoal("ensure-loadout", {
				systemId: "sol",
				poiId: "sol_station",
				baseId: "sol_base",
				modules: ["laser_mod"],
				phase: "refit",
			}),
		).toThrow("options.phase");
	});

	test("ensure-magazines throws when ammo is an array", () => {
		expect(() => createGoal("ensure-magazines", { ammo: ["laser_ammo_a"] })).toThrow(
			"options.ammo: Expected object, received array",
		);
	});

	test("ensure-magazines throws when ammo value is not a string", () => {
		expect(() => createGoal("ensure-magazines", { ammo: { laser_type_1: 42 } })).toThrow(
			"options.ammo.laser_type_1: Expected string, received number",
		);
	});

	test("ensure-magazines rejects an unknown policy", () => {
		expect(() => createGoal("ensure-magazines", { policy: "topup" })).toThrow("options.policy");
	});

	test("creates ensure-magazines with no options at all", () => {
		expect(createGoal("ensure-magazines", {}).name).toBe("ensure-magazines");
	});

	test("reload-weapon requires a moduleId", () => {
		expect(() => createGoal("reload-weapon", {})).toThrow("options.moduleId");
	});

	test("creates reload-weapon addressed by module_id", () => {
		expect(createGoal("reload-weapon", { moduleId: "mod-1" }).name).toBe("reload-weapon");
	});

	test("creates ensure-loadout with valid uninstalledStorage values", () => {
		for (const storage of ["personal", "faction", "cargo"]) {
			const goal = createGoal("ensure-loadout", {
				systemId: "sol",
				poiId: "sol_station",
				baseId: "sol_base",
				modules: [],
				uninstalledStorage: storage,
			});
			expect(goal.name).toBe("ensure-loadout");
		}
	});

	test("ensure-loadout throws for invalid uninstalledStorage", () => {
		expect(() =>
			createGoal("ensure-loadout", {
				systemId: "sol",
				poiId: "sol_station",
				baseId: "sol_base",
				modules: [],
				uninstalledStorage: "vault",
			}),
		).toThrow("options.uninstalledStorage: Invalid enum value");
	});

	// --- ensure-marketbook ---

	test("creates ensure-marketbook with valid targetOrders", () => {
		const goal = createGoal("ensure-marketbook", {
			targetOrders: [{ itemId: "iron_ore", side: "buy", quantity: 100, price: 50 }],
		});
		expect(goal.name).toBe("ensure-marketbook");
	});

	test("creates ensure-marketbook with sell side", () => {
		const goal = createGoal("ensure-marketbook", {
			targetOrders: [{ itemId: "iron_bar", side: "sell", quantity: 50, price: 200 }],
		});
		expect(goal.name).toBe("ensure-marketbook");
	});

	test("ensure-marketbook throws when side is invalid", () => {
		expect(() =>
			createGoal("ensure-marketbook", {
				targetOrders: [{ itemId: "iron_ore", side: "hold", quantity: 10, price: 50 }],
			}),
		).toThrow("options.targetOrders.0.side: Invalid enum value");
	});

	test("ensure-marketbook throws when priceTolerance is out of range", () => {
		expect(() =>
			createGoal("ensure-marketbook", {
				targetOrders: [{ itemId: "iron_ore", side: "buy", quantity: 10, price: 50 }],
				priceTolerance: 1.5,
			}),
		).toThrow("options.priceTolerance: Number must be less than or equal to 1");
	});

	test("ensure-marketbook accepts priceTolerance at boundary values", () => {
		for (const tol of [0, 0.1, 1]) {
			const goal = createGoal("ensure-marketbook", {
				targetOrders: [{ itemId: "iron_ore", side: "buy", quantity: 10, price: 50 }],
				priceTolerance: tol,
			});
			expect(goal.name).toBe("ensure-marketbook");
		}
	});

	// --- transfer-storage ---

	test("creates transfer-storage with valid source and target", () => {
		const goal = createGoal("transfer-storage", {
			source: "self",
			target: "faction",
			itemId: "iron_ore",
		});
		expect(goal.name).toBe("transfer-storage");
	});

	test("transfer-storage throws for invalid source", () => {
		expect(() =>
			createGoal("transfer-storage", {
				source: "other",
				target: "self",
				itemId: "iron_ore",
			}),
		).toThrow("options.source: Invalid enum value");
	});

	test("transfer-storage throws for invalid target", () => {
		expect(() =>
			createGoal("transfer-storage", {
				source: "self",
				target: "personal",
				itemId: "iron_ore",
			}),
		).toThrow("options.target: Invalid enum value");
	});

	test("creates transfer-storage-to-faction with no options", () => {
		const goal = createGoal("transfer-storage-to-faction", {});
		expect(goal.name).toBe("transfer-storage-to-faction");
	});

	// --- formatGoalError ---

	test("formatGoalError joins multiple zod issues with '; '", () => {
		expect(() => createGoal("jettison-cargo", {})).toThrow(
			"options.itemId: Required; options.quantity: Required",
		);
	});

	test("formatGoalError passes through non-validation errors unchanged", () => {
		expect(() => createGoal("nonexistent", {})).toThrow(
			"Unknown goal type: nonexistent. Supported:",
		);
	});
});
