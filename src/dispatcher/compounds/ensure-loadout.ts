import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext, GoalResult, StepResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import { EnsureEmptyCargo } from "../primitives/index.js";
import { PrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:ensure-loadout");

/** Options for the EnsureLoadout compound goal. */
export interface EnsureLoadoutOptions {
	/** Target system ID to navigate to. */
	systemId: string;
	/** Target POI ID within the system (the station's POI). */
	poiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Module type_ids to have installed. */
	modules: string[];
	/** Map of weapon type_id to ammo item_id. */
	ammo?: Record<string, string>;
	/** Where removed modules go. Defaults to "personal". */
	uninstalledStorage?: "personal" | "faction" | "cargo";
}

/** Module record from the game state modules array. */
interface ModuleRecord {
	module_id?: string;
	type_id?: string;
	type?: string;
	name?: string;
	[key: string]: unknown;
}

/**
 * Ensure the ship has the exact desired module loadout and ammo configuration.
 *
 * Steps:
 * 1. PrepareAtStation — travel, dock, refuel
 * 2. EnsureEmptyCargo — deposit all cargo to personal storage
 * 3. Analyze current loadout vs desired
 * 4. Uninstall unwanted modules
 * 5. Source and install each desired module
 * 6. Source and load ammo
 * 7. Cleanup — deposit remaining cargo to personal storage
 */
export class EnsureLoadout implements Goal {
	readonly name = "ensure-loadout";
	private readonly options: EnsureLoadoutOptions;

	constructor(options: EnsureLoadoutOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		const stepResults: StepResult[] = [];
		let totalTicks = 0;

		// Step 1: PrepareAtStation
		const prepareGoal = new PrepareAtStation({
			systemId: this.options.systemId,
			poiId: this.options.poiId,
			baseId: this.options.baseId,
		});

		log.info("Step 1: Preparing at station");
		const prepareResult = await prepareGoal.execute(ctx);
		stepResults.push({ goalName: "prepare-at-station", result: prepareResult });
		totalTicks += prepareResult.ticksUsed;
		if (!prepareResult.success) {
			return this.buildResult(
				false,
				`Failed at prepare-at-station: ${prepareResult.message}`,
				totalTicks,
				stepResults,
			);
		}

		// Refresh state after prepare
		let state = ctx.refreshState ? await ctx.refreshState() : ctx.state;

		// Step 2: EnsureEmptyCargo
		const emptyCargoGoal = new EnsureEmptyCargo();
		log.info("Step 2: Ensuring empty cargo");
		const emptyCargoResult = await emptyCargoGoal.execute({
			endpoints: ctx.endpoints,
			state,
			...(ctx.refreshState ? { refreshState: ctx.refreshState } : {}),
		});
		stepResults.push({ goalName: "ensure-empty-cargo", result: emptyCargoResult });
		totalTicks += emptyCargoResult.ticksUsed;
		if (!emptyCargoResult.success) {
			return this.buildResult(
				false,
				`Failed at ensure-empty-cargo: ${emptyCargoResult.message}`,
				totalTicks,
				stepResults,
			);
		}

		if (emptyCargoResult.ticksUsed > 0 && ctx.refreshState) {
			state = await ctx.refreshState();
		}

		// Step 3: Analyze current loadout using count-based comparison to handle duplicate module types
		const currentModules = this.getModules(state);

		const desiredCounts = new Map<string, number>();
		for (const typeId of this.options.modules) {
			desiredCounts.set(typeId, (desiredCounts.get(typeId) ?? 0) + 1);
		}

		// Decide which installed modules to keep vs uninstall (excess beyond desired count)
		const keepCounts = new Map<string, number>();
		const toUninstall: ModuleRecord[] = [];
		for (const mod of currentModules) {
			const typeId = mod["type_id"] as string;
			const desired = desiredCounts.get(typeId) ?? 0;
			const kept = keepCounts.get(typeId) ?? 0;
			if (kept < desired) {
				keepCounts.set(typeId, kept + 1);
			} else {
				toUninstall.push(mod);
			}
		}

		// Build install list: for each type, add (desired - kept) entries
		const toInstall: string[] = [];
		for (const [typeId, desired] of desiredCounts) {
			const kept = keepCounts.get(typeId) ?? 0;
			for (let i = 0; i < desired - kept; i++) {
				toInstall.push(typeId);
			}
		}

		// Check if already satisfied (no ammo changes needed either)
		const ammoEntries = Object.entries(this.options.ammo ?? {});
		if (toUninstall.length === 0 && toInstall.length === 0 && ammoEntries.length === 0) {
			const satisfiedResult = alreadySatisfied("Loadout already matches desired configuration");
			stepResults.push({ goalName: "analyze-loadout", result: satisfiedResult });
			return this.buildResult(
				true,
				satisfiedResult.message,
				totalTicks,
				stepResults,
				totalTicks === 0,
			);
		}

		const analyzeResult = succeeded(
			`Loadout analysis: ${toUninstall.length} to remove, ${toInstall.length} to install, ${ammoEntries.length} ammo to load`,
			0,
		);
		stepResults.push({ goalName: "analyze-loadout", result: analyzeResult });

		// Step 4: Uninstall unwanted modules
		if (toUninstall.length > 0) {
			log.info(`Step 4: Uninstalling ${toUninstall.length} unwanted module(s)`);
			const uninstallResult = await this.uninstallModules(ctx, toUninstall, state);
			stepResults.push({ goalName: "uninstall-unwanted", result: uninstallResult });
			totalTicks += uninstallResult.ticksUsed;
			if (!uninstallResult.success) {
				return this.buildResult(
					false,
					`Failed at uninstall: ${uninstallResult.message}`,
					totalTicks,
					stepResults,
				);
			}
			if (uninstallResult.ticksUsed > 0 && ctx.refreshState) {
				state = await ctx.refreshState();
			}
		}

		// Step 5: Source and install each desired module
		if (toInstall.length > 0) {
			log.info(`Step 5: Sourcing and installing ${toInstall.length} module(s)`);
			const installResult = await this.sourceAndInstallModules(ctx, toInstall, state);
			stepResults.push({ goalName: "source-and-install", result: installResult });
			totalTicks += installResult.ticksUsed;
			if (!installResult.success) {
				return this.buildResult(
					false,
					`Failed at install: ${installResult.message}`,
					totalTicks,
					stepResults,
				);
			}
			if (installResult.ticksUsed > 0 && ctx.refreshState) {
				state = await ctx.refreshState();
			}
		}

		// Step 6: Source and load ammo
		if (ammoEntries.length > 0) {
			log.info(`Step 6: Loading ammo for ${ammoEntries.length} weapon(s)`);
			const ammoResult = await this.sourceAndLoadAmmo(ctx, ammoEntries, state);
			stepResults.push({ goalName: "load-ammo", result: ammoResult });
			totalTicks += ammoResult.ticksUsed;
			if (!ammoResult.success) {
				return this.buildResult(
					false,
					`Failed at ammo loading: ${ammoResult.message}`,
					totalTicks,
					stepResults,
				);
			}
			if (ammoResult.ticksUsed > 0 && ctx.refreshState) {
				state = await ctx.refreshState();
			}
		}

		// Step 7: Cleanup — deposit remaining cargo
		log.info("Step 7: Cleanup — depositing remaining cargo");
		const cleanupGoal = new EnsureEmptyCargo();
		const cleanupResult = await cleanupGoal.execute({
			endpoints: ctx.endpoints,
			state,
			...(ctx.refreshState ? { refreshState: ctx.refreshState } : {}),
		});
		stepResults.push({ goalName: "cleanup-cargo", result: cleanupResult });
		totalTicks += cleanupResult.ticksUsed;

		return this.buildResult(
			true,
			`Loadout configured: ${toUninstall.length} removed, ${toInstall.length} installed, ${ammoEntries.length} ammo loaded (${totalTicks} ticks)`,
			totalTicks,
			stepResults,
		);
	}

	private getModules(state: GoalContext["state"]): ModuleRecord[] {
		const modules = state.modules;
		if (!modules || !Array.isArray(modules)) {
			return [];
		}
		return modules as ModuleRecord[];
	}

	private async uninstallModules(
		ctx: GoalContext,
		modules: ModuleRecord[],
		initialState: GoalContext["state"],
	): Promise<GoalResult> {
		let ticksUsed = 0;
		const messages: string[] = [];
		let state = initialState;
		const storage = this.options.uninstalledStorage ?? "personal";

		for (const mod of modules) {
			// Check for external cancellation between modules — a loadout change can
			// touch many modules, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Uninstall aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			const moduleId = mod["module_id"] as string;
			const typeId = mod["type_id"] as string;

			log.info(`Uninstalling module: ${typeId} (${moduleId})`);
			const response = await ctx.endpoints.uninstallMod(moduleId);
			ticksUsed++;

			if (ctx.refreshState) {
				state = await ctx.refreshState();
			}

			const result = response.structuredContent;
			if (result.destroyed) {
				log.warn(`Module ${typeId} (${moduleId}) was destroyed on removal`);
				messages.push(`${typeId}: destroyed on removal`);
				continue;
			}

			// Deposit uninstalled module to configured storage (it's now in cargo)
			if (storage !== "cargo") {
				// Find the module in cargo by type_id
				const cargo = state.cargo ?? [];
				const cargoItem = cargo.find((item: Record<string, unknown>) => item["item_id"] === typeId);

				if (cargoItem) {
					if (storage === "faction") {
						await ctx.endpoints.depositToFactionStorage(typeId, 1);
					} else {
						await ctx.endpoints.depositToStorage(typeId, 1);
					}
					ticksUsed++;
					if (ctx.refreshState) {
						state = await ctx.refreshState();
					}
					messages.push(`${typeId}: uninstalled → ${storage} storage`);
				} else {
					messages.push(`${typeId}: uninstalled (not found in cargo, may have been auto-stored)`);
				}
			} else {
				messages.push(`${typeId}: uninstalled → cargo`);
			}
		}

		return succeeded(`Uninstalled ${modules.length} module(s): ${messages.join("; ")}`, ticksUsed);
	}

	private async sourceAndInstallModules(
		ctx: GoalContext,
		typeIds: string[],
		initialState: GoalContext["state"],
	): Promise<GoalResult> {
		let ticksUsed = 0;
		let state = initialState;
		const messages: string[] = [];

		for (const typeId of typeIds) {
			// Check for external cancellation between modules — a loadout change can
			// touch many modules, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Install aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			// Source the module into cargo
			const sourceResult = await this.sourceItem(ctx, typeId);
			ticksUsed += sourceResult.ticksUsed;

			if (!sourceResult.success) {
				return failed(sourceResult.message, ticksUsed);
			}

			if (sourceResult.ticksUsed > 0 && ctx.refreshState) {
				state = await ctx.refreshState();
			}

			// Find the module in cargo to get its instance for installation
			const cargo = state.cargo ?? [];
			const cargoItem = cargo.find((item: Record<string, unknown>) => item["item_id"] === typeId);

			if (!cargoItem) {
				return failed(`Module ${typeId} not found in cargo after sourcing`, ticksUsed);
			}

			// Install from cargo — installMod takes item_id for modules in cargo
			log.info(`Installing module: ${typeId}`);
			await ctx.endpoints.installMod(typeId);
			ticksUsed++;

			if (ctx.refreshState) {
				state = await ctx.refreshState();
			}

			messages.push(`${typeId}: sourced (${sourceResult.message}) → installed`);
		}

		return succeeded(`Installed ${typeIds.length} module(s): ${messages.join("; ")}`, ticksUsed);
	}

	private async sourceAndLoadAmmo(
		ctx: GoalContext,
		ammoEntries: [string, string][],
		initialState: GoalContext["state"],
	): Promise<GoalResult> {
		let ticksUsed = 0;
		let state = initialState;
		const messages: string[] = [];

		for (const [weaponTypeId, ammoItemId] of ammoEntries) {
			// Check for external cancellation between weapons — a loadout change can
			// touch many weapons, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Ammo loading aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			// Find the installed weapon by type_id
			const modules = this.getModules(state);
			const weapon = modules.find((m) => (m["type_id"] as string) === weaponTypeId);

			if (!weapon) {
				return failed(`Cannot load ammo: weapon type ${weaponTypeId} is not installed`, ticksUsed);
			}

			const weaponModuleId = weapon["module_id"] as string;

			// Source ammo into cargo
			const sourceResult = await this.sourceItem(ctx, ammoItemId);
			ticksUsed += sourceResult.ticksUsed;

			if (!sourceResult.success) {
				return failed(sourceResult.message, ticksUsed);
			}

			if (sourceResult.ticksUsed > 0 && ctx.refreshState) {
				state = await ctx.refreshState();
			}

			// Reload the weapon
			log.info(`Reloading weapon ${weaponTypeId} (${weaponModuleId}) with ${ammoItemId}`);
			await ctx.endpoints.reload(weaponModuleId, ammoItemId);
			ticksUsed++;

			if (ctx.refreshState) {
				state = await ctx.refreshState();
			}

			messages.push(`${weaponTypeId} ← ${ammoItemId}`);
		}

		return succeeded(
			`Loaded ammo for ${ammoEntries.length} weapon(s): ${messages.join("; ")}`,
			ticksUsed,
		);
	}

	/**
	 * Source an item into cargo from personal storage, faction storage, or market.
	 * Priority: personal → faction → market
	 */
	private async sourceItem(ctx: GoalContext, itemId: string): Promise<GoalResult> {
		// Check personal storage (free query)
		const personalStorage = await ctx.endpoints.viewStorage();
		const personalItem = personalStorage.structuredContent.items?.find(
			(item) => item.item_id === itemId,
		);
		if (personalItem && personalItem.quantity > 0) {
			log.info(`Found ${itemId} in personal storage, withdrawing`);
			await ctx.endpoints.withdrawFromStorage(itemId, 1);
			return succeeded("personal storage", 1);
		}

		// Check faction storage (free query)
		const factionStorage = await ctx.endpoints.viewFactionStorage();
		const factionItem = factionStorage.structuredContent.items?.find(
			(item) => item.item_id === itemId,
		);
		if (factionItem && factionItem.quantity > 0) {
			log.info(`Found ${itemId} in faction storage, withdrawing`);
			await ctx.endpoints.withdrawFromFactionStorage(itemId, 1);
			return succeeded("faction storage", 1);
		}

		// Check market (free query) then buy
		const market = await ctx.endpoints.viewMarket(itemId);
		const marketItems = (market.structuredContent.items ?? []) as Array<{
			item_id: string;
			sell_quantity?: number;
		}>;
		const marketItem = marketItems.find((item) => item.item_id === itemId);
		if (marketItem && (marketItem.sell_quantity ?? 0) > 0) {
			log.info(`Found ${itemId} on market, buying`);
			await ctx.endpoints.buy(itemId, 1);

			// Check if item ended up in cargo or was auto-delivered to storage
			if (ctx.refreshState) {
				const freshState = await ctx.refreshState();
				const cargo = freshState.cargo ?? [];
				const inCargo = cargo.find((item: Record<string, unknown>) => item["item_id"] === itemId);
				if (!inCargo) {
					// Cargo overflow — item went to storage, withdraw it
					log.info(`${itemId} not in cargo after buy (overflow), withdrawing from storage`);
					await ctx.endpoints.withdrawFromStorage(itemId, 1);
					return succeeded("market (overflow → storage)", 2);
				}
			}

			return succeeded("market", 1);
		}

		return failed(
			`Could not source ${itemId}: not in personal storage, faction storage, or market`,
			0,
		);
	}

	private buildResult(
		success: boolean,
		message: string,
		ticksUsed: number,
		steps: StepResult[],
		isAlreadySatisfied = false,
	): CompoundGoalResult {
		return {
			success,
			message,
			alreadySatisfied: isAlreadySatisfied,
			ticksUsed,
			steps,
		};
	}
}
