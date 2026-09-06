import type { StorageResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, GoalResult, StepResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibEnsureEmptyCargo } from "../lib-primitives/ensure-empty-cargo.js";
import { LibPrepareAtStation } from "./prepare-at-station.js";

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
	/**
	 * Where removed modules go. Defaults to "faction" — a module left in
	 * personal storage is invisible to the next pilot's refit, so faction is
	 * the only default under which a squad can pass hardware between hulls.
	 */
	uninstalledStorage?: "personal" | "faction" | "cargo";
	/**
	 * Which half of the refit to run. Defaults to `"both"`.
	 *
	 * A module can only be on one hull at a time, so fitting hull B with a gun
	 * still bolted to hull A is impossible. Running `"strip"` across a whole
	 * squad and then `"fit"` across the same squad puts every module in storage
	 * before anything claims one, which is the only ordering that lets a squad
	 * swap hardware between ships.
	 */
	phase?: "strip" | "fit" | "both";
}

/** Module record from the game state modules array. */
type ModuleRecord = Record<string, unknown>;

/** View result — the union member returned by action=view (has an `items` array). */
type StorageViewResult = Extract<StorageResponse, { items: unknown }>;

/**
 * Ensure the ship has the exact desired module loadout and ammo configuration.
 *
 * Steps:
 * 1. PrepareAtStation — travel, dock, refuel
 * 2. EnsureEmptyCargo — deposit all cargo to personal storage
 * 3. Analyze current loadout vs desired
 * 4. Uninstall unwanted modules
 * 5. Source and install each desired module
 * 6. Cleanup — deposit remaining cargo to storage
 *
 * Ammo is deliberately NOT this goal's job: `ensure-magazines` owns magazine
 * loading. Two goals filling magazines with different semantics is how a
 * loadout could report success with four of five guns empty.
 */
export class LibEnsureLoadout implements LibGoal {
	readonly name = "ensure-loadout";
	private readonly options: EnsureLoadoutOptions;

	constructor(options: EnsureLoadoutOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		const stepResults: StepResult[] = [];
		let totalTicks = 0;

		// Step 1: PrepareAtStation
		const prepareGoal = new LibPrepareAtStation({
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
		await ctx.refreshState();

		// Step 2: EnsureEmptyCargo
		const emptyCargoGoal = new LibEnsureEmptyCargo();
		log.info("Step 2: Ensuring empty cargo");
		const emptyCargoResult = await emptyCargoGoal.execute(ctx);
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

		if (emptyCargoResult.ticksUsed > 0) {
			await ctx.refreshState();
		}

		// Step 3: Analyze current loadout using count-based comparison to handle duplicate module types
		const currentModules = this.getModules(ctx);

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

		const phase = this.options.phase ?? "both";
		const willUninstall = phase === "fit" ? [] : toUninstall;
		const willInstall = phase === "strip" ? [] : toInstall;

		if (willUninstall.length === 0 && willInstall.length === 0) {
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
			`Loadout analysis (phase ${phase}): ${willUninstall.length} to remove, ${willInstall.length} to install`,
			0,
		);
		stepResults.push({ goalName: "analyze-loadout", result: analyzeResult });

		// Step 4: Uninstall unwanted modules
		if (willUninstall.length > 0) {
			log.info(`Step 4: Uninstalling ${willUninstall.length} unwanted module(s)`);
			const uninstallResult = await this.uninstallModules(ctx, willUninstall);
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
			if (uninstallResult.ticksUsed > 0) {
				await ctx.refreshState();
			}
		}

		// Step 5: Source and install each desired module
		if (willInstall.length > 0) {
			log.info(`Step 5: Sourcing and installing ${willInstall.length} module(s)`);
			const installResult = await this.sourceAndInstallModules(ctx, willInstall);
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
			if (installResult.ticksUsed > 0) {
				await ctx.refreshState();
			}
		}

		// Step 6: Cleanup — deposit remaining cargo
		log.info("Step 6: Cleanup — depositing remaining cargo");
		const cleanupGoal = new LibEnsureEmptyCargo();
		const cleanupResult = await cleanupGoal.execute(ctx);
		stepResults.push({ goalName: "cleanup-cargo", result: cleanupResult });
		totalTicks += cleanupResult.ticksUsed;

		return this.buildResult(
			true,
			`Loadout configured (phase ${phase}): ${willUninstall.length} removed, ${willInstall.length} installed (${totalTicks} ticks). Magazines are not loaded — run ensure-magazines.`,
			totalTicks,
			stepResults,
		);
	}

	private getModules(ctx: LibGoalContext): ModuleRecord[] {
		return ctx.state.modules ?? [];
	}

	private async uninstallModules(
		ctx: LibGoalContext,
		modules: ModuleRecord[],
	): Promise<GoalResult> {
		let ticksUsed = 0;
		const messages: string[] = [];
		const storage = this.options.uninstalledStorage ?? "faction";

		for (const mod of modules) {
			// Check for external cancellation between modules — a loadout change can
			// touch many modules, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Uninstall aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			const moduleId = mod["module_id"] as string;
			const typeId = mod["type_id"] as string;

			log.info(`Uninstalling module: ${typeId} (${moduleId})`);
			await ctx.account.commands.spacemolt.uninstall_mod({ id: moduleId });
			ticksUsed++;
			await ctx.refreshState();

			// Deposit uninstalled module to configured storage (it's now in cargo)
			if (storage !== "cargo") {
				// Find the module in cargo by type_id
				const cargoItem = ctx.state.cargo?.find((item) => item.item_id === typeId);

				if (cargoItem) {
					await ctx.account.commands.spacemolt_storage.deposit({
						item_id: typeId,
						quantity: 1,
						target: storage === "faction" ? "faction" : "self",
					});
					ticksUsed++;
					await ctx.refreshState();
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
		ctx: LibGoalContext,
		typeIds: string[],
	): Promise<GoalResult> {
		let ticksUsed = 0;
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

			if (sourceResult.ticksUsed > 0) {
				await ctx.refreshState();
			}

			// Find the module in cargo to confirm it was sourced before installation
			const cargoItem = ctx.state.cargo?.find((item) => item.item_id === typeId);

			if (!cargoItem) {
				return failed(`Module ${typeId} not found in cargo after sourcing`, ticksUsed);
			}

			// Install from cargo — install_mod takes the item_id for modules in cargo
			log.info(`Installing module: ${typeId}`);
			await ctx.account.commands.spacemolt.install_mod({ id: typeId });
			ticksUsed++;
			await ctx.refreshState();

			messages.push(`${typeId}: sourced (${sourceResult.message}) → installed`);
		}

		return succeeded(`Installed ${typeIds.length} module(s): ${messages.join("; ")}`, ticksUsed);
	}

	/**
	 * Source an item into cargo from personal storage, faction storage, or market.
	 * Priority: personal → faction → market
	 */
	private async sourceItem(ctx: LibGoalContext, itemId: string): Promise<GoalResult> {
		// Check personal storage (free query)
		const personalStorage = await ctx.account.commands.spacemolt_storage.view({ target: "self" });
		const personalItems =
			(personalStorage.structuredContent as StorageViewResult | undefined)?.items ?? [];
		const personalItem = personalItems.find((item) => item.item_id === itemId);
		if (personalItem && personalItem.quantity > 0) {
			log.info(`Found ${itemId} in personal storage, withdrawing`);
			await ctx.account.commands.spacemolt_storage.withdraw({
				item_id: itemId,
				quantity: 1,
				target: "self",
			});
			return succeeded("personal storage", 1);
		}

		// Check faction storage (free query)
		const factionStorage = await ctx.account.commands.spacemolt_storage.view({
			target: "faction",
		});
		const factionItems =
			(factionStorage.structuredContent as StorageViewResult | undefined)?.items ?? [];
		const factionItem = factionItems.find((item) => item.item_id === itemId);
		if (factionItem && factionItem.quantity > 0) {
			log.info(`Found ${itemId} in faction storage, withdrawing`);
			await ctx.account.commands.spacemolt_storage.withdraw({
				item_id: itemId,
				quantity: 1,
				target: "faction",
			});
			return succeeded("faction storage", 1);
		}

		// Check market (free query) then buy
		const market = await ctx.account.commands.spacemolt_market.view_market({ item_id: itemId });
		const marketItems = market.structuredContent?.items ?? [];
		const marketItem = marketItems.find((item) => item.item_id === itemId);
		if (marketItem && (marketItem.sell_quantity ?? 0) > 0) {
			log.info(`Found ${itemId} on market, buying`);
			await ctx.account.commands.spacemolt.buy({ id: itemId, quantity: 1 });

			// Check if item ended up in cargo or was auto-delivered to storage
			const freshState = await ctx.refreshState();
			const inCargo = freshState.cargo?.find((item) => item.item_id === itemId);
			if (!inCargo) {
				// Cargo overflow — item went to storage, withdraw it
				log.info(`${itemId} not in cargo after buy (overflow), withdrawing from storage`);
				await ctx.account.commands.spacemolt_storage.withdraw({
					item_id: itemId,
					quantity: 1,
					target: "self",
				});
				return succeeded("market (overflow → storage)", 2);
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
