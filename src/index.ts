import { join } from "node:path";
import type { AccountConfig } from "./accounts/config.js";
import { loadConfig } from "./accounts/config.js";
import { AccountManager } from "./accounts/manager.js";
import { SpaceMoltClient } from "./api/client.js";
import { createGoal } from "./server/goal-registry.js";
import { startServer } from "./server/index.js";
import type { JobManager } from "./server/job-manager.js";
import { LoopManager, buildGoalContext } from "./server/loop-manager.js";
import { createDatabase } from "./state/database.js";
import { StateStore } from "./state/store.js";
import { StateUpdater } from "./state/updater.js";
import { bandwidthTracker } from "./util/bandwidth-tracker.js";
import { errorMessage } from "./util/errors.js";
import { type LogLevel, createLogger, enableFileLogging, setLogLevel } from "./util/logger.js";

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const envLogLevel = process.env["SM_LOG_LEVEL"];
if (envLogLevel && VALID_LOG_LEVELS.has(envLogLevel)) {
	setLogLevel(envLogLevel as LogLevel);
}

// Enable file logging — writes to logs/daemon.log alongside stdout
enableFileLogging();

const log = createLogger("main");

const CONFIG_DIR = join(import.meta.dir, "..", "config");
const DB_PATH = join(import.meta.dir, "..", "data", "dispatcher.db");
const API_PORT = Number(process.env["SM_PORT"]) || 7580;

async function main(): Promise<void> {
	log.info("setpoint starting...");

	// Load config
	log.info(`Loading config from ${CONFIG_DIR}`);
	const config = await loadConfig(CONFIG_DIR);
	log.info(`Found ${config.accounts.length} account(s)`);

	// Initialize database and state
	const db = createDatabase(DB_PATH);
	const store = new StateStore(db);
	const updater = new StateUpdater(store);

	// Wire up state change logging
	updater.onStateChange((event) => {
		log.info(`[${event.accountId}] State updated: ${event.sections.join(", ")}`);
	});

	// Create API client and account manager
	const client = new SpaceMoltClient();
	const manager = new AccountManager(client, {
		stateUpdater: updater,
		stateStore: store,
		configDir: CONFIG_DIR,
	});

	// Start bandwidth rollup logging (5-minute windows)
	bandwidthTracker.start();

	// Start the HTTP API server BEFORE connecting accounts, so health checks and
	// state queries are live immediately. A cold start with expired sessions
	// re-logs in every account at the auth-rate-limit stagger (~6.5s each), which
	// for a large fleet can take many minutes — we must not hold the server down
	// for that whole window.
	const server = startServer({ port: API_PORT, manager, store, db, client, configDir: CONFIG_DIR });
	log.info(`Dispatcher running on port ${server.port}. Press Ctrl+C to stop.`);

	// Wire job resumption for accounts that connect after startup via queueAccount.
	// Set before connecting so any API-queued account during startup is covered;
	// connectAll() accounts do not fire this hook (handled by connectAccounts below).
	manager.setOnAccountConnected((playerId) => {
		void resumeJobsForAccount(server.jobManager, manager, store, playerId);
	});

	// Connect all configured accounts in the background (staggered). The server is
	// already serving; accounts come online as they connect, and loops/jobs resume
	// once the bulk connect finishes.
	log.info("Connecting accounts in the background...");
	connectAccounts(manager, store, server, config.accounts).catch((err) => {
		log.error(`Background account connection failed: ${errorMessage(err)}`);
	});

	// Graceful shutdown
	const shutdown = (): void => {
		log.info("Shutting down...");
		bandwidthTracker.stop();
		server.stop().catch(() => {});
		manager.disconnectAll();
		db.close();
		log.info("Goodbye.");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

/**
 * Connect all configured accounts (staggered), log their initial state, then
 * resume persisted loops and interrupted async jobs. Runs in the background so
 * the HTTP server can serve health/queries while accounts come online.
 */
async function connectAccounts(
	manager: AccountManager,
	store: StateStore,
	server: { loopManager: LoopManager; jobManager: JobManager },
	accounts: AccountConfig[],
): Promise<void> {
	const connected = await manager.connectAll(accounts);

	if (connected.length === 0) {
		log.warn("No accounts connected at startup. The server is up; add accounts via the API.");
		return;
	}

	// Log initial state for each connected account
	for (const account of connected) {
		const state = store.getState(account.config.player_id);
		if (state) {
			const player = state.player;
			const ship = state.ship;
			const location = state.location;
			log.info(
				`[${account.config.username}] ` +
					`Credits: ${player?.credits ?? "?"} | ` +
					`Ship: ${ship?.class_name ?? ship?.class_id ?? "?"} ` +
					`(Hull: ${ship?.hull ?? "?"}/${ship?.max_hull ?? "?"}, ` +
					`Fuel: ${ship?.fuel ?? "?"}/${ship?.max_fuel ?? "?"}) | ` +
					`Location: ${location?.system_name ?? "?"} - ${location?.poi_name ?? "space"} ` +
					`${location?.docked_at ? "(docked)" : "(undocked)"}`,
			);
		} else {
			log.warn(`[${account.config.username}] No state available`);
		}
	}

	// Auto-resume persisted loops and interrupted async jobs for all connected accounts
	await resumeLoops(server.loopManager, manager, store, CONFIG_DIR);
	await resumeJobs(server.jobManager, manager, store);
}

/**
 * Resume all pending jobs (interrupted by a daemon restart) for all connected accounts.
 */
async function resumeJobs(
	jobManager: JobManager,
	manager: AccountManager,
	store: StateStore,
): Promise<void> {
	for (const account of manager.getAll()) {
		await resumeJobsForAccount(jobManager, manager, store, account.config.player_id);
	}
}

/**
 * Re-queue any pending jobs for a single account.
 * Called after an account connects — either at startup or via the queue.
 */
async function resumeJobsForAccount(
	jobManager: JobManager,
	manager: AccountManager,
	store: StateStore,
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
		const goalCtx = buildGoalContext(account, store);

		goal
			.execute(goalCtx)
			.then((result) => jobManager.complete(job.jobId, result))
			.catch((err: unknown) => jobManager.fail(job.jobId, errorMessage(err)));

		log.info(`[${playerId}] Resumed async job ${job.jobId} (${job.goalType})`);
	}
}

/**
 * Resume any persisted loops from a previous daemon run.
 * Reads loop configs from disk and restarts them on the appropriate accounts.
 */
async function resumeLoops(
	loopManager: import("./server/loop-manager.js").LoopManager,
	manager: AccountManager,
	store: StateStore,
	configDir: string,
): Promise<void> {
	const configs = await LoopManager.loadLoopConfigs(configDir);
	if (configs.length === 0) {
		return;
	}

	log.info(`Found ${configs.length} persisted loop config(s), resuming...`);

	type ManagedAccount = import("./accounts/manager.js").ManagedAccount;
	type StartFn = (
		playerId: string,
		options: never,
		account: ManagedAccount,
		store: StateStore,
	) => unknown;

	const startMethodMap: Record<string, StartFn | undefined> = {
		mining: loopManager.startMiningLoop.bind(loopManager) as StartFn,
		"enhanced-mining": loopManager.startEnhancedMiningLoop.bind(loopManager) as StartFn,
		trading: loopManager.startTradingLoop.bind(loopManager) as StartFn,
		hauling: loopManager.startHaulingLoop.bind(loopManager) as StartFn,
		"storage-transfer": loopManager.startStorageTransferLoop.bind(loopManager) as StartFn,
		salvage: loopManager.startSalvageLoop.bind(loopManager) as StartFn,
		exploration: loopManager.startExplorationLoop.bind(loopManager) as StartFn,
		guard: loopManager.startGuardLoop.bind(loopManager) as StartFn,
	};

	for (const config of configs) {
		const account = manager.getByPlayerId(config.playerId);
		if (!account) {
			log.warn(`[${config.playerId}] Account not connected, skipping loop resume`);
			continue;
		}

		const startFn = startMethodMap[config.type];
		if (!startFn) {
			log.warn(`[${config.playerId}] Unknown loop type '${config.type}', skipping`);
			continue;
		}

		try {
			(
				startFn as (
					pid: string,
					opts: Record<string, unknown>,
					acct: ManagedAccount,
					st: StateStore,
				) => unknown
			)(config.playerId, config.options, account, store);
			log.info(`[${config.playerId}] Resumed ${config.type} loop`);
		} catch (err) {
			log.warn(`[${config.playerId}] Failed to resume ${config.type} loop: ${errorMessage(err)}`);
		}
	}
}

main().catch((err) => {
	log.error(`Fatal error: ${errorMessage(err)}`);
	process.exit(1);
});
