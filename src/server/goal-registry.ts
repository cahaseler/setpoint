import {
	LibBuyAtStation,
	LibEnhancedMiningRun,
	LibEnsureLoadout,
	LibEnsureMarketbook,
	LibFuelRescue,
	LibLoadAtStation,
	LibMineUntilFull,
	LibMineWithJettison,
	LibMiningRun,
	LibPrepareAtStation,
	LibSellAtStation,
	LibSellAtStationPriced,
	LibTransferStorageToFaction,
	LibUnloadAtStation,
	UNLOAD_DEST_TYPES,
} from "../dispatcher/lib-compounds/index.js";
import type { LibGoal } from "../dispatcher/lib-goal-context.js";
import {
	LibAbandonMission,
	LibAcceptMission,
	LibBuyItems,
	LibCancelOrders,
	LibCompleteMission,
	LibCreateBuyOrder,
	LibCreateSellOrder,
	LibDepositToFactionStorage,
	LibDockAt,
	LibEnsureCreditsFromFaction,
	LibEnsureEmptyCargo,
	LibEnsureFueled,
	LibEnsureRepaired,
	LibEnsureUndocked,
	LibGiftToPlayer,
	LibGoToPoi,
	LibInstallMod,
	LibJettisonCargo,
	LibListCargoForSale,
	LibLoadFromFactionStorage,
	LibLoadFromStorage,
	LibNavigateToSystem,
	LibNavigateViaRoute,
	LibScan,
	LibSellOrDepositCargo,
	LibTransferStorage,
	LibUninstallMod,
	LibUseItem,
	LibWithdrawFromFactionStorage,
} from "../dispatcher/lib-primitives/index.js";

type GoalFactory = (opts: Record<string, unknown>) => LibGoal;

function requireString(opts: Record<string, unknown>, key: string): string {
	const value = opts[key];
	if (typeof value !== "string") {
		throw new Error(`options.${key} is required (string)`);
	}
	return value;
}

function requireNumber(opts: Record<string, unknown>, key: string): number {
	const value = opts[key];
	if (typeof value !== "number") {
		throw new Error(`options.${key} is required (number)`);
	}
	return value;
}

function requireStringArray(opts: Record<string, unknown>, key: string): string[] {
	const value = opts[key];
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
		throw new Error(`options.${key} is required (string[])`);
	}
	return value as string[];
}

function requireItemArray(
	opts: Record<string, unknown>,
	key: string,
	requiredFields: string[],
): Record<string, unknown>[] {
	const value = opts[key];
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`options.${key} is required (non-empty array)`);
	}
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error(`options.${key} entries must be objects`);
		}
		const entry = item as Record<string, unknown>;
		for (const field of requiredFields) {
			if (entry[field] === undefined) {
				throw new Error(`options.${key} entries require '${field}'`);
			}
		}
	}
	return value as Record<string, unknown>[];
}

const registry: ReadonlyMap<string, GoalFactory> = new Map<string, GoalFactory>([
	// --- Primitives ---
	[
		"navigate-to-system",
		(opts) => {
			const fuelReserve = typeof opts["fuelReserve"] === "number" ? opts["fuelReserve"] : undefined;
			return new LibNavigateToSystem(requireString(opts, "targetSystemId"), fuelReserve);
		},
	],
	[
		"navigate-via-route",
		(opts) => {
			const fuelReserve = typeof opts["fuelReserve"] === "number" ? opts["fuelReserve"] : undefined;
			return new LibNavigateViaRoute(requireStringArray(opts, "route"), fuelReserve);
		},
	],
	["go-to-poi", (opts) => new LibGoToPoi(requireString(opts, "targetPoiId"))],
	["dock-at", (opts) => new LibDockAt(requireString(opts, "targetBaseId"))],
	["ensure-undocked", () => new LibEnsureUndocked()],
	[
		"ensure-fueled",
		(opts) => {
			const targetFuel = typeof opts["targetFuel"] === "number" ? opts["targetFuel"] : undefined;
			return new LibEnsureFueled(targetFuel);
		},
	],
	["ensure-repaired", () => new LibEnsureRepaired()],
	[
		"sell-or-deposit-cargo",
		(opts) => {
			const depositTarget = opts["depositTarget"];
			return new LibSellOrDepositCargo(
				depositTarget === "personal" || depositTarget === "faction" ? { depositTarget } : {},
			);
		},
	],
	[
		"ensure-empty-cargo",
		(opts) => {
			const depositTarget = opts["depositTarget"];
			return new LibEnsureEmptyCargo(
				depositTarget === "personal" || depositTarget === "faction" ? { depositTarget } : {},
			);
		},
	],
	[
		"jettison-cargo",
		(opts) =>
			new LibJettisonCargo({
				itemId: requireString(opts, "itemId"),
				quantity: requireNumber(opts, "quantity"),
			}),
	],
	[
		"load-from-storage",
		(opts) => {
			const maxQuantity = typeof opts["maxQuantity"] === "number" ? opts["maxQuantity"] : undefined;
			return new LibLoadFromStorage(requireString(opts, "itemId"), maxQuantity);
		},
	],
	["scan", () => new LibScan()],
	["use-item", (opts) => new LibUseItem({ itemId: requireString(opts, "itemId") })],
	[
		"create-buy-order",
		(opts) =>
			new LibCreateBuyOrder(
				requireString(opts, "itemId"),
				requireNumber(opts, "quantity"),
				requireNumber(opts, "price"),
			),
	],
	[
		"create-sell-order",
		(opts) =>
			new LibCreateSellOrder(
				requireString(opts, "itemId"),
				requireNumber(opts, "quantity"),
				requireNumber(opts, "price"),
			),
	],
	[
		"cancel-orders",
		(opts) => new LibCancelOrders({ orderIds: requireStringArray(opts, "orderIds") }),
	],
	[
		"accept-mission",
		(opts) => new LibAcceptMission({ missionId: requireString(opts, "missionId") }),
	],
	[
		"complete-mission",
		(opts) => new LibCompleteMission({ missionId: requireString(opts, "missionId") }),
	],
	[
		"abandon-mission",
		(opts) => new LibAbandonMission({ missionId: requireString(opts, "missionId") }),
	],
	["install-mod", (opts) => new LibInstallMod({ moduleId: requireString(opts, "moduleId") })],
	["uninstall-mod", (opts) => new LibUninstallMod({ moduleId: requireString(opts, "moduleId") })],
	[
		"buy-items",
		(opts) => {
			const items = requireItemArray(opts, "items", ["itemId", "maxPrice"]);
			return new LibBuyItems({
				items: items.map((item) => ({
					itemId: item["itemId"] as string,
					maxPrice: item["maxPrice"] as number,
					...(typeof item["maxQuantity"] === "number" ? { maxQuantity: item["maxQuantity"] } : {}),
				})),
			});
		},
	],
	[
		"list-cargo-for-sale",
		(opts) => {
			const items = requireItemArray(opts, "items", ["itemId", "minPrice"]);
			return new LibListCargoForSale({
				items: items.map((item) => ({
					itemId: item["itemId"] as string,
					minPrice: item["minPrice"] as number,
				})),
			});
		},
	],
	[
		"deposit-to-faction-storage",
		(opts) =>
			new LibDepositToFactionStorage({
				itemId: requireString(opts, "itemId"),
				quantity: requireNumber(opts, "quantity"),
			}),
	],
	[
		"withdraw-from-faction-storage",
		(opts) => {
			const quantity = typeof opts["quantity"] === "number" ? opts["quantity"] : undefined;
			return new LibWithdrawFromFactionStorage({
				itemId: requireString(opts, "itemId"),
				...(quantity !== undefined ? { quantity } : {}),
			});
		},
	],
	[
		"gift-to-player",
		(opts) =>
			new LibGiftToPlayer({
				targetName: requireString(opts, "targetName"),
				itemId: requireString(opts, "itemId"),
				quantity: requireNumber(opts, "quantity"),
				...(typeof opts["message"] === "string" ? { message: opts["message"] } : {}),
			}),
	],
	[
		"load-from-faction-storage",
		(opts) => {
			const maxQuantity = typeof opts["maxQuantity"] === "number" ? opts["maxQuantity"] : undefined;
			return new LibLoadFromFactionStorage(requireString(opts, "itemId"), maxQuantity);
		},
	],
	[
		"ensure-credits-from-faction",
		(opts) => {
			const minCredits = typeof opts["minCredits"] === "number" ? opts["minCredits"] : undefined;
			return new LibEnsureCreditsFromFaction(minCredits !== undefined ? { minCredits } : undefined);
		},
	],

	// --- Compounds ---
	[
		"mine-until-full",
		(opts) => {
			const fullThreshold =
				typeof opts["fullThreshold"] === "number" ? opts["fullThreshold"] : undefined;
			const maxAttempts = typeof opts["maxAttempts"] === "number" ? opts["maxAttempts"] : undefined;
			return new LibMineUntilFull({
				...(fullThreshold !== undefined ? { fullThreshold } : {}),
				...(maxAttempts !== undefined ? { maxAttempts } : {}),
			});
		},
	],
	[
		"prepare-at-station",
		(opts) => {
			const refuel = typeof opts["refuel"] === "boolean" ? opts["refuel"] : undefined;
			const repair = typeof opts["repair"] === "boolean" ? opts["repair"] : undefined;
			const cashSource = opts["cashSource"] === "faction" ? ("faction" as const) : undefined;
			const minCredits = typeof opts["minCredits"] === "number" ? opts["minCredits"] : undefined;
			const route = opts["route"] !== undefined ? requireStringArray(opts, "route") : undefined;
			return new LibPrepareAtStation({
				systemId: requireString(opts, "systemId"),
				poiId: requireString(opts, "poiId"),
				baseId: requireString(opts, "baseId"),
				...(refuel !== undefined ? { refuel } : {}),
				...(repair !== undefined ? { repair } : {}),
				...(cashSource !== undefined ? { cashSource } : {}),
				...(minCredits !== undefined ? { minCredits } : {}),
				...(route !== undefined ? { route } : {}),
			});
		},
	],
	[
		"sell-at-station",
		(opts) => {
			const refuel = typeof opts["refuel"] === "boolean" ? opts["refuel"] : undefined;
			const depositTarget = opts["depositTarget"];
			const cashSource = opts["cashSource"] === "faction" ? ("faction" as const) : undefined;
			const minCredits = typeof opts["minCredits"] === "number" ? opts["minCredits"] : undefined;
			return new LibSellAtStation({
				systemId: requireString(opts, "systemId"),
				stationPoiId: requireString(opts, "stationPoiId"),
				baseId: requireString(opts, "baseId"),
				...(refuel !== undefined ? { refuel } : {}),
				...(depositTarget === "personal" || depositTarget === "faction" ? { depositTarget } : {}),
				...(cashSource !== undefined ? { cashSource } : {}),
				...(minCredits !== undefined ? { minCredits } : {}),
			});
		},
	],
	[
		"mining-run",
		(opts) => {
			const fullThreshold =
				typeof opts["fullThreshold"] === "number" ? opts["fullThreshold"] : undefined;
			const maxAttempts = typeof opts["maxAttempts"] === "number" ? opts["maxAttempts"] : undefined;
			return new LibMiningRun({
				systemId: requireString(opts, "systemId"),
				beltPoiId: requireString(opts, "beltPoiId"),
				...(fullThreshold !== undefined ? { fullThreshold } : {}),
				...(maxAttempts !== undefined ? { maxAttempts } : {}),
			});
		},
	],
	[
		"enhanced-mining-run",
		(opts) => {
			const fullThreshold =
				typeof opts["fullThreshold"] === "number" ? opts["fullThreshold"] : undefined;
			const maxAttempts = typeof opts["maxAttempts"] === "number" ? opts["maxAttempts"] : undefined;
			const maxJettisonRounds =
				typeof opts["maxJettisonRounds"] === "number" ? opts["maxJettisonRounds"] : undefined;
			return new LibEnhancedMiningRun({
				systemId: requireString(opts, "systemId"),
				beltPoiId: requireString(opts, "beltPoiId"),
				junkItemIds: requireStringArray(opts, "junkItemIds"),
				...(fullThreshold !== undefined ? { fullThreshold } : {}),
				...(maxAttempts !== undefined ? { maxAttempts } : {}),
				...(maxJettisonRounds !== undefined ? { maxJettisonRounds } : {}),
			});
		},
	],
	[
		"mine-with-jettison",
		(opts) => {
			const fullThreshold =
				typeof opts["fullThreshold"] === "number" ? opts["fullThreshold"] : undefined;
			const maxAttempts = typeof opts["maxAttempts"] === "number" ? opts["maxAttempts"] : undefined;
			const maxJettisonRounds =
				typeof opts["maxJettisonRounds"] === "number" ? opts["maxJettisonRounds"] : undefined;
			return new LibMineWithJettison({
				junkItemIds: requireStringArray(opts, "junkItemIds"),
				...(fullThreshold !== undefined ? { fullThreshold } : {}),
				...(maxAttempts !== undefined ? { maxAttempts } : {}),
				...(maxJettisonRounds !== undefined ? { maxJettisonRounds } : {}),
			});
		},
	],
	[
		"buy-at-station",
		(opts) => {
			const items = requireItemArray(opts, "items", ["itemId", "maxPrice"]);
			const refuel = typeof opts["refuel"] === "boolean" ? opts["refuel"] : undefined;
			return new LibBuyAtStation({
				systemId: requireString(opts, "systemId"),
				poiId: requireString(opts, "poiId"),
				baseId: requireString(opts, "baseId"),
				items: items.map((item) => ({
					itemId: item["itemId"] as string,
					maxPrice: item["maxPrice"] as number,
					...(typeof item["maxQuantity"] === "number" ? { maxQuantity: item["maxQuantity"] } : {}),
				})),
				...(refuel !== undefined ? { refuel } : {}),
			});
		},
	],
	[
		"sell-at-station-priced",
		(opts) => {
			const items = requireItemArray(opts, "items", ["itemId", "minPrice"]);
			const refuel = typeof opts["refuel"] === "boolean" ? opts["refuel"] : undefined;
			return new LibSellAtStationPriced({
				systemId: requireString(opts, "systemId"),
				stationPoiId: requireString(opts, "stationPoiId"),
				baseId: requireString(opts, "baseId"),
				items: items.map((item) => ({
					itemId: item["itemId"] as string,
					minPrice: item["minPrice"] as number,
				})),
				...(refuel !== undefined ? { refuel } : {}),
			});
		},
	],
	[
		"load-at-station",
		(opts) => {
			const items = requireItemArray(opts, "items", ["itemId"]);
			const refuel = typeof opts["refuel"] === "boolean" ? opts["refuel"] : undefined;
			const sourceType = requireString(opts, "sourceType");
			return new LibLoadAtStation({
				systemId: requireString(opts, "systemId"),
				poiId: requireString(opts, "poiId"),
				baseId: requireString(opts, "baseId"),
				sourceType: sourceType as "personal-storage" | "faction-storage" | "market",
				items: items.map((item) => ({
					itemId: item["itemId"] as string,
					...(typeof item["quantity"] === "number" ? { quantity: item["quantity"] } : {}),
					...(typeof item["maxPrice"] === "number" ? { maxPrice: item["maxPrice"] } : {}),
				})),
				...(refuel !== undefined ? { refuel } : {}),
			});
		},
	],
	[
		"unload-at-station",
		(opts) => {
			const refuel = typeof opts["refuel"] === "boolean" ? opts["refuel"] : undefined;
			const destType = requireString(opts, "destType");
			if (!(UNLOAD_DEST_TYPES as readonly string[]).includes(destType)) {
				throw new Error(
					`options.destType "${destType}" is invalid — valid: ${UNLOAD_DEST_TYPES.join(", ")}`,
				);
			}
			const itemsRaw = opts["items"];
			const items = Array.isArray(itemsRaw)
				? (itemsRaw as Record<string, unknown>[]).map((item) => ({
						itemId: item["itemId"] as string,
						...(typeof item["minPrice"] === "number" ? { minPrice: item["minPrice"] } : {}),
					}))
				: undefined;

			return new LibUnloadAtStation({
				systemId: requireString(opts, "systemId"),
				poiId: requireString(opts, "poiId"),
				baseId: requireString(opts, "baseId"),
				destType: destType as "personal-storage" | "faction-storage" | "gift" | "market",
				...(typeof opts["targetPlayer"] === "string" ? { targetPlayer: opts["targetPlayer"] } : {}),
				...(items !== undefined ? { items } : {}),
				...(refuel !== undefined ? { refuel } : {}),
			});
		},
	],
	[
		"ensure-loadout",
		(opts) => {
			const ammoRaw = opts["ammo"];
			let ammo: Record<string, string> | undefined;
			if (ammoRaw !== undefined && ammoRaw !== null) {
				if (typeof ammoRaw !== "object" || Array.isArray(ammoRaw)) {
					throw new Error("options.ammo must be an object mapping weapon type_id to ammo item_id");
				}
				ammo = {};
				for (const [key, value] of Object.entries(ammoRaw as Record<string, unknown>)) {
					if (typeof value !== "string") {
						throw new Error(`options.ammo["${key}"] must be a string`);
					}
					ammo[key] = value;
				}
			}

			const uninstalledStorage =
				typeof opts["uninstalledStorage"] === "string" ? opts["uninstalledStorage"] : undefined;
			if (
				uninstalledStorage !== undefined &&
				uninstalledStorage !== "personal" &&
				uninstalledStorage !== "faction" &&
				uninstalledStorage !== "cargo"
			) {
				throw new Error('options.uninstalledStorage must be "personal", "faction", or "cargo"');
			}

			return new LibEnsureLoadout({
				systemId: requireString(opts, "systemId"),
				poiId: requireString(opts, "poiId"),
				baseId: requireString(opts, "baseId"),
				modules: requireStringArray(opts, "modules"),
				...(ammo !== undefined ? { ammo } : {}),
				...(uninstalledStorage !== undefined ? { uninstalledStorage } : {}),
			});
		},
	],
	[
		"ensure-marketbook",
		(opts) => {
			const rawOrders = requireItemArray(opts, "targetOrders", [
				"itemId",
				"side",
				"quantity",
				"price",
			]);
			const targetOrders = rawOrders.map((item) => {
				const side = item["side"];
				if (side !== "buy" && side !== "sell") {
					throw new Error('options.targetOrders entries: side must be "buy" or "sell"');
				}
				if (typeof item["quantity"] !== "number") {
					throw new Error("options.targetOrders entries: quantity must be a number");
				}
				if (typeof item["price"] !== "number") {
					throw new Error("options.targetOrders entries: price must be a number");
				}
				return {
					itemId: item["itemId"] as string,
					side: side as "buy" | "sell",
					quantity: item["quantity"] as number,
					price: item["price"] as number,
				};
			});

			const priceTolerance =
				typeof opts["priceTolerance"] === "number" ? opts["priceTolerance"] : undefined;
			if (priceTolerance !== undefined && (priceTolerance < 0 || priceTolerance > 1)) {
				throw new Error("options.priceTolerance must be a number in range [0, 1]");
			}

			const cancelUnmatched =
				typeof opts["cancelUnmatched"] === "boolean" ? opts["cancelUnmatched"] : undefined;

			return new LibEnsureMarketbook({
				targetOrders,
				...(priceTolerance !== undefined ? { priceTolerance } : {}),
				...(cancelUnmatched !== undefined ? { cancelUnmatched } : {}),
			});
		},
	],
	["transfer-storage-to-faction", () => new LibTransferStorageToFaction()],
	[
		"fuel-rescue",
		(opts) =>
			new LibFuelRescue({
				systemId: requireString(opts, "systemId"),
				poiId: requireString(opts, "poiId"),
				targetUsername: requireString(opts, "targetUsername"),
			}),
	],
	[
		"transfer-storage",
		(opts) => {
			const source = requireString(opts, "source");
			const target = requireString(opts, "target");
			if (source !== "self" && source !== "faction") {
				throw new Error('options.source must be "self" or "faction"');
			}
			if (target !== "self" && target !== "faction") {
				throw new Error('options.target must be "self" or "faction"');
			}
			const quantity = typeof opts["quantity"] === "number" ? opts["quantity"] : undefined;
			return new LibTransferStorage({
				source: source as "self" | "faction",
				target: target as "self" | "faction",
				itemId: requireString(opts, "itemId"),
				...(quantity !== undefined ? { quantity } : {}),
			});
		},
	],
]);

/**
 * Guidance returned for the removed managed crafting goals/loops. Crafting
 * is now an async job queue on the game server, so the dispatcher no longer
 * wraps it — callers submit jobs directly through the raw passthrough.
 */
export const CRAFTING_DEPRECATION_MESSAGE =
	"DEPRECATED: managed crafting goals/loops were removed. Crafting is now an async job " +
	"queue on the game server — submit jobs directly through the raw passthrough: " +
	'POST /accounts/:id/raw {"toolGroup":"spacemolt","action":"craft","params":{"id":"<recipe>","quantity":<n>}} ' +
	"(or `smctl raw <acct> craft id=<recipe> quantity=<n>`). Manage and inspect jobs with the " +
	"spacemolt_facility job_add/job_list/job_cancel actions, and watch 'crafting_update' " +
	"notifications for completion.";

/** Goal/loop types that have been removed in favour of the raw passthrough. */
const DEPRECATED_TYPES: ReadonlySet<string> = new Set([
	"craft",
	"craft-batch",
	"craft-from-faction",
	"crafting",
]);

/**
 * Returns the deprecation guidance for a removed goal/loop type, or undefined
 * if the type is not deprecated. Used by the handlers to return a clear
 * pointer at the new system instead of a generic "unknown type" error.
 */
export function deprecatedTypeMessage(type: string): string | undefined {
	return DEPRECATED_TYPES.has(type) ? CRAFTING_DEPRECATION_MESSAGE : undefined;
}

/** Get the list of all registered goal type names. */
export function getGoalTypes(): string[] {
	return [...registry.keys()];
}

/**
 * Create a Goal instance by type name and options.
 * Throws if the type is unknown, deprecated, or options are invalid.
 */
export function createGoal(type: string, options: Record<string, unknown>): LibGoal {
	const factory = registry.get(type);
	if (!factory) {
		const deprecated = deprecatedTypeMessage(type);
		if (deprecated) {
			throw new Error(deprecated);
		}
		throw new Error(`Unknown goal type: ${type}. Supported: ${getGoalTypes().join(", ")}`);
	}
	return factory(options);
}
