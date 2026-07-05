import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CraftingUpdateEvent } from "@setpoint/protocol";
import { type GameState, SpacemoltClient, type StateSection } from "@spacemolt/lib";
import { parseLibConfig } from "./accounts/lib-config.js";
import { LibAccountManager } from "./accounts/lib-manager.js";
import { type LibManagedAccount, playerId as playerIdOf } from "./accounts/lib-types.js";
import { makeLibGoalContext } from "./dispatcher/lib-goal-context.js";
import { createGoal } from "./server/goal-registry.js";
import { startServer } from "./server/index.js";
import type { JobManager } from "./server/job-manager.js";
import { LoopManager } from "./server/loop-manager.js";
import { makeProjectingOnStateChange } from "./state/attach-projector.js";
import { CraftingEventsStore } from "./state/crafting-events-store.js";
import { createDatabase } from "./state/database.js";
import { logDrift } from "./state/drift-logger.js";
import { startDriftSweep } from "./state/drift-sweep.js";
import { StateProjector } from "./state/projector.js";
import { diffGameState } from "./state/state-diff.js";
import { StateStore } from "./state/store.js";
import { bandwidthTracker } from "./util/bandwidth-tracker.js";
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

	// Create the lib client and account manager
	const client = new SpacemoltClient({ clerkApiKey: libConfig.clerkApiKey });
	const manager = new LibAccountManager(client, libConfig, {
		onStateChange,
		onDrift,
		onCraftingUpdate,
	});

	// Start bandwidth rollup logging (5-minute windows)
	bandwidthTracker.start();

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
	});
	log.info(`Dispatcher running on port ${server.port}. Press Ctrl+C to stop.`);

	// Connect all owned accounts in the background (the lib staggers connections
	// internally). The server is already serving; accounts come online as they
	// connect, and loops/jobs resume once the bulk connect finishes.
	log.info("Connecting accounts in the background...");
	connectAccounts(manager, store, server)
		.then(() => {
			// Run one drift sweep pass as soon as the fleet is connected, instead of
			// waiting up to a full intervalMs for the first scheduled pass —
			// startDriftSweep() was called before any accounts existed to sweep.
			void driftSweep.runOnce();
		})
		.catch((err) => {
			log.error(`Background account connection failed: ${errorMessage(err)}`);
		});

	// Graceful shutdown
	const shutdown = (): void => {
		log.info("Shutting down...");
		driftSweep.stop();
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
 * Connect all owned accounts, log their initial state, then resume persisted
 * loops and interrupted async jobs. Runs in the background so the HTTP server
 * can serve health/queries while accounts come online.
 */
async function connectAccounts(
	manager: LibAccountManager,
	store: StateStore,
	server: { loopManager: LoopManager; jobManager: JobManager },
): Promise<void> {
	await manager.connect();
	const connected = manager.getAll();

	if (connected.length === 0) {
		log.warn("No accounts connected at startup. The server is up; add accounts via the API.");
		return;
	}

	// Log initial state for each connected account
	for (const account of connected) {
		const state = store.getState(playerIdOf(account));
		if (state) {
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
		} else {
			log.warn(`[${account.id ?? "?"}] No state available`);
		}
	}

	// Auto-resume persisted loops and interrupted async jobs for all connected accounts
	await resumeLoops(server.loopManager, manager, CONFIG_DIR);
	await resumeJobs(server.jobManager, manager);
}

/**
 * Resume all pending jobs (interrupted by a daemon restart) for all connected accounts.
 */
async function resumeJobs(jobManager: JobManager, manager: LibAccountManager): Promise<void> {
	for (const account of manager.getAll()) {
		await resumeJobsForAccount(jobManager, manager, playerIdOf(account));
	}
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
		const goalCtx = makeLibGoalContext(account);

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
export async function resumeLoops(
	loopManager: LoopManager,
	manager: LibAccountManager,
	configDir: string,
): Promise<void> {
	const configs = await LoopManager.loadLoopConfigs(configDir);
	if (configs.length === 0) {
		return;
	}

	log.info(`Found ${configs.length} persisted loop config(s), resuming...`);

	type StartFn = (playerId: string, options: never, account: LibManagedAccount) => unknown;

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
			(startFn as (pid: string, opts: Record<string, unknown>, acct: LibManagedAccount) => unknown)(
				config.playerId,
				config.options,
				account,
			);
			log.info(`[${config.playerId}] Resumed ${config.type} loop`);
		} catch (err) {
			log.warn(`[${config.playerId}] Failed to resume ${config.type} loop: ${errorMessage(err)}`);
		}
	}
}

if (import.meta.main) {
	main().catch((err) => {
		log.error(`Fatal error: ${errorMessage(err)}`);
		process.exit(1);
	});
}
