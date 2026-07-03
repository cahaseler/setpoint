import type { InstallModResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:install-mod");

export interface InstallModOptions {
	moduleId: string;
}

/**
 * Install a module on the current ship.
 *
 * Already satisfied if the module is already installed.
 * Prerequisites: must be docked at a station.
 */
export class LibInstallMod implements LibGoal {
	readonly name = "install-mod";
	private readonly options: InstallModOptions;

	constructor(options: InstallModOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot install mod: must be docked at a station", 0);
		}

		// Check if already installed
		const modules = ctx.state.modules;
		if (modules && Array.isArray(modules)) {
			const installed = modules.find(
				(m: Record<string, unknown>) => m["module_id"] === this.options.moduleId,
			);
			if (installed) {
				return alreadySatisfied(`Module ${this.options.moduleId} is already installed`);
			}
		}

		log.info(`Installing module: ${this.options.moduleId}`);
		const response = await ctx.account.commands.spacemolt.install_mod({
			id: this.options.moduleId,
		});
		const result = response.delta.details as InstallModResponse | undefined;

		log.info(
			`Installed module ${result?.module_id} (CPU: ${result?.cpu_used}, power: ${result?.power_used})`,
		);

		return succeeded(`Installed module ${result?.module_id}`, 1);
	}
}
