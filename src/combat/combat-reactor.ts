/**
 * Stateful per-fleet orchestrator: wires the pure combat detector
 * (`combat-detector.ts`) to the account-release primitive
 * (`../server/account-release.ts`), a pluggable response strategy
 * (`combat-response.ts`), and post-combat recovery (`combat-recovery.ts`),
 * publishing everything self-relevant to the combat `EventBuffer` along the way.
 *
 * One instance runs for the whole daemon. `handle()` is called directly
 * from the notification-routing frame (`onCombatUpdate` in
 * `src/accounts/lib-manager.ts`) and must stay fast/synchronous —
 * everything after "interrupt whatever's running" (the flee attempt,
 * recovery) runs in the background, not awaited by `handle()`.
 *
 * Recovery runs whenever the detector confirms combat is over (any
 * `exited` transition — battle won, lost-but-survived, or successfully
 * fled), not gated on the flee strategy's own outcome: a fight can end for
 * reasons that have nothing to do with our own flee attempt.
 */

import type { CombatEnvelope } from "@setpoint/protocol";
import type { LibAccountManager } from "../accounts/lib-manager.js";
import type { LibManagedAccount } from "../accounts/lib-types.js";
import { makeLibGoalContext } from "../dispatcher/lib-goal-context.js";
import type { AccountReleaseDeps } from "../server/account-release.js";
import { forceReleaseAccount } from "../server/account-release.js";
import type { EventBuffer } from "../state/event-buffer.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import {
	type CombatDetectorEvent,
	type CombatDetectorState,
	type CombatTransition,
	INITIAL_COMBAT_STATE,
	reduceCombatEvent,
	reduceTimeout,
} from "./combat-detector.js";
import type { CombatHeartbeatStore } from "./combat-heartbeat.js";
import type { CombatModeStore } from "./combat-mode-store.js";
import {
	type RecoveryProximity,
	resolveRecoveryTarget,
	runCombatRecovery,
} from "./combat-recovery.js";
import { type CombatResponseStrategy, FleeCombatStrategy } from "./combat-response.js";

const log = createLogger("combat-reactor");

const DEFAULT_EXIT_TIMEOUT_MS = 60_000;

/** Five game ticks. Long enough that a driver pausing to think is not mistaken for a dead one. */
const DEFAULT_EXTERNAL_HEARTBEAT_TIMEOUT_MS = 50_000;

export interface CombatReactorDeps extends AccountReleaseDeps {
	manager: LibAccountManager;
	combatEventsStore: EventBuffer<CombatEnvelope>;
	/** Per-account override of the combat response — see `CombatModeStore`'s doc comment. */
	combatModeStore: CombatModeStore;
	/** Combat-response strategy to run on entering combat for accounts in `"flee"` mode. Defaults to `FleeCombatStrategy`. */
	strategy?: CombatResponseStrategy;
	/** Wall-clock ms with no combat activity before presuming a fight resolved. Defaults to 60s. */
	exitTimeoutMs?: number;
	/**
	 * Liveness signal from external combat drivers. Without it, an account in
	 * `"external"` mode whose driver has died neither fights nor flees.
	 */
	heartbeats?: CombatHeartbeatStore;
	/**
	 * Wall-clock ms an in-battle `"external"` account may go without a driver
	 * heartbeat before setpoint takes the fight. Defaults to 50s — five ticks.
	 */
	externalHeartbeatTimeoutMs?: number;
}

interface InterruptedWork {
	loopType?: string | undefined;
	loopOptions?: Record<string, unknown> | undefined;
	goalType?: string | undefined;
}

interface TrackedAccount {
	state: CombatDetectorState;
	timer?: ReturnType<typeof setTimeout> | undefined;
	/** Watchdog for an `"external"` account whose driver may have died mid-fight. */
	watchdog?: ReturnType<typeof setInterval> | undefined;
	responseController?: AbortController | undefined;
	interrupted?: InterruptedWork | undefined;
}

export class CombatReactor {
	private readonly tracked = new Map<string, TrackedAccount>();
	private readonly strategy: CombatResponseStrategy;
	private readonly exitTimeoutMs: number;
	private readonly externalHeartbeatTimeoutMs: number;

	constructor(private readonly deps: CombatReactorDeps) {
		this.strategy = deps.strategy ?? new FleeCombatStrategy();
		this.exitTimeoutMs = deps.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
		this.externalHeartbeatTimeoutMs =
			deps.externalHeartbeatTimeoutMs ?? DEFAULT_EXTERNAL_HEARTBEAT_TIMEOUT_MS;
	}

	/** Feed one combat-relevant notification for an account through the detector. */
	handle(playerId: string, type: CombatDetectorEvent["type"], payload: unknown): void {
		const tracked = this.trackedFor(playerId);
		const event = { type, payload } as CombatDetectorEvent;
		const now = Date.now();
		const result = reduceCombatEvent(tracked.state, event, playerId, now);
		tracked.state = result.state;

		if (result.selfRelevant) {
			this.deps.combatEventsStore.record(playerId, {
				receivedAt: new Date().toISOString(),
				...event,
			});
		}

		if (result.transition) {
			this.handleTransition(playerId, tracked, result.transition);
			return;
		}

		if (result.selfRelevant && tracked.state.phase === "in-combat") {
			this.rearmTimeout(playerId, tracked);
		}
	}

	/** Clears all pending timers and in-flight response controllers — call on daemon shutdown. */
	/**
	 * Whether this account is currently in a battle.
	 *
	 * Exposed so fleet operations can refuse to touch a ship mid-fight. Combat
	 * releases an account from its loop and goals, so a fighting ship otherwise
	 * looks idle to every other "is it busy" check in the daemon.
	 */
	isInCombat(playerId: string): boolean {
		return this.tracked.get(playerId)?.state.activeBattleId !== undefined;
	}

	stop(): void {
		for (const tracked of this.tracked.values()) {
			if (tracked.timer) clearTimeout(tracked.timer);
			// The watchdog is an interval, so leaving it behind would both keep the
			// process alive and let it fire a combat response after shutdown.
			if (tracked.watchdog) clearInterval(tracked.watchdog);
			tracked.responseController?.abort();
		}
		this.tracked.clear();
	}

	private trackedFor(playerId: string): TrackedAccount {
		let tracked = this.tracked.get(playerId);
		if (!tracked) {
			tracked = { state: INITIAL_COMBAT_STATE };
			this.tracked.set(playerId, tracked);
		}
		return tracked;
	}

	private handleTransition(
		playerId: string,
		tracked: TrackedAccount,
		transition: CombatTransition,
	): void {
		switch (transition.kind) {
			case "entered":
				this.onEntered(playerId, tracked, transition.battleId);
				return;
			case "exited":
				this.clearTimeout(tracked);
				tracked.responseController?.abort();
				tracked.responseController = undefined;
				void this.runRecovery(playerId, tracked);
				return;
			case "died":
				// The ship is gone regardless of whether "entered" ever fired first
				// (a fast ambush can deliver player_died before any self-check
				// matched) — clear any busy bookkeeping so the account doesn't
				// appear stuck, but skip recovery entirely (already at
				// respawn_base; see combat-recovery.ts's module doc).
				this.clearTimeout(tracked);
				tracked.responseController?.abort();
				tracked.responseController = undefined;
				tracked.interrupted = undefined;
				forceReleaseAccount(this.deps, playerId);
				return;
		}
	}

	private onEntered(playerId: string, tracked: TrackedAccount, battleId: string): void {
		this.rearmTimeout(playerId, tracked);

		const loopStatus = this.deps.loopManager.getStatus(playerId);
		const syncGoal = this.deps.executingGoals.get(playerId);
		const runningJob = this.deps.jobManager.getRunningJob(playerId);

		const interrupted: InterruptedWork = {
			loopType: loopStatus?.running ? loopStatus.type : undefined,
			loopOptions: loopStatus?.running
				? (loopStatus.options as Record<string, unknown>)
				: undefined,
			goalType: syncGoal?.goalType ?? runningJob?.goalType,
		};
		tracked.interrupted = interrupted;

		forceReleaseAccount(this.deps, playerId);

		this.deps.combatEventsStore.record(playerId, {
			receivedAt: new Date().toISOString(),
			type: "combat_interrupted",
			payload: {
				battleId,
				previousLoopType: interrupted.loopType,
				previousGoalType: interrupted.goalType,
			},
		});

		const mode = this.deps.combatModeStore.get(playerId);
		if (mode === "external") {
			log.info(
				`[${playerId}] combat entered — combat mode is "external", released from setpoint work but skipping the automatic flee response`,
			);
			this.armExternalWatchdog(playerId, tracked, battleId);
			return;
		}

		this.runStrategy(playerId, tracked, battleId);
	}

	/** Run the configured combat-response strategy for an account already in a battle. */
	private runStrategy(playerId: string, tracked: TrackedAccount, battleId: string): void {
		const account = this.deps.manager.getByPlayerId(playerId);
		if (!account) {
			log.warn(
				`[${playerId}] combat entered but account is no longer connected — skipping response`,
			);
			return;
		}

		const controller = new AbortController();
		tracked.responseController = controller;
		this.strategy
			.respond({ account, battleId, signal: controller.signal })
			.then((result) => {
				log.info(
					`[${playerId}] combat response "${this.strategy.name}" finished: ${result.message}`,
				);
			})
			.catch((err) => {
				log.warn(`[${playerId}] combat response threw: ${errorMessage(err)}`);
			});
	}

	private async runRecovery(playerId: string, tracked: TrackedAccount): Promise<void> {
		const interrupted = tracked.interrupted;
		tracked.interrupted = undefined;
		if (!interrupted?.loopType) return;

		const recoveryMode = interrupted.loopOptions?.["combatRecovery"];
		if (recoveryMode === "external" || recoveryMode === "none") return;

		const account = this.deps.manager.getByPlayerId(playerId);
		if (!account) return;

		const proximity =
			interrupted.loopType === "hauling" ? await this.fetchProximity(account) : undefined;
		const target = resolveRecoveryTarget(interrupted.loopType, interrupted.loopOptions, proximity);
		if (!target) return;

		this.deps.combatEventsStore.record(playerId, {
			receivedAt: new Date().toISOString(),
			type: "combat_recovery_started",
			payload: { target },
		});

		try {
			const ctx = makeLibGoalContext(() => this.mustResolveAccount(playerId));
			const result = await runCombatRecovery(ctx, target);
			this.deps.combatEventsStore.record(playerId, {
				receivedAt: new Date().toISOString(),
				type: result.success ? "combat_recovery_completed" : "combat_recovery_failed",
				payload: { target, message: result.message },
			});
		} catch (err) {
			this.deps.combatEventsStore.record(playerId, {
				receivedAt: new Date().toISOString(),
				type: "combat_recovery_failed",
				payload: { target, message: errorMessage(err) },
			});
		}
	}

	private async fetchProximity(account: LibManagedAccount): Promise<RecoveryProximity | undefined> {
		const currentSystemId = account.state.location?.system_id;
		if (!currentSystemId) return undefined;
		try {
			const mapResult = await account.commands.spacemolt.get_map();
			const content = mapResult.structuredContent;
			if (!content || !("systems" in content)) return undefined;
			return { currentSystemId, systems: content.systems };
		} catch (err) {
			log.warn(`fetchProximity failed: ${errorMessage(err)}`);
			return undefined;
		}
	}

	private mustResolveAccount(playerId: string): LibManagedAccount {
		const account = this.deps.manager.getByPlayerId(playerId);
		if (!account) {
			throw new Error(`Account ${playerId} is no longer connected`);
		}
		return account;
	}

	private rearmTimeout(playerId: string, tracked: TrackedAccount): void {
		this.clearTimeout(tracked);
		tracked.timer = setTimeout(() => this.checkTimeout(playerId), this.exitTimeoutMs);
	}

	private clearTimeout(tracked: TrackedAccount): void {
		if (tracked.timer) {
			clearTimeout(tracked.timer);
			tracked.timer = undefined;
		}
		this.clearWatchdog(tracked);
	}

	private clearWatchdog(tracked: TrackedAccount): void {
		if (tracked.watchdog) {
			clearInterval(tracked.watchdog);
			tracked.watchdog = undefined;
		}
	}

	/**
	 * Watch an `"external"` account for a driver that has stopped breathing.
	 *
	 * Only armed while in battle: an external account sitting outside a fight
	 * with no driver is simply parked, which is fine. The trigger is a missed
	 * heartbeat rather than an absence of commands, because the most common tick
	 * in a well-fought battle is one where the driver deliberately holds.
	 *
	 * When it fires, setpoint takes the fight — but does NOT rewrite the
	 * account's configured mode. A setting the daemon silently changed on a
	 * timer becomes a mystery to whoever debugs it later; re-arming is the
	 * driver's business, and the next battle starts external again.
	 */
	private armExternalWatchdog(playerId: string, tracked: TrackedAccount, battleId: string): void {
		const heartbeats = this.deps.heartbeats;
		if (heartbeats === undefined) return;

		// The driver is presumed alive at the moment combat starts; it has one
		// full window to check in.
		heartbeats.beat(playerId);
		this.clearWatchdog(tracked);

		tracked.watchdog = setInterval(
			() => {
				const current = this.tracked.get(playerId);
				if (!current || current.state.activeBattleId === undefined) {
					if (current) this.clearWatchdog(current);
					heartbeats.clear(playerId);
					return;
				}

				const silence = heartbeats.sinceLast(playerId);
				if (silence === undefined || silence < this.externalHeartbeatTimeoutMs) return;

				log.warn(
					`[${playerId}] external combat driver has not checked in for ${Math.round(silence / 1000)}s during battle ${battleId} — taking the fight with the built-in flee response. The account's combat mode is left as "external"; re-arm the driver when it is back.`,
				);
				this.clearWatchdog(current);
				this.runStrategy(playerId, current, battleId);
				// Checked several times per window: polling AT the timeout means a beat
				// landing just after a tick is not noticed for nearly two full windows,
				// so a documented five-tick fallback would really take up to ten.
			},
			Math.max(1, Math.floor(this.externalHeartbeatTimeoutMs / 5)),
		);
	}

	private checkTimeout(playerId: string): void {
		const tracked = this.tracked.get(playerId);
		if (!tracked) return;
		const result = reduceTimeout(tracked.state, Date.now(), this.exitTimeoutMs);
		tracked.state = result.state;
		if (result.transition) {
			this.handleTransition(playerId, tracked, result.transition);
		}
	}
}
