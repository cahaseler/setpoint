import type { BulkReloadResponse, ReloadResponse } from "@spacemolt/lib";
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

/** The most weapons the game accepts in one batch reload. */
export const MAX_BATCH_RELOAD = 50;

/** One gun to load in a batch reload, addressed by `module_id`. */
export interface BatchReloadEntry {
	moduleId: string;
	ammoItemId: string;
}

/**
 * What the game did with one entry of a batch reload. Entries succeed or fail
 * independently, so a batch is never all-or-nothing.
 *
 * `roundsDiscarded` is `undefined`, not `0`, when the game did not report it —
 * batch results omit it, and a zero would claim nothing was wasted.
 */
export type BatchReloadOutcome =
	| {
			moduleId: string;
			success: true;
			ammoId: string;
			ammoName: string;
			weaponName: string;
			currentAmmo: number | undefined;
			magazineSize: number | undefined;
			roundsDiscarded: number | undefined;
	  }
	| {
			moduleId: string;
			success: false;
			errorCode: string;
			error: string;
	  };

/**
 * Reload many weapon instances in one action. The game loads up to
 * `MAX_BATCH_RELOAD` guns in a single tick, where `reloadWeapon` spends a tick
 * per gun; longer lists are sent in consecutive batches of that size.
 *
 * Entries are processed in the order given, so a caller that wants scarce
 * ammunition to go to particular guns first should order them that way.
 *
 * Outcomes come back in the same order as `entries`. The per-gun results live
 * under the mutation's `details`, not in the state delta, and are matched back
 * by their `index` rather than by position so a short or reordered response
 * cannot attribute one gun's result to another. An entry the response does
 * not mention is reported as failed rather than assumed loaded.
 */
export async function reloadWeapons(
	ctx: LibGoalContext,
	entries: BatchReloadEntry[],
): Promise<{ outcomes: BatchReloadOutcome[]; ticksUsed: number }> {
	const outcomes: BatchReloadOutcome[] = [];
	let ticksUsed = 0;

	for (let start = 0; start < entries.length; start += MAX_BATCH_RELOAD) {
		const chunk = entries.slice(start, start + MAX_BATCH_RELOAD);
		log.info(
			`Batch reloading ${chunk.length} weapon(s): ${chunk.map((e) => `${e.moduleId}←${e.ammoItemId}`).join(", ")}`,
		);
		// The game takes `{weapon_instance_id, ammo_item_id}` objects, but
		// @spacemolt/lib 15.0.0 types this parameter as `string[]` on `commands`
		// (and as `unknown[]` in its OpenAPI types) — its command generator loses
		// the element schema. The shape is therefore checked here, at the one
		// place it is built, and cast past the wrong declaration.
		const weapons: Array<{ weapon_instance_id: string; ammo_item_id: string }> = chunk.map((e) => ({
			weapon_instance_id: e.moduleId,
			ammo_item_id: e.ammoItemId,
		}));
		const response = await ctx.account.commands.spacemolt_battle.reload({
			weapons: weapons as unknown as string[],
		});
		ticksUsed++;

		const details = response.delta.details as BulkReloadResponse | undefined;
		const byIndex = new Map((details?.results ?? []).map((r) => [r.index, r]));

		for (const [offset, entry] of chunk.entries()) {
			const result = byIndex.get(offset);
			if (result === undefined) {
				outcomes.push({
					moduleId: entry.moduleId,
					success: false,
					errorCode: "missing_result",
					error: "the batch response did not report this weapon",
				});
			} else if (!result.success) {
				outcomes.push({
					moduleId: entry.moduleId,
					success: false,
					errorCode: result.error_code ?? "unknown",
					error: result.error ?? "reload failed",
				});
			} else {
				outcomes.push({
					moduleId: entry.moduleId,
					success: true,
					ammoId: result.result?.ammo_id ?? entry.ammoItemId,
					ammoName: result.result?.ammo_name ?? entry.ammoItemId,
					weaponName: result.result?.weapon_name ?? entry.moduleId,
					currentAmmo: result.result?.current_ammo,
					magazineSize: result.result?.magazine_size,
					roundsDiscarded: result.result?.rounds_discarded,
				});
			}
		}
	}

	return { outcomes, ticksUsed };
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
