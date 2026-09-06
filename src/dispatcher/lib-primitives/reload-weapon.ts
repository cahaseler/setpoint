import type { ReloadResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:reload-weapon");

/**
 * What one reload actually did, read off the game's own `ReloadResponse`
 * rather than inferred from state.
 *
 * `roundsDiscarded` is the reason this detail matters: a reload consumes a
 * whole case and bins whatever the magazine could not take, so topping up a
 * nearly-full gun destroys ammunition. Callers deciding whether a reload is
 * worth it need the number, not just a success flag.
 */
export interface ReloadOutcome {
	weaponId: string;
	weaponName: string;
	ammoId: string;
	ammoName: string;
	currentAmmo: number;
	magazineSize: number;
	roundsDiscarded: number;
	previousAmmo: string | undefined;
}

/**
 * Reload one weapon instance from cargo. Addresses the weapon by `module_id`,
 * never by `type_id` — a hull can carry several guns of the same type, and
 * reloading "the railgun" on a ship with five of them is how four of them end
 * up empty in a fight.
 *
 * One reload is one tick.
 */
export async function reloadWeapon(
	ctx: LibGoalContext,
	options: { moduleId: string; ammoItemId?: string },
): Promise<ReloadOutcome> {
	log.info(
		`Reloading weapon ${options.moduleId}${options.ammoItemId === undefined ? "" : ` with ${options.ammoItemId}`}`,
	);
	const response = await ctx.account.commands.spacemolt_battle.reload({
		id: options.moduleId,
		...(options.ammoItemId !== undefined ? { target: options.ammoItemId } : {}),
	});
	const details = response.delta.details as ReloadResponse | undefined;

	return {
		weaponId: details?.weapon_id ?? options.moduleId,
		weaponName: details?.weapon_name ?? options.moduleId,
		ammoId: details?.ammo_id ?? options.ammoItemId ?? "unknown",
		ammoName: details?.ammo_name ?? "unknown",
		currentAmmo: details?.current_ammo ?? 0,
		magazineSize: details?.magazine_size ?? 0,
		roundsDiscarded: details?.rounds_discarded ?? 0,
		previousAmmo: details?.previous_ammo,
	};
}

/** Reload a single weapon instance from cargo, addressed by `module_id`. */
export class LibReloadWeapon implements LibGoal {
	readonly name = "reload-weapon";

	constructor(private readonly options: { moduleId: string; ammoItemId?: string }) {}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		const weapon = (ctx.state.modules ?? []).find(
			(m) => (m as { module_id?: string }).module_id === this.options.moduleId,
		) as { magazine_size?: number; current_ammo?: number } | undefined;

		if (weapon === undefined) {
			return failed(`Weapon ${this.options.moduleId} is not installed`, 0);
		}
		if (weapon.magazine_size === undefined) {
			return failed(`Module ${this.options.moduleId} does not take ammo`, 0);
		}
		if ((weapon.current_ammo ?? 0) >= weapon.magazine_size) {
			return alreadySatisfied(
				`Weapon ${this.options.moduleId} already full (${weapon.current_ammo}/${weapon.magazine_size})`,
			);
		}

		const outcome = await reloadWeapon(ctx, this.options);
		const discarded =
			outcome.roundsDiscarded > 0 ? `, discarded ${outcome.roundsDiscarded} round(s)` : "";
		return succeeded(
			`Reloaded ${outcome.weaponName} with ${outcome.ammoName} (${outcome.currentAmmo}/${outcome.magazineSize}${discarded})`,
			1,
		);
	}
}
