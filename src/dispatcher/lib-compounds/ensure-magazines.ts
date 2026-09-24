import { errorMessage } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { ReconcileResult, ReconcileSubject } from "../goals.js";
import { reconciled } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import {
	type BatchReloadEntry,
	type BatchReloadOutcome,
	reloadWeapons,
} from "../lib-primitives/reload-weapon.js";

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

/** A gun that needs loading, waiting on the batch reload. */
interface PendingReload {
	weapon: WeaponModule;
	base: { id: string; kind: "weapon"; desired?: { ammo: number; ammoType: string } };
	entry: BatchReloadEntry;
}

/** A gun either already settled without a reload, or queued for one. */
type Plan = ReconcileSubject | PendingReload;

/**
 * Bring every ammo-fed gun on the ship to a full magazine.
 *
 * Works per module instance, not per weapon type: a hull carrying five of the
 * same railgun gets five subjects. Energy weapons are omitted from the result
 * entirely rather than padded in as trivially-satisfied rows, so
 * `summary.total` is the number of guns that can actually be loaded.
 *
 * Every gun that needs loading goes into one batch reload, so the whole ship
 * costs one tick rather than one per gun. Entries are ordered emptiest-first
 * and the game processes them in order, so a run that runs out of cases leaves
 * the ship in the best state the available ammo allowed rather than starving
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
		// Every gun is planned before anything is sent, so cases are handed out
		// here as they are assigned — one per reload — rather than each gun seeing
		// the whole hold and the batch promising more cases than exist.
		const casesLeft = new Map(
			(ctx.state.cargo ?? []).map((item) => [item.item_id, item.quantity] as const),
		);
		const plans = ordered.map((weapon) => this.plan(weapon, weapons, policy, casesLeft));

		const pending = plans.filter((p): p is PendingReload => "entry" in p);
		const settled = new Map<string, ReconcileSubject>();

		if (pending.length > 0 && ctx.signal?.aborted) {
			for (const p of pending) settled.set(p.weapon.module_id, this.abortedSubject(p.weapon));
			return reconciled(this.inOrder(plans, settled), 0);
		}

		let ticksUsed = 0;
		if (pending.length > 0) {
			try {
				const batch = await reloadWeapons(
					ctx,
					pending.map((p) => p.entry),
				);
				ticksUsed = batch.ticksUsed;
				await ctx.refreshState();
				for (const [i, p] of pending.entries()) {
					const outcome = batch.outcomes[i];
					settled.set(p.weapon.module_id, this.settle(ctx, p, outcome));
				}
			} catch (err) {
				// The whole call failed, so no gun can be assumed loaded. Every
				// pending gun reports the failure against the state it was seen in.
				log.warn(`Batch reload failed: ${errorMessage(err)}`);
				for (const p of pending) {
					settled.set(p.weapon.module_id, {
						...p.base,
						ok: false,
						action: "none",
						message: `reload_failed: ${errorMessage(err)}`,
						before: this.before(p.weapon),
					});
				}
			}
		}

		return reconciled(this.inOrder(plans, settled), ticksUsed);
	}

	/** Subjects in the emptiest-first order the guns were planned in. */
	private inOrder(plans: Plan[], settled: Map<string, ReconcileSubject>): ReconcileSubject[] {
		return plans.map((p) =>
			"entry" in p ? (settled.get(p.weapon.module_id) as ReconcileSubject) : p,
		);
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

	/**
	 * Decide what one gun needs, without touching the game: a finished subject
	 * when nothing should be sent, or the batch entry to send when it should.
	 */
	private plan(
		weapon: WeaponModule,
		weapons: WeaponModule[],
		policy: "always" | "half",
		casesLeft: Map<string, number>,
	): Plan {
		const shortfall = weapon.magazine_size - weapon.current_ammo;
		const desired = this.desiredAmmo(weapon, weapons);

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

		const cases = casesLeft.get(desired) ?? 0;
		if (cases <= 0) {
			return {
				...base,
				ok: false,
				action: "none",
				message: `insufficient_cargo: ${desired}`,
				before: this.before(weapon),
			};
		}

		casesLeft.set(desired, cases - 1);
		return { weapon, base, entry: { moduleId: weapon.module_id, ammoItemId: desired } };
	}

	/** Turn the game's verdict on one batch entry into that gun's subject. */
	private settle(
		ctx: LibGoalContext,
		pending: PendingReload,
		outcome: BatchReloadOutcome | undefined,
	): ReconcileSubject {
		const { weapon, base } = pending;

		if (outcome === undefined || !outcome.success) {
			const code = outcome === undefined ? "missing_result" : outcome.errorCode;
			// The game refuses a full magazine and spends nothing, so a gun that
			// filled between our read and the reload is already where we wanted it.
			if (code === "magazine_full") {
				return {
					...base,
					ok: true,
					action: "none",
					before: this.before(weapon),
					message: "already full",
				};
			}
			const detail = outcome === undefined || outcome.success ? "" : `: ${outcome.error}`;
			return {
				...base,
				ok: false,
				action: "none",
				message: `${code}${detail}`,
				before: this.before(weapon),
			};
		}

		// The batch result usually carries the new magazine, but fall back to the
		// refreshed cache rather than guess when it does not.
		const refreshed = this.ammoFedWeapons(ctx).find((w) => w.module_id === weapon.module_id);
		const ammo = outcome.currentAmmo ?? refreshed?.current_ammo ?? 0;
		const capacity = outcome.magazineSize ?? refreshed?.magazine_size ?? weapon.magazine_size;

		const after = {
			ammo,
			capacity,
			ammoType: outcome.ammoId,
			casesConsumed: 1,
			...(outcome.roundsDiscarded !== undefined
				? { roundsDiscarded: outcome.roundsDiscarded }
				: {}),
			name: outcome.weaponName,
		};

		if (ammo < capacity) {
			log.warn(`[${weapon.module_id}] Reload left magazine short: ${ammo}/${capacity}`);
			return {
				...base,
				ok: false,
				action: "updated",
				message: `magazine_short: ${ammo}/${capacity}`,
				before: this.before(weapon),
				after,
			};
		}

		return { ...base, ok: true, action: "updated", before: this.before(weapon), after };
	}
}
