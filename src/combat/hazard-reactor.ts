/**
 * Pulls a ship setpoint is driving out of a POI hazard.
 *
 * Game v0.687.0 added POI hazards: radiation, tidal shear and others take a
 * share of hull every tick a ship stays undocked at the POI, or on each mining
 * action, and the ship is lost at zero hull. A setpoint mining loop at a
 * hazardous belt would otherwise mine until the ship died.
 *
 * On each `hazard_warning`, the account's `HazardModeStore` setting decides:
 * `"external"` never acts; `"tolerate"` acts only once hull falls below its
 * floor; `"retreat"` (the default) acts on the first warning. Acting means
 * stopping whatever setpoint is running on the ship and docking at a station.
 *
 * Three cases are left alone in every mode:
 * - No setpoint work on the ship. Someone else is driving it, and moving a
 *   ship out from under its own driver is the double-driver failure this
 *   daemon avoids everywhere else.
 * - The ship is in combat. The combat response already owns it.
 * - A retreat is already under way.
 *
 * The retreat flies the stopped loop's caller-supplied routes, if it had any,
 * as combat recovery does. The stopped loop is not restarted: it would take
 * the ship straight back to the hazard. While the retreat runs it is registered as the account's
 * executing goal (`hazard-retreat`), so a goal or loop submitted meanwhile is
 * refused as busy rather than steering the ship back in.
 */

import type {
	CombatEnvelope,
	HazardRetreatPayload,
	NotificationPayloads,
	Routes,
} from "@setpoint/protocol";
import type { LibAccountManager } from "../accounts/lib-manager.js";
import type { LibManagedAccount } from "../accounts/lib-types.js";
import type { GoalResult } from "../dispatcher/goals.js";
import { LibPrepareAtStation } from "../dispatcher/lib-compounds/prepare-at-station.js";
import { type LibGoalContext, makeLibGoalContext } from "../dispatcher/lib-goal-context.js";
import { type AccountReleaseDeps, forceReleaseAccount } from "../server/account-release.js";
import type { EventBuffer } from "../state/event-buffer.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { type RecoveryTarget, resolveRecoveryTarget } from "./combat-recovery.js";
import type { HazardModeStore } from "./hazard-mode-store.js";

const log = createLogger("hazard-reactor");

export type HazardWarning = NotificationPayloads["hazard_warning"];

export interface HazardReactorDeps extends AccountReleaseDeps {
	manager: LibAccountManager;
	combatEventsStore: EventBuffer<CombatEnvelope>;
	hazardModeStore: HazardModeStore;
	/** Whether the combat response currently owns this account. */
	isInCombat?: (playerId: string) => boolean;
	/** Moves the ship to the chosen station and docks. Defaults to `retreatTo`; injectable for tests. */
	retreat?: (ctx: LibGoalContext, target: RecoveryTarget) => Promise<GoalResult>;
}

/** Dock at the target, without the refuel and repair a full prepare would add — get out first. */
export function retreatTo(ctx: LibGoalContext, target: RecoveryTarget): Promise<GoalResult> {
	return new LibPrepareAtStation({ ...target, refuel: false, repair: false }).execute(ctx);
}

/** A POI from `get_system`, narrowed to what choosing a safe station reads. */
interface SystemPoi {
	id: string;
	base_id?: string | undefined;
	base_type?: string | undefined;
	hazard?: unknown;
	position?: { x: number; y: number } | undefined;
}

export class HazardReactor {
	private readonly retreating = new Set<string>();

	constructor(private readonly deps: HazardReactorDeps) {}

	/** Whether a hazard retreat is running on this account. */
	isRetreating(playerId: string): boolean {
		return this.retreating.has(playerId);
	}

	/** React to one hazard warning. Returns at once; any retreat runs in the background. */
	handle(playerId: string, warning: HazardWarning): void {
		const setting = this.deps.hazardModeStore.get(playerId);
		if (setting.mode === "external") return;

		const hullPct = warning.max_hull > 0 ? (warning.hull / warning.max_hull) * 100 : 0;
		if (setting.mode === "tolerate" && hullPct >= setting.minHullPct) return;
		if (this.retreating.has(playerId)) return;
		if (this.deps.isInCombat?.(playerId) === true) return;

		const loopStatus = this.deps.loopManager.getStatus(playerId);
		const syncGoal = this.deps.executingGoals.get(playerId);
		const runningJob = this.deps.jobManager.getRunningJob(playerId);
		if (!loopStatus?.running && !syncGoal && !runningJob) return;

		const loopType = loopStatus?.running ? loopStatus.type : undefined;
		const loopOptions = loopStatus?.running
			? (loopStatus.options as Record<string, unknown>)
			: undefined;
		const payload: HazardRetreatPayload = {
			hazard: { type: warning.hazard.type, severity: warning.hazard.severity },
			hull: warning.hull,
			maxHull: warning.max_hull,
			previousLoopType: loopType,
			previousGoalType: syncGoal?.goalType ?? runningJob?.goalType,
		};

		this.retreating.add(playerId);
		void this.retreat(playerId, payload, hullPct, loopType, loopOptions).finally(() => {
			this.retreating.delete(playerId);
		});
	}

	private async retreat(
		playerId: string,
		payload: HazardRetreatPayload,
		hullPct: number,
		loopType: string | undefined,
		loopOptions: Record<string, unknown> | undefined,
	): Promise<void> {
		const stopped = payload.previousLoopType
			? `the ${payload.previousLoopType} loop`
			: `the ${payload.previousGoalType ?? "running"} goal`;
		log.warn(
			`[${playerId}] Hazard ${payload.hazard.type} (severity ${payload.hazard.severity}) with hull at ${Math.round(hullPct)}% — stopping ${stopped} and retreating to a station`,
		);
		forceReleaseAccount(this.deps, playerId);
		this.record(playerId, "hazard_retreat_started", payload);

		// Registered before the retreat issues its first command, so nothing can
		// slip a loop or goal onto the ship in between.
		const controller = new AbortController();
		let finish = (): void => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.deps.executingGoals.set(playerId, {
			goalType: "hazard-retreat",
			startedAt: new Date().toISOString(),
			controller,
			progress: { goalType: "hazard-retreat", completedSteps: [], remainingSteps: [] },
			promise: done,
		});
		try {
			await this.dock(playerId, payload, loopType, loopOptions, controller.signal);
		} finally {
			finish();
			if (this.deps.executingGoals.get(playerId)?.promise === done) {
				this.deps.executingGoals.delete(playerId);
			}
		}
	}

	private async dock(
		playerId: string,
		payload: HazardRetreatPayload,
		loopType: string | undefined,
		loopOptions: Record<string, unknown> | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const account = this.mustResolve(playerId);
			const target =
				resolveRecoveryTarget(loopType, loopOptions) ?? (await this.nearestStation(account));
			if (!target) {
				const message = "no safe station found in this system";
				log.warn(`[${playerId}] Hazard retreat failed: ${message}`);
				this.record(playerId, "hazard_retreat_failed", { ...payload, message });
				return;
			}
			// Fly the stopped loop's own routes, if it had any. The caller chose
			// them to keep this ship out of somewhere — leaving a hazard by way of
			// a leviathan's system would trade one danger for another.
			const routes = loopOptions?.["routes"] as Routes | undefined;
			const ctx = makeLibGoalContext(() => this.mustResolve(playerId), signal, {
				routeFor: (targetSystemId) => routes?.[targetSystemId],
			});
			const result = await (this.deps.retreat ?? retreatTo)(ctx, target);
			const done = { ...payload, target, message: result.message };
			if (result.success) {
				log.info(`[${playerId}] Hazard retreat docked at ${target.baseId}`);
				this.record(playerId, "hazard_retreat_completed", done);
			} else {
				log.warn(`[${playerId}] Hazard retreat failed: ${result.message}`);
				this.record(playerId, "hazard_retreat_failed", done);
			}
		} catch (err) {
			const message = errorMessage(err);
			log.warn(`[${playerId}] Hazard retreat failed: ${message}`);
			this.record(playerId, "hazard_retreat_failed", { ...payload, message });
		}
	}

	/**
	 * The closest station in the current system with no hazard of its own, for
	 * a goal that has no home or sell station to fall back to. Nearest by POI
	 * position when the system reports positions, otherwise the first listed.
	 */
	private async nearestStation(account: LibManagedAccount): Promise<RecoveryTarget | undefined> {
		const systemId = account.state.location?.system_id;
		if (!systemId) return undefined;
		const result = await account.commands.spacemolt.get_system();
		const content = result.structuredContent;
		if (!content || !("system" in content)) return undefined;
		const pois = content.system.pois as unknown as SystemPoi[];
		const here = pois.find((p) => p.id === account.state.location?.poi_id)?.position;
		const stations = pois.filter(
			(p): p is SystemPoi & { base_id: string } =>
				p.base_type === "station" && typeof p.base_id === "string" && p.hazard === undefined,
		);
		const distance = (p: SystemPoi): number =>
			here && p.position ? Math.hypot(p.position.x - here.x, p.position.y - here.y) : 0;
		const best = [...stations].sort((a, b) => distance(a) - distance(b))[0];
		return best ? { systemId, poiId: best.id, baseId: best.base_id } : undefined;
	}

	private record(
		playerId: string,
		type: "hazard_retreat_started" | "hazard_retreat_completed" | "hazard_retreat_failed",
		payload: HazardRetreatPayload,
	): void {
		this.deps.combatEventsStore.record(playerId, {
			receivedAt: new Date().toISOString(),
			type,
			payload,
		});
	}

	private mustResolve(playerId: string): LibManagedAccount {
		const account = this.deps.manager.getByPlayerId(playerId);
		if (!account) throw new Error(`Account ${playerId} is no longer connected`);
		return account;
	}
}
