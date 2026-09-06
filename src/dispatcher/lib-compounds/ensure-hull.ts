import type { ListShipsResponse, SwitchShipResponse } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { ReconcileResult, ReconcileSubject } from "../goals.js";
import { reconciled } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibPrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:ensure-hull");

export interface EnsureHullOptions {
	systemId: string;
	poiId: string;
	baseId: string;
	/** Exact hull to fly, by ship uuid. Takes precedence over `shipClass`. */
	shipId?: string;
	/** Any stored hull of this class will do. */
	shipClass?: string;
	/**
	 * Where to look for the hull. Omit to try personal storage first, then the
	 * faction garage. A hull sitting on another account is not reachable here —
	 * gift it across first, then claim it from `"personal"`.
	 */
	source?: "personal" | "garage";
}

interface Candidate {
	shipId: string;
	classId: string;
	modules: number;
	from: "personal" | "garage";
}

/**
 * Put the pilot in a named hull.
 *
 * Must run BEFORE ensure-loadout: switching hulls leaves the pilot in bare
 * metal, because modules stay with the hull they were bolted to. The hull left
 * behind is the part a caller most needs to know about — it goes to personal
 * storage with its modules still fitted — so it is reported in
 * `context.parked` rather than left to be discovered later.
 *
 * The game moves cargo off the outgoing hull itself and says what it moved;
 * that is reported too rather than silently dropped.
 */
export class LibEnsureHull implements LibGoal {
	readonly name = "ensure-hull";

	constructor(private readonly options: EnsureHullOptions) {}

	async execute(ctx: LibGoalContext): Promise<ReconcileResult> {
		if (this.options.shipId === undefined && this.options.shipClass === undefined) {
			return reconciled(
				[
					{
						id: "hull",
						kind: "hull",
						ok: false,
						action: "none",
						message: "invalid_request: one of shipId or shipClass is required",
						before: {},
					},
				],
				0,
			);
		}

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
						id: this.options.shipId ?? this.options.shipClass ?? "hull",
						kind: "hull",
						ok: false,
						action: "none",
						message: `not_at_station: ${prepare.message}`,
						before: { ...this.currentHull(ctx) },
					},
				],
				prepare.ticksUsed,
			);
		}

		const fleet = await this.listShips(ctx);
		const current = this.currentHull(ctx);

		if (this.matchesDesired(fleet.active_ship_id, fleet.active_ship_class)) {
			return reconciled(
				[
					{
						id: fleet.active_ship_id ?? "hull",
						kind: "hull",
						ok: true,
						action: "none",
						desired: this.desired(),
						before: current,
					},
				],
				prepare.ticksUsed,
			);
		}

		const candidate = this.pickCandidate(fleet);
		if (candidate === undefined) {
			return reconciled(
				[
					{
						id: this.options.shipId ?? this.options.shipClass ?? "hull",
						kind: "hull",
						ok: false,
						action: "none",
						message: "hull_not_available",
						desired: this.desired(),
						before: { ...current, searched: this.options.source ?? "personal+garage" },
					},
				],
				prepare.ticksUsed,
			);
		}

		return this.switchTo(ctx, candidate, current, prepare.ticksUsed);
	}

	private desired(): Record<string, unknown> {
		return this.options.shipId !== undefined
			? { shipId: this.options.shipId }
			: { class: this.options.shipClass };
	}

	private currentHull(ctx: LibGoalContext): Record<string, unknown> {
		const ship = ctx.state.ship as { id?: string; class_id?: string } | undefined;
		return {
			shipId: ship?.id ?? null,
			class: ship?.class_id ?? null,
			modulesAboard: (ctx.state.modules ?? []).length,
		};
	}

	private matchesDesired(shipId: string | undefined, classId: string | undefined): boolean {
		return this.options.shipId !== undefined
			? shipId === this.options.shipId
			: classId === this.options.shipClass;
	}

	private async listShips(ctx: LibGoalContext): Promise<ListShipsResponse> {
		const response = await ctx.account.commands.spacemolt_ship.list_ships();
		return (response.structuredContent as ListShipsResponse | undefined) ?? { count: 0, ships: [] };
	}

	private pickCandidate(fleet: ListShipsResponse): Candidate | undefined {
		const source = this.options.source;

		const personal: Candidate[] = (fleet.ships ?? [])
			.filter((ship) => !ship.is_active)
			// A hull can only be switched into at the station holding it.
			.filter(
				(ship) =>
					ship.location_base_id === undefined || ship.location_base_id === this.options.baseId,
			)
			.filter((ship) => this.matchesDesired(ship.ship_id, ship.class_id))
			.map((ship) => ({
				shipId: ship.ship_id,
				classId: ship.class_id,
				modules: ship.modules ?? 0,
				from: "personal" as const,
			}));

		const garage: Candidate[] = (fleet.faction_garage ?? [])
			.filter((ship) => this.matchesDesired(ship.ship_id, ship.class_id))
			.map((ship) => ({
				shipId: ship.ship_id,
				classId: ship.class_id,
				modules: 0,
				from: "garage" as const,
			}));

		const pools =
			source === "personal" ? [personal] : source === "garage" ? [garage] : [personal, garage];
		for (const pool of pools) {
			const [first] = pool;
			if (first !== undefined) return first;
		}
		return undefined;
	}

	private async switchTo(
		ctx: LibGoalContext,
		candidate: Candidate,
		before: Record<string, unknown>,
		ticksSoFar: number,
	): Promise<ReconcileResult> {
		log.info(`Switching to ${candidate.classId} (${candidate.shipId}) from ${candidate.from}`);

		let details: SwitchShipResponse | undefined;
		try {
			const response = await ctx.account.commands.spacemolt_ship.switch_ship({
				id: candidate.shipId,
			});
			details = response.delta.details as SwitchShipResponse | undefined;
		} catch (err) {
			const message =
				err instanceof SpacemoltError
					? `switch_failed (${err.code}): ${err.message}`
					: `switch_failed: ${String(err)}`;
			const subject: ReconcileSubject = {
				id: candidate.shipId,
				kind: "hull",
				ok: false,
				action: "none",
				message,
				desired: this.desired(),
				before,
			};
			return reconciled([subject], ticksSoFar + 1);
		}

		await ctx.refreshState({ force: true });

		const subject: ReconcileSubject = {
			id: details?.active_ship_id ?? candidate.shipId,
			kind: "hull",
			ok: true,
			action: "updated",
			desired: this.desired(),
			before,
			after: {
				shipId: details?.active_ship_id ?? candidate.shipId,
				class: details?.active_ship_class ?? candidate.classId,
				modulesAboard: (ctx.state.modules ?? []).length,
				claimedFromFactionGarage: details?.claimed_from_faction_garage === true,
			},
		};

		return reconciled([subject], ticksSoFar + 1, {
			context: {
				// The outgoing hull keeps its modules. The next pilot's refit has to
				// know where they went, and the cargo the server relocated for us.
				parked: {
					shipId: details?.stored_ship_id ?? before["shipId"],
					class: details?.stored_ship_class ?? before["class"],
					where: "personal",
					modulesAboard: before["modulesAboard"],
					cargoToStorage: details?.cargo_to_storage ?? [],
					cargoNote: details?.cargo_note,
				},
			},
		});
	}
}
