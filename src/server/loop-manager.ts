import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopOptionsMap } from "@setpoint/protocol";
import type { LibManagedAccount } from "../accounts/lib-types.js";
import type { LoopResult, ProgressRef } from "../dispatcher/goals.js";
import { makeLibGoalContext } from "../dispatcher/lib-goal-context.js";
import { runEnhancedMiningLoop } from "../dispatcher/lib-loops/enhanced-mining-loop.js";
import type { EnhancedMiningLoopOptions } from "../dispatcher/lib-loops/enhanced-mining-loop.js";
import { runExplorationLoop } from "../dispatcher/lib-loops/exploration-loop.js";
import type { ExplorationLoopOptions } from "../dispatcher/lib-loops/exploration-loop.js";
import { runGuardLoop } from "../dispatcher/lib-loops/guard-loop.js";
import type { GuardLoopOptions } from "../dispatcher/lib-loops/guard-loop.js";
import { runHaulingLoop } from "../dispatcher/lib-loops/hauling-loop.js";
import type { HaulingLoopOptions } from "../dispatcher/lib-loops/hauling-loop.js";
import { runMiningLoop } from "../dispatcher/lib-loops/mining-loop.js";
import type { MiningLoopOptions } from "../dispatcher/lib-loops/mining-loop.js";
import { runRoamingSalvageLoop } from "../dispatcher/lib-loops/roaming-salvage-loop.js";
import type { RoamingSalvageLoopOptions } from "../dispatcher/lib-loops/roaming-salvage-loop.js";
import { runSalvageLoop } from "../dispatcher/lib-loops/salvage-loop.js";
import type { SalvageLoopOptions } from "../dispatcher/lib-loops/salvage-loop.js";
import { runStorageTransferLoop } from "../dispatcher/lib-loops/storage-transfer-loop.js";
import type { StorageTransferLoopOptions } from "../dispatcher/lib-loops/storage-transfer-loop.js";
import { runTowSalvageLoop } from "../dispatcher/lib-loops/tow-salvage-loop.js";
import type { TowSalvageLoopOptions } from "../dispatcher/lib-loops/tow-salvage-loop.js";
import { runTradingLoop } from "../dispatcher/lib-loops/trading-loop.js";
import type { TradingLoopOptions } from "../dispatcher/lib-loops/trading-loop.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("loop-mgr");

/**
 * Recursively walk a parsed JSON value and replace any string that appears in
 * the ID mapping with its new value. Returns the (possibly new) value and
 * appends change records.
 */
function migrateJsonValue(
	value: unknown,
	mapping: Record<string, string>,
	path: string,
	changes: Array<{ path: string; from: string; to: string }>,
): unknown {
	if (typeof value === "string") {
		const newValue = mapping[value];
		if (newValue !== undefined && newValue !== value) {
			changes.push({ path, from: value, to: newValue });
			return newValue;
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, i) => migrateJsonValue(item, mapping, `${path}[${i}]`, changes));
	}
	if (typeof value === "object" && value !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			result[key] = migrateJsonValue(val, mapping, `${path}.${key}`, changes);
		}
		return result;
	}
	return value;
}

/** Status of a running loop, safe to serialize. */
export interface LoopStatus {
	type: string;
	startedAt: string;
	running: boolean;
	/** Message from the most recently completed iteration, updated while running. */
	lastStep?: string;
	/** When `lastStep` was recorded — a `running: true` loop with a stale `lastStepAt` is stalled, not dead. */
	lastStepAt?: string;
	result?: LoopResult;
	/** Original API options (system IDs, etc.) for route visualization. */
	options?: Record<string, unknown>;
}

/** Mutable step tracker shared between the loop callback and the ActiveLoop. */
interface StepRef {
	last: string | undefined;
	/** When `last` was set — lets a caller detect a loop that's `running: true` but stalled. */
	lastAt: string | undefined;
}

/** Record a completed iteration's message and timestamp on a StepRef. */
function recordStep(stepRef: StepRef, result: { message: string }): void {
	stepRef.last = result.message;
	stepRef.lastAt = new Date().toISOString();
}

/** Internal tracking for an active loop. */
interface ActiveLoop {
	type: string;
	controller: AbortController;
	promise: Promise<LoopResult>;
	startedAt: string;
	result?: LoopResult;
	readonly stepRef: StepRef;
	/** Original API options, preserved for dashboard/map route visualization. */
	options: Record<string, unknown>;
	/**
	 * Reference to the live dispatcher-layer options object that the loop factory
	 * reads each iteration. Mutating this object causes the patch to take effect
	 * on the very next iteration without stopping the loop.
	 */
	liveOptions: Record<string, unknown>;
	/** Progress tracker readable by abort handler. Set by trackLoop(). */
	progress?: ProgressRef;
}

/**
 * Options for starting a mining loop via the API.
 *
 * Field-for-field this mirrors `@setpoint/protocol`'s `LoopOptionsMap["mining"]`
 * (the zod-validated shape), with one deliberate narrowing: `listPrices` here
 * is `Record<string, number>` only, whereas the protocol schema also accepts a
 * JSON string (for CLI/form convenience). The handler normalizes a string
 * `listPrices` into an object (via `parseListPrices`) after zod validation and
 * before constructing this type, so this interface stays hand-written rather
 * than aliasing `LoopOptionsMap["mining"]` directly.
 */
export interface MiningLoopApiOptions {
	miningSystemId: string;
	beltPoiId: string;
	sellSystemId: string;
	sellStationPoiId: string;
	sellBaseId: string;
	fullThreshold?: number;
	maxAttempts?: number;
	repair?: boolean;
	depositTarget?: "personal" | "faction";
	skipMarket?: boolean;
	cashSource?: "faction";
	minCredits?: number;
	listPrice?: number;
	listPrices?: Record<string, number>;
	retryOnDepleted?: boolean;
	maxIterations?: number;
}

/**
 * Options for starting an enhanced mining loop via the API.
 *
 * Same `listPrices` narrowing rationale as {@link MiningLoopApiOptions} — kept
 * hand-written rather than aliasing `LoopOptionsMap["enhanced-mining"]`.
 */
export interface EnhancedMiningLoopApiOptions {
	miningSystemId: string;
	beltPoiId: string;
	sellSystemId: string;
	sellStationPoiId: string;
	sellBaseId: string;
	junkItemIds: string[];
	fullThreshold?: number;
	maxAttempts?: number;
	maxJettisonRounds?: number;
	repair?: boolean;
	depositTarget?: "personal" | "faction";
	skipMarket?: boolean;
	cashSource?: "faction";
	minCredits?: number;
	listPrice?: number;
	listPrices?: Record<string, number>;
	retryOnDepleted?: boolean;
	maxIterations?: number;
}

/**
 * Options for starting a trading loop via the API.
 *
 * Field-for-field this mirrors `@setpoint/protocol`'s `LoopOptionsMap["trading"]`,
 * but is kept hand-written: `items`' optional sub-fields (`maxQuantity`) come
 * back from zod typed as `T | undefined` rather than `T`, which
 * `exactOptionalPropertyTypes` treats as incompatible with the dispatcher
 * layer's own `TradingLoopOptions["items"]` shape (also `T`, no explicit
 * `undefined`). `handleStartLoop` validates via `loopSchemas.trading.parse()`
 * and casts the runtime-safe result to this type before calling
 * `startTradingLoop` — a JSON-parsed body never has a key present with an
 * explicit `undefined` value, so the cast reflects the real runtime shape.
 */
export interface TradingLoopApiOptions {
	buyStation: {
		systemId: string;
		poiId: string;
		baseId: string;
	};
	sellStation: {
		systemId: string;
		stationPoiId: string;
		baseId: string;
	};
	items: Array<{
		itemId: string;
		maxBuyPrice: number;
		minSellPrice: number;
		maxQuantity?: number;
	}>;
	refuel?: boolean;
	maxIterations?: number;
}

/**
 * Options for starting a hauling loop via the API.
 *
 * Kept hand-written for the same reason as {@link TradingLoopApiOptions} —
 * the nested `source.items`/`destination.items`/`destination.targetPlayer`
 * optional sub-fields don't survive the zod round-trip under
 * `exactOptionalPropertyTypes`.
 */
export interface HaulingLoopApiOptions {
	source: {
		systemId: string;
		poiId: string;
		baseId: string;
		type: "personal-storage" | "faction-storage" | "market";
		items: Array<{
			itemId: string;
			quantity?: number;
			maxPrice?: number;
		}>;
	};
	destination: {
		systemId: string;
		poiId: string;
		baseId: string;
		type: "personal-storage" | "faction-storage" | "gift" | "market";
		targetPlayer?: string;
		items?: Array<{
			itemId: string;
			minPrice?: number;
		}>;
	};
	refuel?: boolean;
	maxIterations?: number;
}

/**
 * Options for starting an exploration loop via the API.
 * Sourced from `@setpoint/protocol`'s `LoopOptionsMap` — the zod schema in
 * `loopSchemas.exploration` is the single source of truth for this shape.
 */
export type ExplorationLoopApiOptions = LoopOptionsMap["exploration"];

/**
 * Options for starting a salvage loop via the API.
 * Sourced from `@setpoint/protocol`'s `LoopOptionsMap` — the zod schema in
 * `loopSchemas.salvage` is the single source of truth for this shape.
 */
export type SalvageLoopApiOptions = LoopOptionsMap["salvage"];

/**
 * Options for starting a storage transfer loop via the API.
 * Sourced from `@setpoint/protocol`'s `LoopOptionsMap` — the zod schema in
 * `loopSchemas["storage-transfer"]` is the single source of truth for this shape.
 */
export type StorageTransferLoopApiOptions = LoopOptionsMap["storage-transfer"];

/**
 * Options for starting a roaming salvage loop via the API.
 * Sourced from `@setpoint/protocol`'s `LoopOptionsMap` — the zod schema in
 * `loopSchemas["roaming-salvage"]` is the single source of truth for this shape.
 */
export type RoamingSalvageLoopApiOptions = LoopOptionsMap["roaming-salvage"];

/**
 * Options for starting a guard loop via the API.
 * Sourced from `@setpoint/protocol`'s `LoopOptionsMap` — the zod schema in
 * `loopSchemas.guard` is the single source of truth for this shape.
 */
export type GuardLoopApiOptions = LoopOptionsMap["guard"];

/**
 * Options for starting a tow-salvage loop via the API.
 * Sourced from `@setpoint/protocol`'s `LoopOptionsMap` — the zod schema in
 * `loopSchemas["tow-salvage"]` is the single source of truth for this shape.
 */
export type TowSalvageLoopApiOptions = LoopOptionsMap["tow-salvage"];

/**
 * Manages active loops for accounts.
 *
 * Enforces one active loop per account. Tracks loop status and results.
 * Loops run as fire-and-forget promises; the manager tracks completion
 * and stores the final result.
 */
export class LoopManager {
	private readonly loops: Map<string, ActiveLoop> = new Map();
	private configDir: string | undefined;

	/** Set the config directory for loop persistence. */
	setConfigDir(dir: string): void {
		this.configDir = dir;
	}

	/** Check if an account has a running loop. */
	isRunning(playerId: string): boolean {
		const loop = this.loops.get(playerId);
		return loop !== undefined && loop.result === undefined;
	}

	/** Get the status of a loop for an account. */
	getStatus(playerId: string): LoopStatus | undefined {
		const loop = this.loops.get(playerId);
		if (!loop) {
			return undefined;
		}

		return {
			type: loop.type,
			startedAt: loop.startedAt,
			running: loop.result === undefined,
			...(loop.stepRef.last !== undefined ? { lastStep: loop.stepRef.last } : {}),
			...(loop.stepRef.lastAt !== undefined ? { lastStepAt: loop.stepRef.lastAt } : {}),
			...(loop.result !== undefined ? { result: loop.result } : {}),
			options: loop.options,
		};
	}

	/**
	 * Apply a partial options patch to a running loop.
	 *
	 * Mutates the live options object that the loop factory reads each iteration,
	 * so the change takes effect on the very next iteration without stopping the loop.
	 * Also updates the display/persistence copy and re-saves config to disk.
	 *
	 * The nested `loopOptions` control object (signal, maxIterations, etc.) is excluded
	 * from patches — those are wired into the loop engine at start and cannot change live.
	 *
	 * Returns the updated LoopStatus, or undefined if no loop is active.
	 */
	patchLoopOptions(playerId: string, patch: Record<string, unknown>): LoopStatus | undefined {
		const loop = this.loops.get(playerId);
		if (!loop || loop.result !== undefined) {
			return undefined;
		}

		// Apply patch to liveOptions (what the factory reads) and options (display/persistence).
		// Exclude loopOptions — those are wired into the loop engine at construction time.
		for (const [key, value] of Object.entries(patch)) {
			if (key === "loopOptions") continue;
			loop.liveOptions[key] = value;
			loop.options[key] = value;
		}

		log.info(
			`[${playerId}] Patched loop options: ${Object.keys(patch)
				.filter((k) => k !== "loopOptions")
				.join(", ")}`,
		);

		if (this.configDir) {
			this.saveLoopConfig(playerId, loop.type, loop.options, this.configDir).catch((err) => {
				log.warn(`[${playerId}] Failed to save patched loop config: ${errorMessage(err)}`);
			});
		}

		return this.getStatus(playerId);
	}

	/** Create a fresh ProgressRef for a new loop. */
	private createProgress(loopType: string, options: Record<string, unknown>): ProgressRef {
		return {
			goalType: loopType,
			goalOptions: options,
			completedSteps: [],
			remainingSteps: [],
		};
	}

	/** Get the progress ref for a running loop. */
	getProgress(playerId: string): ProgressRef | undefined {
		return this.loops.get(playerId)?.progress;
	}

	/** Get the active loop's promise (for awaiting completion on force abort). */
	getPromise(playerId: string): Promise<LoopResult> | undefined {
		const loop = this.loops.get(playerId);
		if (loop && loop.result === undefined) return loop.promise;
		return undefined;
	}

	/**
	 * Start a mining loop for an account.
	 *
	 * Throws if a loop is already running on this account.
	 */
	startMiningLoop(
		playerId: string,
		options: MiningLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		// Clean up any completed loop
		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: MiningLoopOptions = {
			miningSystemId: options.miningSystemId,
			beltPoiId: options.beltPoiId,
			sellSystemId: options.sellSystemId,
			sellStationPoiId: options.sellStationPoiId,
			sellBaseId: options.sellBaseId,
			...(options.fullThreshold !== undefined ? { fullThreshold: options.fullThreshold } : {}),
			...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
			...(options.repair !== undefined ? { repair: options.repair } : {}),
			...(options.depositTarget !== undefined ? { depositTarget: options.depositTarget } : {}),
			...(options.skipMarket !== undefined ? { skipMarket: options.skipMarket } : {}),
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
			...(options.listPrice !== undefined ? { listPrice: options.listPrice } : {}),
			...(options.listPrices !== undefined ? { listPrices: options.listPrices } : {}),
			...(options.retryOnDepleted !== undefined
				? { retryOnDepleted: options.retryOnDepleted }
				: {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(
			`[${playerId}] Starting mining loop: belt=${options.beltPoiId} → sell=${options.sellBaseId}`,
		);

		const activeLoop: ActiveLoop = {
			type: "mining",
			controller,
			promise: runMiningLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Mining");

		return {
			type: "mining",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start an enhanced mining loop for an account.
	 *
	 * Like mining loop but jettisons junk items to maximize valuable ore.
	 * Throws if a loop is already running on this account.
	 */
	startEnhancedMiningLoop(
		playerId: string,
		options: EnhancedMiningLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: EnhancedMiningLoopOptions = {
			miningSystemId: options.miningSystemId,
			beltPoiId: options.beltPoiId,
			sellSystemId: options.sellSystemId,
			sellStationPoiId: options.sellStationPoiId,
			sellBaseId: options.sellBaseId,
			junkItemIds: options.junkItemIds,
			...(options.fullThreshold !== undefined ? { fullThreshold: options.fullThreshold } : {}),
			...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
			...(options.maxJettisonRounds !== undefined
				? { maxJettisonRounds: options.maxJettisonRounds }
				: {}),
			...(options.repair !== undefined ? { repair: options.repair } : {}),
			...(options.depositTarget !== undefined ? { depositTarget: options.depositTarget } : {}),
			...(options.skipMarket !== undefined ? { skipMarket: options.skipMarket } : {}),
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
			...(options.listPrice !== undefined ? { listPrice: options.listPrice } : {}),
			...(options.listPrices !== undefined ? { listPrices: options.listPrices } : {}),
			...(options.retryOnDepleted !== undefined
				? { retryOnDepleted: options.retryOnDepleted }
				: {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(
			`[${playerId}] Starting enhanced mining loop: belt=${options.beltPoiId} → sell=${options.sellBaseId} (junk: ${options.junkItemIds.join(", ")})`,
		);

		const activeLoop: ActiveLoop = {
			type: "enhanced-mining",
			controller,
			promise: runEnhancedMiningLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Enhanced mining");

		return {
			type: "enhanced-mining",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start a salvage loop for an account.
	 *
	 * Loots wrecks at a salvage site until cargo full → sell at station → repeat.
	 * Throws if a loop is already running on this account.
	 */
	startSalvageLoop(
		playerId: string,
		options: SalvageLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: SalvageLoopOptions = {
			salvageSystemId: options.salvageSystemId,
			salvagePoiId: options.salvagePoiId,
			sellSystemId: options.sellSystemId,
			sellStationPoiId: options.sellStationPoiId,
			sellBaseId: options.sellBaseId,
			...(options.fullThreshold !== undefined ? { fullThreshold: options.fullThreshold } : {}),
			...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
			...(options.repair !== undefined ? { repair: options.repair } : {}),
			...(options.depositTarget !== undefined ? { depositTarget: options.depositTarget } : {}),
			...(options.skipMarket !== undefined ? { skipMarket: options.skipMarket } : {}),
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(
			`[${playerId}] Starting salvage loop: poi=${options.salvagePoiId} → sell=${options.sellBaseId}`,
		);

		const activeLoop: ActiveLoop = {
			type: "salvage",
			controller,
			promise: runSalvageLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Salvage");

		return {
			type: "salvage",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start a trading loop for an account.
	 *
	 * Buys items at one station under max prices, sells at another at min prices.
	 * Throws if a loop is already running on this account.
	 */
	startTradingLoop(
		playerId: string,
		options: TradingLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: TradingLoopOptions = {
			buyStation: options.buyStation,
			sellStation: options.sellStation,
			items: options.items,
			...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(
			`[${playerId}] Starting trading loop: buy@${options.buyStation.baseId} → sell@${options.sellStation.baseId}`,
		);

		const activeLoop: ActiveLoop = {
			type: "trading",
			controller,
			promise: runTradingLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Trading");

		return {
			type: "trading",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start a hauling loop for an account.
	 *
	 * Loads items at source station, unloads at destination, repeats.
	 * Throws if a loop is already running on this account.
	 */
	startHaulingLoop(
		playerId: string,
		options: HaulingLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: HaulingLoopOptions = {
			source: options.source,
			destination: options.destination,
			...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(
			`[${playerId}] Starting hauling loop: ${options.source.type}@${options.source.baseId} → ${options.destination.type}@${options.destination.baseId}`,
		);

		const activeLoop: ActiveLoop = {
			type: "hauling",
			controller,
			promise: runHaulingLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Hauling");

		return {
			type: "hauling",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start a storage transfer loop for an account.
	 *
	 * Transfers all items from personal storage to faction storage.
	 * Throws if a loop is already running on this account.
	 */
	startStorageTransferLoop(
		playerId: string,
		options: StorageTransferLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: StorageTransferLoopOptions = {
			systemId: options.systemId,
			stationPoiId: options.stationPoiId,
			baseId: options.baseId,
			...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
			...(options.excludeCredits !== undefined ? { excludeCredits: options.excludeCredits } : {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(`[${playerId}] Starting storage transfer loop: station=${options.baseId}`);

		const activeLoop: ActiveLoop = {
			type: "storage-transfer",
			controller,
			promise: runStorageTransferLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Storage transfer");

		return {
			type: "storage-transfer",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start an exploration loop for an account.
	 *
	 * Navigates to unvisited systems to contribute map intel.
	 * Requires the faction to have a Level 2 Intel Center.
	 * Throws if a loop is already running on this account.
	 */
	startExplorationLoop(
		playerId: string,
		options: ExplorationLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: ExplorationLoopOptions = {
			systemId: options.systemId,
			stationPoiId: options.stationPoiId,
			baseId: options.baseId,
			...(options.allowLawless !== undefined ? { allowLawless: options.allowLawless } : {}),
			...(options.minFuelReserve !== undefined ? { minFuelReserve: options.minFuelReserve } : {}),
			...(options.repairThreshold !== undefined
				? { repairThreshold: options.repairThreshold }
				: {}),
			...(options.survey !== undefined ? { survey: options.survey } : {}),
			...(options.minSubmittedAtTick !== undefined
				? { minSubmittedAtTick: options.minSubmittedAtTick }
				: {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(`[${playerId}] Starting exploration loop: home=${options.systemId}`);

		const activeLoop: ActiveLoop = {
			type: "exploration",
			controller,
			promise: runExplorationLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Exploration");

		return {
			type: "exploration",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start a guard loop for an account.
	 *
	 * Patrols a target POI and attacks pirates on sight, returning home to
	 * refuel and repair after each sweep.
	 * Throws if a loop is already running on this account.
	 */
	startGuardLoop(
		playerId: string,
		options: GuardLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: GuardLoopOptions = {
			homeSystemId: options.homeSystemId,
			homeStationPoiId: options.homeStationPoiId,
			homeBaseId: options.homeBaseId,
			guardSystemId: options.guardSystemId,
			guardPoiId: options.guardPoiId,
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
			...(options.repairThreshold !== undefined
				? { repairThreshold: options.repairThreshold }
				: {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(`[${playerId}] Starting guard loop: guard=${options.guardPoiId}`);

		const activeLoop: ActiveLoop = {
			type: "guard",
			controller,
			promise: runGuardLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Guard");

		return {
			type: "guard",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start a roaming salvage loop for an account.
	 *
	 * Sweeps through all empire systems via BFS, visiting each POI to loot wrecks.
	 * Returns home to deposit cargo and refuel when cargo is full or fuel is low.
	 * Restarts the sweep when all qualifying systems are visited.
	 * Throws if a loop is already running on this account.
	 */
	startRoamingSalvageLoop(
		playerId: string,
		options: RoamingSalvageLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}

		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);

		const stepRef: StepRef = { last: undefined, lastAt: undefined };
		const loopOptions: RoamingSalvageLoopOptions = {
			homeSystemId: options.homeSystemId,
			homeStationPoiId: options.homeStationPoiId,
			homeBaseId: options.homeBaseId,
			...(options.allowLawless !== undefined ? { allowLawless: options.allowLawless } : {}),
			...(options.fullThreshold !== undefined ? { fullThreshold: options.fullThreshold } : {}),
			...(options.minFuelReserve !== undefined ? { minFuelReserve: options.minFuelReserve } : {}),
			...(options.repair !== undefined ? { repair: options.repair } : {}),
			...(options.depositTarget !== undefined ? { depositTarget: options.depositTarget } : {}),
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
			...(options.maxLootAttempts !== undefined
				? { maxLootAttempts: options.maxLootAttempts }
				: {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(`[${playerId}] Starting roaming salvage loop: home=${options.homeSystemId}`);

		const activeLoop: ActiveLoop = {
			type: "roaming-salvage",
			controller,
			promise: runRoamingSalvageLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};

		this.trackLoop(playerId, activeLoop, "Roaming salvage");

		return {
			type: "roaming-salvage",
			startedAt: activeLoop.startedAt,
			running: true,
		};
	}

	/**
	 * Start a tow-salvage loop for an account.
	 *
	 * Tows wrecks from a fixed wreck POI to a salvage yard for processing.
	 * Throws if a loop is already running on this account.
	 */
	startTowSalvageLoop(
		playerId: string,
		options: TowSalvageLoopApiOptions,
		resolveAccount: () => LibManagedAccount,
	): LoopStatus {
		if (this.isRunning(playerId)) {
			throw new Error("A loop is already running on this account. Stop it first.");
		}
		this.loops.delete(playerId);

		const controller = new AbortController();
		const ctx = makeLibGoalContext(resolveAccount);
		const stepRef: StepRef = { last: undefined, lastAt: undefined };

		const loopOptions: TowSalvageLoopOptions = {
			mode: "fixed",
			yardSystemId: options.yardSystemId,
			yardPoiId: options.yardPoiId,
			yardBaseId: options.yardBaseId,
			wreckSystemId: options.wreckSystemId,
			wreckPoiId: options.wreckPoiId,
			...(options.disposition !== undefined ? { disposition: options.disposition } : {}),
			...(options.storageTarget !== undefined ? { storageTarget: options.storageTarget } : {}),
			loopOptions: {
				signal: controller.signal,
				onIterationComplete: (_iter, result) => recordStep(stepRef, result),
				...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
			},
		};

		log.info(
			`[${playerId}] Starting tow-salvage loop: wreck=${options.wreckPoiId} → yard=${options.yardBaseId}`,
		);

		const activeLoop: ActiveLoop = {
			type: "tow-salvage",
			controller,
			promise: runTowSalvageLoop(loopOptions, ctx),
			startedAt: new Date().toISOString(),
			stepRef,
			options: options as unknown as Record<string, unknown>,
			liveOptions: loopOptions as unknown as Record<string, unknown>,
		};
		this.trackLoop(playerId, activeLoop, "TowSalvage");
		return { type: "tow-salvage", startedAt: activeLoop.startedAt, running: true };
	}

	/** Track completion of an active loop and store the result. */
	private trackLoop(playerId: string, activeLoop: ActiveLoop, label: string): void {
		// Initialize progress ref from the loop's type and options
		activeLoop.progress = this.createProgress(activeLoop.type, activeLoop.options);
		const cleanup = (): void => {
			// Only delete the persisted config if this loop is still the active one.
			// If a replacement loop was started, its config should not be deleted.
			if (this.configDir && this.loops.get(playerId) === activeLoop) {
				this.deleteLoopConfig(playerId, this.configDir).catch((err) => {
					log.warn(`[${playerId}] Failed to delete loop config: ${errorMessage(err)}`);
				});
			}
		};

		activeLoop.promise
			.then((result) => {
				activeLoop.result = result;
				log.info(
					`[${playerId}] ${label} loop completed: ${result.iterationCount} iteration(s), ${result.ticksUsed} tick(s)`,
				);
				cleanup();
			})
			.catch((err) => {
				activeLoop.result = {
					success: false,
					message: `Loop error: ${errorMessage(err)}`,
					alreadySatisfied: false,
					ticksUsed: 0,
					iterations: [],
					iterationCount: 0,
				};
				log.error(`[${playerId}] ${label} loop error: ${errorMessage(err)}`);
				cleanup();
			});

		this.loops.set(playerId, activeLoop);
	}

	/**
	 * Signal a running loop to stop without waiting for it to finish.
	 *
	 * Sends abort signal and returns immediately. Cleanup (removing from the
	 * active loop map) happens in the background once the current step finishes.
	 * Returns true if a loop was found and signalled, false if no loop was running.
	 *
	 * Use this from HTTP handlers so the response is not held until the current
	 * game tick (up to 10s) completes.
	 */
	abortLoop(playerId: string): boolean {
		const loop = this.loops.get(playerId);
		if (!loop) {
			return false;
		}

		if (loop.result !== undefined) {
			// Already finished — clean up synchronously
			this.loops.delete(playerId);
			return true;
		}

		log.info(`[${playerId}] Stopping loop (non-blocking)...`);
		loop.controller.abort();
		loop.promise.finally(() => {
			this.loops.delete(playerId);
		});
		return true;
	}

	/**
	 * Abort a loop and immediately remove it from the active map.
	 *
	 * Unlike abortLoop() which waits for the promise to settle before removing,
	 * this method evicts the entry synchronously. Use this when starting a
	 * replacement loop so isRunning() returns false immediately.
	 *
	 * The old promise will still settle in the background — trackLoop's cleanup
	 * guards against deleting a replacement loop's config.
	 */
	forceRemove(playerId: string): void {
		const loop = this.loops.get(playerId);
		if (!loop) return;

		if (loop.result === undefined) {
			log.info(`[${playerId}] Force-removing running loop from map`);
			loop.controller.abort();
		}
		this.loops.delete(playerId);
	}

	/** Stop all running loops and wait for them to finish. */
	async stopAll(): Promise<void> {
		const promises: Promise<unknown>[] = [];
		for (const [playerId, loop] of this.loops) {
			if (loop.result === undefined) {
				this.abortLoop(playerId);
				promises.push(loop.promise.catch(() => {}));
			}
		}
		await Promise.all(promises);
	}

	// ── Persistence ──────────────────────────────────────────────────

	/** Save a loop config to disk so it can be auto-resumed on restart. */
	async saveLoopConfig(
		playerId: string,
		type: string,
		options: Record<string, unknown>,
		configDir: string,
	): Promise<void> {
		const loopsDir = join(configDir, "loops");
		await mkdir(loopsDir, { recursive: true });
		const filePath = join(loopsDir, `${playerId}.json`);
		await writeFile(filePath, JSON.stringify({ type, options }, null, 2), "utf-8");
		log.info(`[${playerId}] Saved loop config: ${type}`);
	}

	/** Delete a loop config from disk. */
	async deleteLoopConfig(playerId: string, configDir: string): Promise<void> {
		const filePath = join(configDir, "loops", `${playerId}.json`);
		try {
			await rm(filePath);
			log.info(`[${playerId}] Deleted loop config`);
		} catch {
			// File may not exist, that's fine
		}
	}

	/**
	 * Load all saved loop configs from disk.
	 * Returns an array of { playerId, type, options } for each saved config.
	 */
	static async loadLoopConfigs(
		configDir: string,
	): Promise<Array<{ playerId: string; type: string; options: Record<string, unknown> }>> {
		const loopsDir = join(configDir, "loops");
		let entries: string[];
		try {
			entries = await readdir(loopsDir);
		} catch {
			return []; // No loops directory = no saved loops
		}

		const configs: Array<{
			playerId: string;
			type: string;
			options: Record<string, unknown>;
		}> = [];

		for (const filename of entries) {
			if (!filename.endsWith(".json")) {
				continue;
			}

			const playerId = filename.replace(/\.json$/, "");
			try {
				const raw = await readFile(join(loopsDir, filename), "utf-8");
				const data = JSON.parse(raw) as Record<string, unknown>;
				const type = data["type"];
				const options = data["options"];

				if (typeof type !== "string" || typeof options !== "object" || options === null) {
					log.warn(`[${playerId}] Invalid loop config, skipping`);
					continue;
				}

				configs.push({
					playerId,
					type,
					options: options as unknown as Record<string, unknown>,
				});
			} catch (err) {
				log.warn(`[${playerId}] Failed to load loop config: ${errorMessage(err)}`);
			}
		}

		return configs;
	}

	/**
	 * Apply an ID migration mapping to all saved loop configs.
	 *
	 * Recursively walks every string value in each config and replaces any
	 * old ID found in the mapping with its new ID. Saves updated configs and
	 * returns a per-account change report.
	 */
	async migrateLoopConfigs(
		configDir: string,
		mapping: Record<string, string>,
	): Promise<
		Array<{
			playerId: string;
			changed: boolean;
			changes: Array<{ path: string; from: string; to: string }>;
		}>
	> {
		const configs = await LoopManager.loadLoopConfigs(configDir);
		const results: Array<{
			playerId: string;
			changed: boolean;
			changes: Array<{ path: string; from: string; to: string }>;
		}> = [];

		for (const { playerId, type, options } of configs) {
			const changes: Array<{ path: string; from: string; to: string }> = [];
			const migratedOptions = migrateJsonValue(options, mapping, "options", changes);

			results.push({ playerId, changed: changes.length > 0, changes });

			if (changes.length > 0) {
				await this.saveLoopConfig(
					playerId,
					type,
					migratedOptions as Record<string, unknown>,
					configDir,
				);
				log.info(`[${playerId}] Migrated loop config: ${changes.length} ID(s) updated`);
			}
		}

		return results;
	}
}
