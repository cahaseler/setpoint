import type { Database } from "bun:sqlite";
import type { AccountManager } from "../accounts/manager.js";
import type { SpaceMoltClient } from "../api/client.js";
import type { StateStore } from "../state/store.js";
import { createLogger } from "../util/logger.js";
import {
	type HandlerContext,
	handleAbortAccount,
	handleAddAccount,
	handleDashboardData,
	handleDeleteAccount,
	handleExecuteGoal,
	handleExecuteGoalAsync,
	handleGameProxy,
	handleGetAccount,
	handleGetGoalSchemas,
	handleGetJob,
	handleGetLogLevel,
	handleGetLoop,
	handleGetLoopSchemas,
	handleGetSessionId,
	handleGetState,
	handleGetStateSection,
	handleGetSystem,
	handleHealth,
	handleListAccounts,
	handleMigrateIds,
	handlePatchLoop,
	handleRawAction,
	handleRefreshState,
	handleRegisterAccount,
	handleSetLogLevel,
	handleStartLoop,
	handleStopLoop,
} from "./handlers.js";
import { JobManager } from "./job-manager.js";
import { LoopManager } from "./loop-manager.js";
import { Router } from "./router.js";

const log = createLogger("server");

/**
 * Resolve the network interface the HTTP server binds to.
 *
 * Defaults to loopback (127.0.0.1): the daemon has no authentication, so it
 * must not be reachable from the network. Set SM_HOST to bind a different
 * interface (e.g. 0.0.0.0) only on a trusted, isolated host.
 */
export function resolveBindHost(env: Record<string, string | undefined> = process.env): string {
	return env["SM_HOST"] ?? "127.0.0.1";
}

export interface ServerOptions {
	port?: number;
	manager: AccountManager;
	store: StateStore;
	db: Database;
	client: SpaceMoltClient;
	configDir: string;
}

export interface DispatcherServer {
	port: number;
	loopManager: LoopManager;
	jobManager: JobManager;
	stop(): Promise<void>;
}

/**
 * Start the dispatcher HTTP API server.
 *
 * Returns a handle with the port and a stop() function for graceful shutdown.
 */
export function startServer(options: ServerOptions): DispatcherServer {
	const port = options.port ?? 7580;
	const host = resolveBindHost();
	const loopManager = new LoopManager();
	loopManager.setConfigDir(options.configDir);
	const jobManager = new JobManager(options.db);

	const ctx: HandlerContext = {
		manager: options.manager,
		store: options.store,
		loopManager,
		jobManager,
		client: options.client,
		configDir: options.configDir,
		startedAt: new Date().toISOString(),
		executingGoals: new Map(),
	};

	const router = new Router<HandlerContext>();

	// Dashboard
	router.get("/dashboard/data", handleDashboardData);

	// Health
	router.get("/health", handleHealth);

	// Accounts
	router.get("/accounts", handleListAccounts);
	router.get("/accounts/:playerId", handleGetAccount);
	router.post("/accounts", handleAddAccount);
	router.post("/accounts/register", handleRegisterAccount);
	router.delete("/accounts/:playerId", handleDeleteAccount);

	// Session
	router.get("/accounts/:playerId/session", handleGetSessionId);

	// State
	router.get("/accounts/:playerId/state", handleGetState);
	router.post("/accounts/:playerId/state/refresh", handleRefreshState);
	router.get("/accounts/:playerId/state/:section", handleGetStateSection);

	// Goals & Raw
	router.post("/accounts/:playerId/goal/async", handleExecuteGoalAsync);
	router.post("/accounts/:playerId/goal", handleExecuteGoal);
	router.post("/accounts/:playerId/raw", handleRawAction);
	router.delete("/accounts/:playerId/abort", handleAbortAccount);

	// Jobs
	router.get("/jobs/:jobId", handleGetJob);

	// Loops
	router.get("/accounts/:playerId/loop", handleGetLoop);
	router.post("/accounts/:playerId/loop", handleStartLoop);
	router.patch("/accounts/:playerId/loop", handlePatchLoop);
	router.delete("/accounts/:playerId/loop", handleStopLoop);

	// Config
	router.get("/log-level", handleGetLogLevel);
	router.post("/log-level", handleSetLogLevel);

	// ID Migration
	router.post("/migrate-ids", handleMigrateIds);

	// Schemas (goal/loop schema registry)
	router.get("/schemas/goals", handleGetGoalSchemas);
	router.get("/schemas/loops", handleGetLoopSchemas);

	// System data (routed through specific account)
	router.get("/accounts/:playerId/system", handleGetSystem);
	router.get("/accounts/:playerId/system/:systemId", handleGetSystem);

	// Transparent game-API proxy for the spacemolt CLI (smctl raw points the
	// binary here via SPACEMOLT_URL so its egress is branded + compressed +
	// tracked). Forwards any /api/v2/* sub-path to the game server.
	router.get("/gameproxy/*", handleGameProxy);
	router.post("/gameproxy/*", handleGameProxy);

	const server = Bun.serve({
		hostname: host,
		port,
		// Increase idle timeout from Bun's default 10s — sync goals can take
		// many minutes (craft batches, navigation, etc.) and the default kills
		// the connection, terminating smctl with SIGTERM (exit 143).
		// 255 is the max allowed value (4.25 minutes).
		//
		// NOTE: server.timeout(req, 0) only disables the per-request deadline;
		// it does NOT override the server-level idleTimeout. Goals longer than
		// ~4 minutes WILL drop the sync connection. Use --async for those.
		idleTimeout: 255,
		fetch: (req, server) => {
			// Disable per-request deadline for sync goal requests.
			// (Does not extend past the 255s idle timeout — use --async for long goals.)
			if (req.method === "POST" && /\/goal$/.test(new URL(req.url).pathname)) {
				server.timeout(req, 0);
			}
			return router.handle(req, ctx);
		},
	});

	const actualPort = server.port ?? port;
	log.info(`Server listening on http://${host}:${actualPort}`);

	return {
		port: actualPort,
		loopManager,
		jobManager,
		stop: async () => {
			await loopManager.stopAll();
			server.stop();
			log.info("Server stopped");
		},
	};
}
