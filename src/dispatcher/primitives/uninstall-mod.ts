import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:uninstall-mod");

export interface UninstallModOptions {
	moduleId: string;
}

/**
 * Uninstall a module from the current ship.
 *
 * Already satisfied if the module is not installed.
 * Prerequisites: must be docked at a station.
 */
export class UninstallMod implements Goal {
	readonly name = "uninstall-mod";
	private readonly options: UninstallModOptions;

	constructor(options: UninstallModOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot uninstall mod: must be docked at a station", 0);
		}

		// Check if actually installed
		const modules = ctx.state.modules;
		if (modules && Array.isArray(modules)) {
			const installed = modules.find(
				(m: Record<string, unknown>) => m["module_id"] === this.options.moduleId,
			);
			if (!installed) {
				return alreadySatisfied(`Module ${this.options.moduleId} is not installed`);
			}
		}

		log.info(`Uninstalling module: ${this.options.moduleId}`);
		const response = await ctx.endpoints.uninstallMod(this.options.moduleId);
		const result = response.structuredContent;

		const destroyedMsg = result.destroyed ? " (destroyed on removal)" : "";
		log.info(`Uninstalled module ${result.module_id}${destroyedMsg}`);

		return succeeded(`Uninstalled module ${result.module_id}${destroyedMsg}`, 1);
	}
}
