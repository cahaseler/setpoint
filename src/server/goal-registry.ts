import { deprecatedGoalMessage, goalSchemas } from "@setpoint/protocol";
import {
	LibBuyAtStation,
	LibEnhancedMiningRun,
	LibEnsureLoadout,
	LibEnsureMagazines,
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
	LibReloadWeapon,
	LibScan,
	LibSellOrDepositCargo,
	LibTransferStorage,
	LibUninstallMod,
	LibUseItem,
	LibWithdrawFromFactionStorage,
} from "../dispatcher/lib-primitives/index.js";

type GoalFactory = (opts: Record<string, unknown>) => LibGoal;

// Each factory validates its raw options against the matching zod schema in
// `goalSchemas` (from `@setpoint/protocol`) before constructing the Lib* goal.
// The schema is the single source of truth for a goal's option shape — it
// doubles as the client's compile-time type and the daemon's runtime
// validator. `.parse()` throws a `ZodError` on invalid input, which
// `createGoal` lets propagate to the caller (the goal handlers map it to a
// 400 with a formatted validation message).
const registry: ReadonlyMap<string, GoalFactory> = new Map<string, GoalFactory>([
	// --- Primitives ---
	[
		"navigate-to-system",
		(opts) => {
			const validated = goalSchemas["navigate-to-system"].parse(opts);
			return new LibNavigateToSystem(validated.targetSystemId, validated.fuelReserve);
		},
	],
	[
		"navigate-via-route",
		(opts) => {
			const validated = goalSchemas["navigate-via-route"].parse(opts);
			return new LibNavigateViaRoute(validated.route, validated.fuelReserve);
		},
	],
	["go-to-poi", (opts) => new LibGoToPoi(goalSchemas["go-to-poi"].parse(opts).targetPoiId)],
	["dock-at", (opts) => new LibDockAt(goalSchemas["dock-at"].parse(opts).targetBaseId)],
	["ensure-undocked", () => new LibEnsureUndocked()],
	[
		"ensure-fueled",
		(opts) => {
			const validated = goalSchemas["ensure-fueled"].parse(opts);
			return new LibEnsureFueled(validated.targetFuel, {
				...(validated.requireFull !== undefined ? { requireFull: validated.requireFull } : {}),
			});
		},
	],
	["ensure-repaired", () => new LibEnsureRepaired()],
	[
		"sell-or-deposit-cargo",
		(opts) => {
			const { depositTarget } = goalSchemas["sell-or-deposit-cargo"].parse(opts);
			return new LibSellOrDepositCargo(depositTarget !== undefined ? { depositTarget } : {});
		},
	],
	[
		"ensure-empty-cargo",
		(opts) => {
			const { depositTarget } = goalSchemas["ensure-empty-cargo"].parse(opts);
			return new LibEnsureEmptyCargo(depositTarget !== undefined ? { depositTarget } : {});
		},
	],
	[
		"jettison-cargo",
		(opts) => {
			const validated = goalSchemas["jettison-cargo"].parse(opts);
			return new LibJettisonCargo({ itemId: validated.itemId, quantity: validated.quantity });
		},
	],
	[
		"load-from-storage",
		(opts) => {
			const validated = goalSchemas["load-from-storage"].parse(opts);
			return new LibLoadFromStorage(validated.itemId, validated.maxQuantity);
		},
	],
	["scan", () => new LibScan()],
	["use-item", (opts) => new LibUseItem({ itemId: goalSchemas["use-item"].parse(opts).itemId })],
	[
		"create-buy-order",
		(opts) => {
			const validated = goalSchemas["create-buy-order"].parse(opts);
			return new LibCreateBuyOrder(validated.itemId, validated.quantity, validated.price);
		},
	],
	[
		"create-sell-order",
		(opts) => {
			const validated = goalSchemas["create-sell-order"].parse(opts);
			return new LibCreateSellOrder(validated.itemId, validated.quantity, validated.price);
		},
	],
	[
		"cancel-orders",
		(opts) => new LibCancelOrders({ orderIds: goalSchemas["cancel-orders"].parse(opts).orderIds }),
	],
	[
		"accept-mission",
		(opts) =>
			new LibAcceptMission({ missionId: goalSchemas["accept-mission"].parse(opts).missionId }),
	],
	[
		"complete-mission",
		(opts) =>
			new LibCompleteMission({ missionId: goalSchemas["complete-mission"].parse(opts).missionId }),
	],
	[
		"abandon-mission",
		(opts) =>
			new LibAbandonMission({ missionId: goalSchemas["abandon-mission"].parse(opts).missionId }),
	],
	[
		"install-mod",
		(opts) => new LibInstallMod({ moduleId: goalSchemas["install-mod"].parse(opts).moduleId }),
	],
	[
		"uninstall-mod",
		(opts) => new LibUninstallMod({ moduleId: goalSchemas["uninstall-mod"].parse(opts).moduleId }),
	],
	[
		"buy-items",
		(opts) => {
			const { items } = goalSchemas["buy-items"].parse(opts);
			return new LibBuyItems({
				items: items.map((item) => ({
					itemId: item.itemId,
					maxPrice: item.maxPrice,
					...(item.maxQuantity !== undefined ? { maxQuantity: item.maxQuantity } : {}),
				})),
			});
		},
	],
	[
		"list-cargo-for-sale",
		(opts) =>
			new LibListCargoForSale({ items: goalSchemas["list-cargo-for-sale"].parse(opts).items }),
	],
	[
		"deposit-to-faction-storage",
		(opts) => {
			const validated = goalSchemas["deposit-to-faction-storage"].parse(opts);
			return new LibDepositToFactionStorage({
				itemId: validated.itemId,
				quantity: validated.quantity,
			});
		},
	],
	[
		"withdraw-from-faction-storage",
		(opts) => {
			const validated = goalSchemas["withdraw-from-faction-storage"].parse(opts);
			return new LibWithdrawFromFactionStorage({
				itemId: validated.itemId,
				...(validated.quantity !== undefined ? { quantity: validated.quantity } : {}),
			});
		},
	],
	[
		"gift-to-player",
		(opts) => {
			const validated = goalSchemas["gift-to-player"].parse(opts);
			return new LibGiftToPlayer({
				targetName: validated.targetName,
				itemId: validated.itemId,
				quantity: validated.quantity,
				...(validated.message !== undefined ? { message: validated.message } : {}),
			});
		},
	],
	[
		"load-from-faction-storage",
		(opts) => {
			const validated = goalSchemas["load-from-faction-storage"].parse(opts);
			return new LibLoadFromFactionStorage(validated.itemId, validated.maxQuantity);
		},
	],
	[
		"ensure-credits-from-faction",
		(opts) => {
			const { minCredits } = goalSchemas["ensure-credits-from-faction"].parse(opts);
			return new LibEnsureCreditsFromFaction(minCredits !== undefined ? { minCredits } : undefined);
		},
	],

	// --- Compounds ---
	[
		"mine-until-full",
		(opts) => {
			const { fullThreshold, maxAttempts } = goalSchemas["mine-until-full"].parse(opts);
			return new LibMineUntilFull({
				...(fullThreshold !== undefined ? { fullThreshold } : {}),
				...(maxAttempts !== undefined ? { maxAttempts } : {}),
			});
		},
	],
	[
		"prepare-at-station",
		(opts) => {
			const validated = goalSchemas["prepare-at-station"].parse(opts);
			return new LibPrepareAtStation({
				systemId: validated.systemId,
				poiId: validated.poiId,
				baseId: validated.baseId,
				...(validated.refuel !== undefined ? { refuel: validated.refuel } : {}),
				...(validated.requireFullFuel !== undefined
					? { requireFullFuel: validated.requireFullFuel }
					: {}),
				...(validated.repair !== undefined ? { repair: validated.repair } : {}),
				...(validated.cashSource !== undefined ? { cashSource: validated.cashSource } : {}),
				...(validated.minCredits !== undefined ? { minCredits: validated.minCredits } : {}),
				...(validated.route !== undefined ? { route: validated.route } : {}),
			});
		},
	],
	[
		"sell-at-station",
		(opts) => {
			const validated = goalSchemas["sell-at-station"].parse(opts);
			return new LibSellAtStation({
				systemId: validated.systemId,
				stationPoiId: validated.stationPoiId,
				baseId: validated.baseId,
				...(validated.refuel !== undefined ? { refuel: validated.refuel } : {}),
				...(validated.depositTarget !== undefined
					? { depositTarget: validated.depositTarget }
					: {}),
				...(validated.cashSource !== undefined ? { cashSource: validated.cashSource } : {}),
				...(validated.minCredits !== undefined ? { minCredits: validated.minCredits } : {}),
			});
		},
	],
	[
		"mining-run",
		(opts) => {
			const validated = goalSchemas["mining-run"].parse(opts);
			return new LibMiningRun({
				systemId: validated.systemId,
				beltPoiId: validated.beltPoiId,
				...(validated.fullThreshold !== undefined
					? { fullThreshold: validated.fullThreshold }
					: {}),
				...(validated.maxAttempts !== undefined ? { maxAttempts: validated.maxAttempts } : {}),
			});
		},
	],
	[
		"enhanced-mining-run",
		(opts) => {
			const validated = goalSchemas["enhanced-mining-run"].parse(opts);
			return new LibEnhancedMiningRun({
				systemId: validated.systemId,
				beltPoiId: validated.beltPoiId,
				junkItemIds: validated.junkItemIds,
				...(validated.fullThreshold !== undefined
					? { fullThreshold: validated.fullThreshold }
					: {}),
				...(validated.maxAttempts !== undefined ? { maxAttempts: validated.maxAttempts } : {}),
				...(validated.maxJettisonRounds !== undefined
					? { maxJettisonRounds: validated.maxJettisonRounds }
					: {}),
			});
		},
	],
	[
		"mine-with-jettison",
		(opts) => {
			const validated = goalSchemas["mine-with-jettison"].parse(opts);
			return new LibMineWithJettison({
				junkItemIds: validated.junkItemIds,
				...(validated.fullThreshold !== undefined
					? { fullThreshold: validated.fullThreshold }
					: {}),
				...(validated.maxAttempts !== undefined ? { maxAttempts: validated.maxAttempts } : {}),
				...(validated.maxJettisonRounds !== undefined
					? { maxJettisonRounds: validated.maxJettisonRounds }
					: {}),
			});
		},
	],
	[
		"buy-at-station",
		(opts) => {
			const validated = goalSchemas["buy-at-station"].parse(opts);
			return new LibBuyAtStation({
				systemId: validated.systemId,
				poiId: validated.poiId,
				baseId: validated.baseId,
				items: validated.items.map((item) => ({
					itemId: item.itemId,
					maxPrice: item.maxPrice,
					...(item.maxQuantity !== undefined ? { maxQuantity: item.maxQuantity } : {}),
				})),
				...(validated.refuel !== undefined ? { refuel: validated.refuel } : {}),
			});
		},
	],
	[
		"sell-at-station-priced",
		(opts) => {
			const validated = goalSchemas["sell-at-station-priced"].parse(opts);
			return new LibSellAtStationPriced({
				systemId: validated.systemId,
				stationPoiId: validated.stationPoiId,
				baseId: validated.baseId,
				items: validated.items,
				...(validated.refuel !== undefined ? { refuel: validated.refuel } : {}),
			});
		},
	],
	[
		"load-at-station",
		(opts) => {
			const validated = goalSchemas["load-at-station"].parse(opts);
			return new LibLoadAtStation({
				systemId: validated.systemId,
				poiId: validated.poiId,
				baseId: validated.baseId,
				sourceType: validated.sourceType,
				items: validated.items.map((item) => ({
					itemId: item.itemId,
					...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
					...(item.maxPrice !== undefined ? { maxPrice: item.maxPrice } : {}),
				})),
				...(validated.refuel !== undefined ? { refuel: validated.refuel } : {}),
			});
		},
	],
	[
		"unload-at-station",
		(opts) => {
			const validated = goalSchemas["unload-at-station"].parse(opts);
			return new LibUnloadAtStation({
				systemId: validated.systemId,
				poiId: validated.poiId,
				baseId: validated.baseId,
				destType: validated.destType,
				...(validated.targetPlayer !== undefined ? { targetPlayer: validated.targetPlayer } : {}),
				...(validated.items !== undefined
					? {
							items: validated.items.map((item) => ({
								itemId: item.itemId,
								...(item.minPrice !== undefined ? { minPrice: item.minPrice } : {}),
							})),
						}
					: {}),
				...(validated.refuel !== undefined ? { refuel: validated.refuel } : {}),
			});
		},
	],
	[
		"ensure-loadout",
		(opts) => {
			const validated = goalSchemas["ensure-loadout"].parse(opts);
			return new LibEnsureLoadout({
				systemId: validated.systemId,
				poiId: validated.poiId,
				baseId: validated.baseId,
				modules: validated.modules,
				...(validated.uninstalledStorage !== undefined
					? { uninstalledStorage: validated.uninstalledStorage }
					: {}),
				...(validated.phase !== undefined ? { phase: validated.phase } : {}),
			});
		},
	],
	[
		"ensure-magazines",
		(opts) => {
			const validated = goalSchemas["ensure-magazines"].parse(opts);
			return new LibEnsureMagazines({
				...(validated.policy !== undefined ? { policy: validated.policy } : {}),
				...(validated.ammo !== undefined ? { ammo: validated.ammo } : {}),
			});
		},
	],
	[
		"reload-weapon",
		(opts) => {
			const validated = goalSchemas["reload-weapon"].parse(opts);
			return new LibReloadWeapon({
				moduleId: validated.moduleId,
				...(validated.ammoItemId !== undefined ? { ammoItemId: validated.ammoItemId } : {}),
			});
		},
	],
	[
		"ensure-marketbook",
		(opts) => {
			const validated = goalSchemas["ensure-marketbook"].parse(opts);
			return new LibEnsureMarketbook({
				targetOrders: validated.targetOrders,
				...(validated.priceTolerance !== undefined
					? { priceTolerance: validated.priceTolerance }
					: {}),
				...(validated.cancelUnmatched !== undefined
					? { cancelUnmatched: validated.cancelUnmatched }
					: {}),
			});
		},
	],
	["transfer-storage-to-faction", () => new LibTransferStorageToFaction()],
	[
		"fuel-rescue",
		(opts) => {
			const validated = goalSchemas["fuel-rescue"].parse(opts);
			return new LibFuelRescue({
				systemId: validated.systemId,
				poiId: validated.poiId,
				targetUsername: validated.targetUsername,
			});
		},
	],
	[
		"transfer-storage",
		(opts) => {
			const validated = goalSchemas["transfer-storage"].parse(opts);
			return new LibTransferStorage({
				source: validated.source,
				target: validated.target,
				itemId: validated.itemId,
				...(validated.quantity !== undefined ? { quantity: validated.quantity } : {}),
			});
		},
	],
]);

/**
 * Returns the deprecation guidance for a removed goal/loop type, or undefined
 * if the type is not deprecated. Used by the handlers to return a clear
 * pointer at the new system instead of a generic "unknown type" error.
 *
 * Sourced from `@setpoint/protocol`'s `deprecatedGoalMessage` — single source
 * for the deprecation guidance text (also consumed by the client).
 */
export function deprecatedTypeMessage(type: string): string | undefined {
	return deprecatedGoalMessage(type);
}

/** Get the list of all registered goal type names. */
export function getGoalTypes(): string[] {
	return [...registry.keys()];
}

/**
 * Shape of a zod `ZodError`'s `issues` array. Duck-typed rather than checked
 * via `instanceof` because zod is a transitive dependency (through
 * `@setpoint/protocol`), not a direct dependency of the daemon. Exported so
 * other handlers (e.g. loop start/patch validation) can reuse the same
 * duck-typed detection instead of re-declaring it.
 */
export interface ZodLikeError {
	issues: Array<{ path: PropertyKey[]; message: string }>;
}

export function isZodLikeError(err: unknown): err is ZodLikeError {
	return (
		typeof err === "object" &&
		err !== null &&
		"issues" in err &&
		Array.isArray((err as { issues: unknown }).issues)
	);
}

/**
 * Format an error into a readable message for the goal-execution handlers'
 * 400 response. A `ZodError` (thrown by `goalSchemas[type].parse()`) is
 * expanded into one "options.<path>: <message>" entry per issue (joined with
 * "; "); any other `Error` passes through as its own message.
 */
export function formatGoalError(err: unknown): string {
	if (isZodLikeError(err)) {
		return err.issues
			.map((issue) => `options.${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
	}
	return err instanceof Error ? err.message : "Invalid goal options";
}

/**
 * Create a Goal instance by type name and options.
 * Throws if the type is unknown or deprecated. Throws a plain `Error` with a
 * readable "options.<field>: <message>" description if the options fail
 * validation against the goal's schema in `@setpoint/protocol` (the schema's
 * `ZodError` is reformatted via `formatGoalError` here, at the source, so
 * every `createGoal` caller — tests and HTTP handlers alike — sees the same
 * readable message).
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
	try {
		return factory(options);
	} catch (err) {
		if (isZodLikeError(err)) {
			throw new Error(formatGoalError(err));
		}
		throw err;
	}
}
