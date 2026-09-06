import { createLogger } from "../../util/logger.js";
import type { ReconcileResult, ReconcileSubject } from "../goals.js";
import { reconciled } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { reloadWeapon } from "../lib-primitives/reload-weapon.js";

const log = createLogger("goal:ensure-magazines");

export interface EnsureMagazinesOptions {
	/**
	 * `"always"` reloads any gun below capacity. `"half"` reloads only guns at
	 * or below half a magazine — a reload consumes a whole case and bins the
	 * balance, so topping up a nearly-full gun is a real loss. Threshold is on
	 * rounds, not cases: cases are the cost side, rounds are the value side.
	 */
	policy?: "always" | "half";
	/**
	 * Ammo to load, keyed by `module_id` (one specific gun) or `type_id` (every
	 * gun of that type). Omit to keep each gun on what it already has loaded.
	 */
	ammo?: Record<string, string>;
}

/** An installed module, narrowed to the fields this goal reads. */
interface WeaponModule {
	module_id: string;
	type_id: string;
	name: string;
	magazine_size: number;
	current_ammo: number;
	loaded_ammo_id: string | undefined;
}

/**
 * Bring every ammo-fed gun on the ship to a full magazine.
 *
 * Works per module instance, not per weapon type: a hull carrying five of the
 * same railgun gets five subjects and five reloads. Energy weapons are omitted
 * from the result entirely rather than padded in as trivially-satisfied rows,
 * so `summary.total` is the number of guns that can actually be loaded.
 *
 * Guns are filled emptiest-first, so a run that runs out of cases leaves the
 * ship in the best state the available ammo allowed rather than starving
 * whichever gun happened to sort last.
 */
export class LibEnsureMagazines implements LibGoal {
	readonly name = "ensure-magazines";

	constructor(private readonly options: EnsureMagazinesOptions = {}) {}

	async execute(ctx: LibGoalContext): Promise<ReconcileResult> {
		const policy = this.options.policy ?? "always";
		const weapons = this.ammoFedWeapons(ctx);

		if (weapons.length === 0) {
			return reconciled([], 0, { message: "No ammo-fed weapons installed" });
		}

		// Emptiest first: if cargo runs short, the guns that benefit most are the
		// ones that get fed.
		const ordered = [...weapons].sort((a, b) => a.current_ammo - b.current_ammo);

		const subjects: ReconcileSubject[] = [];
		let ticksUsed = 0;

		for (const weapon of ordered) {
			if (ctx.signal?.aborted) {
				subjects.push(this.abortedSubject(weapon));
				continue;
			}
			const subject = await this.reconcileWeapon(ctx, weapon, policy);
			if (subject.action === "updated") ticksUsed++;
			subjects.push(subject);
		}

		return reconciled(subjects, ticksUsed);
	}

	private ammoFedWeapons(ctx: LibGoalContext): WeaponModule[] {
		const modules = (ctx.state.modules ?? []) as Array<Record<string, unknown>>;
		const weapons: WeaponModule[] = [];
		for (const mod of modules) {
			// `magazine_size` is present only on weapons that consume ammo, so it
			// is the filter that excludes energy weapons and every non-weapon.
			const magazine = mod["magazine_size"];
			if (typeof magazine !== "number") continue;
			weapons.push({
				module_id: String(mod["module_id"]),
				type_id: String(mod["type_id"]),
				name: typeof mod["name"] === "string" ? mod["name"] : String(mod["type_id"]),
				magazine_size: magazine,
				current_ammo: typeof mod["current_ammo"] === "number" ? mod["current_ammo"] : 0,
				loaded_ammo_id:
					typeof mod["loaded_ammo_id"] === "string" ? mod["loaded_ammo_id"] : undefined,
			});
		}
		return weapons;
	}

	/**
	 * Which ammo this gun should be loaded with.
	 *
	 * Never guesses across ammo families: loading the wrong family bins the
	 * magazine. setpoint has no item catalog, so it cannot tell which cargo
	 * items are compatible with a given `ammo_type` — when the gun is empty and
	 * carries no hint, the goal fails the subject rather than picking something
	 * plausible out of the hold.
	 */
	private desiredAmmo(weapon: WeaponModule, weapons: WeaponModule[]): string | undefined {
		const explicit = this.options.ammo?.[weapon.module_id] ?? this.options.ammo?.[weapon.type_id];
		if (explicit !== undefined) return explicit;
		if (weapon.loaded_ammo_id !== undefined) return weapon.loaded_ammo_id;

		// An empty gun takes its cue from its loaded siblings of the same type,
		// but only when they agree.
		const siblingAmmo = new Set(
			weapons
				.filter((w) => w.type_id === weapon.type_id && w.loaded_ammo_id !== undefined)
				.map((w) => w.loaded_ammo_id as string),
		);
		return siblingAmmo.size === 1 ? [...siblingAmmo][0] : undefined;
	}

	private before(weapon: WeaponModule): Record<string, unknown> {
		return {
			ammo: weapon.current_ammo,
			capacity: weapon.magazine_size,
			ammoType: weapon.loaded_ammo_id ?? null,
			name: weapon.name,
		};
	}

	private abortedSubject(weapon: WeaponModule): ReconcileSubject {
		return {
			id: weapon.module_id,
			kind: "weapon",
			ok: false,
			action: "none",
			message: "aborted",
			before: this.before(weapon),
		};
	}

	private async reconcileWeapon(
		ctx: LibGoalContext,
		weapon: WeaponModule,
		policy: "always" | "half",
	): Promise<ReconcileSubject> {
		const shortfall = weapon.magazine_size - weapon.current_ammo;
		const desired = this.desiredAmmo(weapon, this.ammoFedWeapons(ctx));

		const base = {
			id: weapon.module_id,
			kind: "weapon" as const,
			...(desired !== undefined
				? { desired: { ammo: weapon.magazine_size, ammoType: desired } }
				: {}),
		};

		if (shortfall <= 0) {
			return { ...base, ok: true, action: "none", before: this.before(weapon) };
		}

		if (policy === "half" && weapon.current_ammo > Math.floor(weapon.magazine_size / 2)) {
			return {
				...base,
				ok: true,
				action: "none",
				before: this.before(weapon),
				message: `above half, reload would discard ${shortfall} round(s)`,
			};
		}

		if (desired === undefined) {
			return {
				...base,
				ok: false,
				action: "none",
				message: "ambiguous_ammo",
				before: this.before(weapon),
			};
		}

		const inCargo = (ctx.state.cargo ?? []).find((item) => item.item_id === desired);
		if (inCargo === undefined || inCargo.quantity <= 0) {
			return {
				...base,
				ok: false,
				action: "none",
				message: `insufficient_cargo: ${desired}`,
				before: this.before(weapon),
			};
		}

		const outcome = await reloadWeapon(ctx, { moduleId: weapon.module_id, ammoItemId: desired });
		await ctx.refreshState();

		const after = {
			ammo: outcome.currentAmmo,
			capacity: outcome.magazineSize,
			ammoType: outcome.ammoId,
			casesConsumed: 1,
			roundsDiscarded: outcome.roundsDiscarded,
			name: outcome.weaponName,
		};

		if (outcome.currentAmmo < outcome.magazineSize) {
			log.warn(
				`[${weapon.module_id}] Reload left magazine short: ${outcome.currentAmmo}/${outcome.magazineSize}`,
			);
			return {
				...base,
				ok: false,
				action: "updated",
				message: `magazine_short: ${outcome.currentAmmo}/${outcome.magazineSize}`,
				before: this.before(weapon),
				after,
			};
		}

		return { ...base, ok: true, action: "updated", before: this.before(weapon), after };
	}
}
