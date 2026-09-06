import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { ReconcileResult, ReconcileSubject } from "../goals.js";
import { reconciled } from "../goals.js";
import type { LibGoalContext } from "../lib-goal-context.js";
import type { LibGoal } from "../lib-goal-context.js";
import { LibPrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:ensure-cargo");

export interface CargoBillLine {
	itemId: string;
	quantity: number;
}

export interface EnsureCargoOptions {
	systemId: string;
	poiId: string;
	baseId: string;
	/**
	 * The exact manifest the hold should end up holding.
	 *
	 * Order is priority. Capacity is only known live — armour plating reduces
	 * it, so a hold must be filled after modules are fitted, not before — and
	 * when it binds, earlier lines win and later ones fail rather than the goal
	 * silently loading a different mix than was asked for.
	 */
	items: CargoBillLine[];
	/** Where shortfalls are drawn from. Defaults to faction storage. */
	source?: "faction" | "personal";
	/** Where quantity over the bill goes. `"keep"` leaves it aboard. Defaults to the source. */
	surplusTo?: "faction" | "personal" | "keep";
	/** What to do with items in the hold that are not on the bill at all. Defaults to depositing them. */
	unlisted?: "deposit" | "keep";
}

interface HoldItem {
	itemId: string;
	quantity: number;
}

/**
 * Make the hold match a manifest exactly.
 *
 * `load-at-station` is additive and cannot express "and nothing else", which is
 * how a hold gets a logistics daemon's delivery pushed into it mid-refit. This
 * reconciles in both directions: shortfalls are drawn, surplus is deposited,
 * and anything not on the bill is cleared out unless the caller says otherwise.
 */
export class LibEnsureCargo implements LibGoal {
	readonly name = "ensure-cargo";

	constructor(private readonly options: EnsureCargoOptions) {}

	async execute(ctx: LibGoalContext): Promise<ReconcileResult> {
		const prepare = await new LibPrepareAtStation({
			systemId: this.options.systemId,
			poiId: this.options.poiId,
			baseId: this.options.baseId,
			refuel: false,
			repair: false,
		}).execute(ctx);

		if (!prepare.success) {
			return reconciled(
				[
					{
						id: "hold",
						kind: "item",
						ok: false,
						action: "none",
						message: `not_at_station: ${prepare.message}`,
						before: this.hold(ctx),
					},
				],
				prepare.ticksUsed,
			);
		}

		const usedBefore = this.cargoUsed(ctx);
		const capacity = this.capacity(ctx);
		const subjects: ReconcileSubject[] = [];
		let ticks = prepare.ticksUsed;

		// Clear anything not on the bill first — it frees space the bill may need.
		if ((this.options.unlisted ?? "deposit") === "deposit") {
			for (const item of this.unlistedItems(ctx)) {
				const outcome = await this.moveOut(ctx, item.itemId, item.quantity, this.surplusTarget());
				ticks += outcome.ticks;
				subjects.push(outcome.subject);
			}
		}

		for (const line of this.options.items) {
			const outcome = await this.reconcileLine(ctx, line);
			ticks += outcome.ticks;
			subjects.push(outcome.subject);
		}

		return reconciled(subjects, ticks, {
			context: {
				// Capacity is a fact about the ship, not about any one item.
				hold: { capacity, usedBefore, usedAfter: this.cargoUsed(ctx) },
			},
		});
	}

	private hold(ctx: LibGoalContext): Record<string, unknown> {
		return { inHold: this.cargoUsed(ctx), capacity: this.capacity(ctx) };
	}

	private capacity(ctx: LibGoalContext): number {
		return (ctx.state.ship as { cargo_capacity?: number } | undefined)?.cargo_capacity ?? 0;
	}

	private cargoUsed(ctx: LibGoalContext): number {
		return (ctx.state.ship as { cargo_used?: number } | undefined)?.cargo_used ?? 0;
	}

	private quantityInHold(ctx: LibGoalContext, itemId: string): number {
		return (ctx.state.cargo ?? []).find((c) => c.item_id === itemId)?.quantity ?? 0;
	}

	private unlistedItems(ctx: LibGoalContext): HoldItem[] {
		const billed = new Set(this.options.items.map((i) => i.itemId));
		return (ctx.state.cargo ?? [])
			.filter((c) => !billed.has(c.item_id) && c.quantity > 0)
			.map((c) => ({ itemId: c.item_id, quantity: c.quantity }));
	}

	private surplusTarget(): "faction" | "personal" {
		const surplus = this.options.surplusTo;
		if (surplus === "faction" || surplus === "personal") return surplus;
		return this.options.source ?? "faction";
	}

	private storageTarget(where: "faction" | "personal"): "faction" | "self" {
		return where === "faction" ? "faction" : "self";
	}

	private async reconcileLine(
		ctx: LibGoalContext,
		line: CargoBillLine,
	): Promise<{ subject: ReconcileSubject; ticks: number }> {
		const have = this.quantityInHold(ctx, line.itemId);
		const base = {
			id: line.itemId,
			kind: "item" as const,
			desired: { quantity: line.quantity },
		};

		if (have === line.quantity) {
			return {
				ticks: 0,
				subject: { ...base, ok: true, action: "none", before: { inHold: have } },
			};
		}

		if (have > line.quantity) {
			if (this.options.surplusTo === "keep") {
				return {
					ticks: 0,
					subject: {
						...base,
						ok: true,
						action: "none",
						before: { inHold: have },
						message: `surplus kept (${have - line.quantity} over)`,
					},
				};
			}
			const outcome = await this.moveOut(
				ctx,
				line.itemId,
				have - line.quantity,
				this.surplusTarget(),
			);
			return outcome;
		}

		// Short. Refuse before calling the game if there is physically no room —
		// cargo_full and insufficient_storage need opposite responses from a
		// caller (trim the bill vs restock the armoury), so they stay distinct.
		if (this.cargoUsed(ctx) >= this.capacity(ctx)) {
			return {
				ticks: 0,
				subject: {
					...base,
					ok: false,
					action: "none",
					message: "cargo_full",
					before: { inHold: have, ...this.hold(ctx) },
				},
			};
		}

		const shortfall = line.quantity - have;
		const source = this.options.source ?? "faction";
		log.info(`Drawing ${shortfall} ${line.itemId} from ${source} storage`);

		try {
			await ctx.account.commands.spacemolt_storage.withdraw({
				item_id: line.itemId,
				quantity: shortfall,
				target: this.storageTarget(source),
			});
		} catch (err) {
			const code = err instanceof SpacemoltError ? err.code : "unknown";
			const message = err instanceof SpacemoltError ? err.message : String(err);
			// The hold being full and the armoury being empty are different
			// problems; the game reports both here.
			const reason = /cargo|capacity|full|space/i.test(`${code} ${message}`)
				? "cargo_full"
				: `insufficient_storage: ${line.itemId}`;
			return {
				ticks: 1,
				subject: {
					...base,
					ok: false,
					action: "none",
					message: `${reason} (${code}: ${message})`,
					before: { inHold: have, ...this.hold(ctx) },
				},
			};
		}

		await ctx.refreshState({ force: true });
		const after = this.quantityInHold(ctx, line.itemId);
		const drawn = after - have;

		return {
			ticks: 1,
			subject:
				after === line.quantity
					? {
							...base,
							ok: true,
							action: "updated",
							before: { inHold: have },
							after: {
								inHold: after,
								drawn: source === "faction" ? { faction: drawn } : { personal: drawn },
							},
						}
					: {
							...base,
							ok: false,
							action: "updated",
							message: `insufficient_storage: ${line.itemId}`,
							before: { inHold: have, ...this.hold(ctx) },
							after: {
								inHold: after,
								drawn: source === "faction" ? { faction: drawn } : { personal: drawn },
							},
						},
		};
	}

	private async moveOut(
		ctx: LibGoalContext,
		itemId: string,
		quantity: number,
		where: "faction" | "personal",
	): Promise<{ subject: ReconcileSubject; ticks: number }> {
		const have = this.quantityInHold(ctx, itemId);
		const billed = this.options.items.find((i) => i.itemId === itemId);
		const base = {
			id: itemId,
			kind: "item" as const,
			...(billed !== undefined
				? { desired: { quantity: billed.quantity } }
				: { desired: { quantity: 0 } }),
		};

		log.info(`Depositing ${quantity} ${itemId} to ${where} storage`);
		try {
			await ctx.account.commands.spacemolt_storage.deposit({
				item_id: itemId,
				quantity,
				target: this.storageTarget(where),
			});
		} catch (err) {
			const message = err instanceof SpacemoltError ? `${err.code}: ${err.message}` : String(err);
			return {
				ticks: 1,
				subject: {
					...base,
					ok: false,
					action: "none",
					message: `deposit_failed (${message})`,
					before: { inHold: have },
				},
			};
		}

		await ctx.refreshState({ force: true });
		const after = this.quantityInHold(ctx, itemId);

		return {
			ticks: 1,
			subject: {
				...base,
				ok: true,
				action: billed === undefined ? "removed" : "updated",
				before: { inHold: have },
				after: { inHold: after, deposited: have - after, depositedTo: where },
			},
		};
	}
}
