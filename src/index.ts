import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CombatNotificationType, CraftingUpdateEvent } from "@setpoint/protocol";
import {
	type GameState,
	type NotificationPayloads,
	SpacemoltClient,
	type StateSection,
} from "@spacemolt/lib";
import { parseLibConfig } from "./accounts/lib-config.js";
import { LibAccountManager } from "./accounts/lib-manager.js";
import { type LibManagedAccount, playerId as playerIdOf } from "./accounts/lib-types.js";
import { CombatModeStore } from "./combat/combat-mode-store.js";
import { CombatReactor } from "./combat/combat-reactor.js";
import { makeLibGoalContext } from "./dispatcher/lib-goal-context.js";
import type { ExecutingGoalEntry } from "./server/account-release.js";
import { createGoal } from "./server/goal-registry.js";
import { startServer } from "./server/index.js";
import type { JobManager } from "./server/job-manager.js";
import { LoopManager } from "./server/loop-manager.js";
import { makeProjectingOnStateChange } from "./state/attach-projector.js";
import { CombatEventsStore } from "./state/combat-events-store.js";
import { CraftingEventsStore } from "./state/crafting-events-store.js";
import { createDatabase } from "./state/database.js";
import { logDrift } from "./state/drift-logger.js";
import { startDriftSweep } from "./state/drift-sweep.js";
import { StateProjector } from "./state/projector.js";
import { diffGameState } from "./state/state-diff.js";
import { StateStore } from "./state/store.js";
import { errorMessage } from "./util/errors.js";
import { type LogLevel, createLogger, enableFileLogging, setLogLevel } from "./util/logger.js";
import { installCrashSafetyHandlers } from "./util/process-safety.js";

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const envLogLevel = process.env["SM_LOG_LEVEL"];
if (envLogLevel && VALID_LOG_LEVELS.has(envLogLevel)) {
	setLogLevel(envLogLevel as LogLevel);
}

// Enable file logging — writes to logs/daemon.log alongside stdout
enableFileLogging();

const log = createLogger("main");
installCrashSafetyHandlers(log);

const CONFIG_DIR = join(import.meta.dir, "..", "config");
const DB_PATH = join(import.meta.dir, "..", "data", "dispatcher.db");
const API_PORT = Number(process.env["SM_PORT"]) || 7580;

/** Read config/dispatcher.json, returning `{}` if it is missing or unreadable. */
async function readDispatcherConfig(): Promise<unknown> {
	try {
		return JSON.parse(await readFile(join(CONFIG_DIR, "dispatcher.json"), "utf-8"));
	} catch {
		return {};
	}
}

async function main(): Promise<void> {
	log.info("setpoint starting...");

	// Load config: Clerk API key (env wins) + optional owned-player filter.
	log.info(`Loading config from ${CONFIG_DIR}`);
	const libConfig = parseLibConfig(process.env, await readDispatcherConfig());

	// Initialize database and state
	const db = createDatabase(DB_PATH);
	const store = new StateStore(db);
	const projector = new StateProjector(store);

	// Project every lib state change into SQLite, then log the changed sections.
	const projectOnChange = makeProjectingOnStateChange(projector);
	const onStateChange = (
		playerId: string,
		changed: StateSection[],
		account: LibManagedAccount,
	): void => {
		projectOnChange(playerId, changed, account);
		log.info(`[${playerId}] State updated: ${changed.join(", ")}`);
	};

	// Log server-side state drift a refresh() reveals that no push notification
	// already applied — diagnostic data for deciding which lib notification
	// types need wiring. See state/state-diff.ts and state/drift-logger.ts.
	const onDrift = (
		playerId: string,
		before: Readonly<GameState>,
		after: Readonly<GameState>,
		account: LibManagedAccount,
	): void => {
		logDrift({ playerId, username: account.id, drifts: diffGameState(before, after) });
	};

	// Buffers crafting_update pushes per account for GET /accounts/:id/crafting/events (SSE).
	const craftingEventsStore = new CraftingEventsStore();
	const onCraftingUpdate = (playerId: string, event: CraftingUpdateEvent): void => {
		craftingEventsStore.record(playerId, event);
	};

	// Per-account combat-response override (flee vs. externally-driven combat
	// logic) — loaded before the reactor and server both need it.
	const combatModeStore = await CombatModeStore.load(CONFIG_DIR);

	// Combat detection (src/combat/) needs executingGoals/claimedAccounts —
	// otherwise built privately inside startServer() — and loopManager/
	// jobManager, which don't exist until startServer() returns. Constructed
	// here, up front, and shared into both startServer() and the CombatReactor
	// built just below it, rather than each building its own copy.
	const executingGoals: Map<string, ExecutingGoalEntry> = new Map();
	const claimedAccounts = new Set<string>();
	const combatEventsStore = new CombatEventsStore();

	// Late-bound: CombatReactor can't be constructed until after startServer()
	// returns (it needs loopManager/jobManager), but LibAccountManager's
	// onCombatUpdate callback must be registered before that — same ordering
	// already established for onStateChange/onCraftingUpdate above. Safe
	// because onCombatUpdate only ever *fires* during manager.connect(), which
	// runs after both startServer() and the reactorRef assignment below
	// complete. A mutable ref object (rather than a reassigned `let`) so
	// `onCombatUpdate`'s captured binding stays a plain `const`.
	const reactorRef: { current: CombatReactor | undefined } = { current: undefined };
	const onCombatUpdate = (
		playerId: string,
		type: CombatNotificationType,
		payload: NotificationPayloads[CombatNotificationType],
	): void => {
		reactorRef.current?.handle(playerId, type, payload);
	};

	// Create the lib client and account manager.
	//
	// connectRetry: a routine, recurring game-server restart or transient
	// network blip must not permanently strand an account — confirmed live on
	// 2026-07-14, when 5 accounts all dropped with an abnormal-closure (code
	// 1006) within the same ~30-minute window and were abandoned under the
	// lib's then-default of 8 retries (~8 minutes worst case), requiring a
	// manual reconnect. Set to a large-but-bounded budget (~3+ hours worst
	// case at the 60s backoff cap) rather than Number.POSITIVE_INFINITY (the
	// lib's own default as of @spacemolt/lib 7.x) — SpacemoltClient's remove()
	// doesn't cancel an in-flight reconnect retry for that id, so an account
	// removed in the narrow window it's actively retrying would keep retrying
	// in the background; a large bound self-resolves that instead of running
	// forever. Terminal closes (session_replaced, auth_timeout) are unaffected
	// — the client never retries those regardless of this budget.
	const client = new SpacemoltClient({
		clerkApiKey: libConfig.clerkApiKey,
		connectRetry: { maxRetries: 200, baseDelayMs: 2000, maxDelayMs: 60_000 },
	});
	const manager = new LibAccountManager(client, libConfig, {
		onStateChange,
		onDrift,
		onCraftingUpdate,
		onCombatUpdate,
	});

	// Periodically force a refresh() across the whole fleet so idle accounts
	// (no goals/loops running) still get checked for drift, not just ones that
	// happen to trigger an opportunistic refresh.
	const driftSweep = startDriftSweep(manager);

	// Start the HTTP API server BEFORE connecting accounts, so health checks and
	// state queries are live immediately. A cold start re-authenticates every
	// owned account under the auth rate limit, which for a large fleet can take
	// many minutes — we must not hold the server down for that whole window.
	const server = startServer({
		port: API_PORT,
		manager,
		store,
		db,
		client,
		configDir: CONFIG_DIR,
		craftingEventsStore,
		combatEventsStore,
		combatModeStore,
		executingGoals,
		claimedAccounts,
	});
	log.info(`Dispatcher running on port ${server.port}. Press Ctrl+C to stop.`);

	reactorRef.current = new CombatReactor({
		manager,
		loopManager: server.loopManager,
		jobManager: server.jobManager,
		executingGoals,
		configDir: CONFIG_DIR,
		combatEventsStore,
		combatModeStore,
	});

	// Connect all owned accounts in the background (the lib staggers connections
	// internally). The server is already serving; each account's loops/jobs
	// resume as soon as it connects, not after the whole fleet does.
	log.info("Connecting accounts in the background...");
	connectAccounts(manager, store, server, CONFIG_DIR)
		.then(() => {
			// Run one drift sweep pass as soon as the fleet is connected, instead of
			// waiting up to a full intervalMs for the first scheduled pass —
			// startDriftSweep() was called before any accounts existed to sweep.
			void driftSweep.runOnce();
		})
		.catch((err) => {
			log.error(`Background account connection failed: ${errorMessage(err)}`);
		});

	// Graceful shutdown: stop loops and let in-flight HTTP requests drain
	// (bounded — see stopServerWithGracePeriod) BEFORE disconnecting accounts,
	// so a sync goal mid-request doesn't have its account's socket pulled out
	// from under it while still trying to finish normally.
	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		// A second SIGINT/SIGTERM while the first shutdown is still draining must
		// not call server.stop() again — verified live that calling it while an
		// earlier unresolved call is pending never resolves (see
		// stopServerWithGracePeriod's doc comment), which would hang this second
		// call forever even though the first is still on track to exit.
		if (shuttingDown) return;
		shuttingDown = true;
		log.info("Shutting down...");
		driftSweep.stop();
		reactorRef.current?.stop();
		try {
			await server.stop();
		} catch (err) {
			log.error(`Error while stopping the server: ${errorMessage(err)}`);
		}
		manager.disconnectAll();
		db.close();
		log.info("Goodbye.");
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

type LoopConfigEntry = Awaited<ReturnType<typeof LoopManager.loadLoopConfigs>>[number];

/**
 * Connect all owned accounts, resuming each one's persisted loop and any
 * interrupted async jobs as soon as THAT account finishes connecting — not
 * after the whole fleet does. A large fleet's connect is rate-limited by the
 * server's per-IP WS-connection cap and can take minutes; gating resume on
 * the entire batch left an already-connected account idle for the rest of
 * that window for no reason. Runs in the background so the HTTP server can
 * serve health/queries while accounts come online.
 */
export async function connectAccounts(
	manager: LibAccountManager,
	store: StateStore,
	server: { loopManager: LoopManager; jobManager: JobManager },
	configDir: string,
): Promise<void> {
	const loopConfigs = await LoopManager.loadLoopConfigs(configDir);
	const pendingLoopConfigs = new Map(loopConfigs.map((config) => [config.playerId, config]));
	if (pendingLoopConfigs.size > 0) {
		log.info(
			`Found ${pendingLoopConfigs.size} persisted loop config(s), resuming as accounts connect...`,
		);
	}

	let connectedCount = 0;
	await manager.connect((account) => {
		connectedCount++;
		if (!account.player?.id) {
			// The client's own onAccountConnected listener already warns and
			// skips indexing for this case (see LibAccountManager's constructor)
			// — nothing to resume for an account that was never indexed.
			return;
		}
		const playerId = playerIdOf(account);
		logAccountState(account, store);
		void resumeJobsForAccount(server.jobManager, manager, playerId);

		const loopConfig = pendingLoopConfigs.get(playerId);
		if (loopConfig) {
			pendingLoopConfigs.delete(playerId);
			resumeLoopConfig(server.loopManager, manager, loopConfig);
		}
	});

	if (connectedCount === 0) {
		log.warn("No accounts connected at startup. The server is up; add accounts via the API.");
		return;
	}

	// Any remaining config's account never connected this run, so it was never
	// reached by the per-account resume above.
	for (const config of pendingLoopConfigs.values()) {
		log.warn(`[${config.playerId}] Account not connected, skipping loop resume`);
	}
}

/** Log a one-line summary of an account's state as soon as it connects. */
function logAccountState(account: LibManagedAccount, store: StateStore): void {
	const state = store.getState(playerIdOf(account));
	if (!state) {
		log.warn(`[${account.id ?? "?"}] No state available`);
		return;
	}
	const player = state.player;
	const ship = state.ship;
	const location = state.location;
	log.info(
		`[${account.id ?? "?"}] ` +
			`Credits: ${player?.credits ?? "?"} | ` +
			`Ship: ${ship?.class_name ?? ship?.class_id ?? "?"} ` +
			`(Hull: ${ship?.hull ?? "?"}/${ship?.max_hull ?? "?"}, ` +
			`Fuel: ${ship?.fuel ?? "?"}/${ship?.max_fuel ?? "?"}) | ` +
			`Location: ${location?.system_name ?? "?"} - ${location?.poi_name ?? "space"} ` +
			`${location?.docked_at ? "(docked)" : "(undocked)"}`,
	);
}

/**
 * Re-queue any pending jobs for a single account.
 */
async function resumeJobsForAccount(
	jobManager: JobManager,
	manager: LibAccountManager,
	playerId: string,
): Promise<void> {
	const pendingJobs = jobManager.listPendingForAccount(playerId);
	if (pendingJobs.length === 0) return;

	const account = manager.getByPlayerId(playerId);
	if (!account) return;

	for (const job of pendingJobs) {
		if (!job.goalType || job.goalOptions === undefined) {
			jobManager.fail(job.jobId, "Daemon restarted before job completed");
			continue;
		}

		let goal: ReturnType<typeof createGoal>;
		try {
			goal = createGoal(job.goalType, job.goalOptions as Record<string, unknown>);
		} catch {
			jobManager.fail(job.jobId, "Failed to reconstruct goal for resumption");
			continue;
		}

		jobManager.requeue(job.jobId);
		// Resolve fresh from the manager on every access rather than closing over
		// `account` — a resumed job can outlive the connection it was resumed on.
		const goalCtx = makeLibGoalContext(() => {
			const live = manager.getByPlayerId(playerId);
			if (!live) {
				throw new Error(`Account ${playerId} is no longer connected`);
			}
			return live;
		});

		goal
			.execute(goalCtx)
			.then((result) => jobManager.complete(job.jobId, result))
			.catch((err: unknown) => jobManager.fail(job.jobId, errorMessage(err)));

		log.info(`[${playerId}] Resumed async job ${job.jobId} (${job.goalType})`);
	}
}

/**
 * Start one persisted loop config on its (already-connected) account.
 * Shared by `connectAccounts`'s per-account resume and, directly, by tests.
 */
export function resumeLoopConfig(
	loopManager: LoopManager,
	manager: LibAccountManager,
	config: LoopConfigEntry,
): void {
	type StartFn = (
		playerId: string,
		options: never,
		resolveAccount: () => LibManagedAccount,
	) => unknown;

	const startMethodMap: Record<string, StartFn | undefined> = {
		mining: loopManager.startMiningLoop.bind(loopManager) as StartFn,
		"enhanced-mining": loopManager.startEnhancedMiningLoop.bind(loopManager) as StartFn,
		trading: loopManager.startTradingLoop.bind(loopManager) as StartFn,
		hauling: loopManager.startHaulingLoop.bind(loopManager) as StartFn,
		"storage-transfer": loopManager.startStorageTransferLoop.bind(loopManager) as StartFn,
		salvage: loopManager.startSalvageLoop.bind(loopManager) as StartFn,
		"tow-salvage": loopManager.startTowSalvageLoop.bind(loopManager) as StartFn,
		exploration: loopManager.startExplorationLoop.bind(loopManager) as StartFn,
		guard: loopManager.startGuardLoop.bind(loopManager) as StartFn,
		"roaming-salvage": loopManager.startRoamingSalvageLoop.bind(loopManager) as StartFn,
	};

	const startFn = startMethodMap[config.type];
	if (!startFn) {
		log.warn(`[${config.playerId}] Unknown loop type '${config.type}', skipping`);
		return;
	}

	try {
		(
			startFn as (
				pid: string,
				opts: Record<string, unknown>,
				resolveAccount: () => LibManagedAccount,
			) => unknown
		)(config.playerId, config.options, () => {
			const live = manager.getByPlayerId(config.playerId);
			if (!live) {
				throw new Error(`Account ${config.playerId} is no longer connected`);
			}
			return live;
		});
		log.info(`[${config.playerId}] Resumed ${config.type} loop`);
	} catch (err) {
		log.warn(`[${config.playerId}] Failed to resume ${config.type} loop: ${errorMessage(err)}`);
	}
}

if (import.meta.main) {
	main().catch((err) => {
		log.error(`Fatal error: ${errorMessage(err)}`);
		process.exit(1);
	});
}
