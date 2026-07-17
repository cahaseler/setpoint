import type { Database } from "bun:sqlite";
import type { SpacemoltClient } from "@spacemolt/lib";
import type { LibAccountManager } from "../accounts/lib-manager.js";
import type { CombatEventsStore } from "../state/combat-events-store.js";
import type { CraftingEventsStore } from "../state/crafting-events-store.js";
import type { StateStore } from "../state/store.js";
import { createLogger } from "../util/logger.js";
import type { ExecutingGoalEntry } from "./account-release.js";
import {
	type HandlerContext,
	handleAbortAccount,
	handleAddAccount,
	handleCombatEvents,
	handleCraftingEvents,
	handleDashboardData,
	handleDeleteAccount,
	handleExecuteGoal,
	handleExecuteGoalAsync,
	handleGetAccount,
	handleGetGoalSchemas,
	handleGetJob,
	handleGetLogLevel,
	handleGetLoop,
	handleGetLoopSchemas,
	handleGetMarket,
	handleGetObservation,
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

/**
 * Whether a request can legitimately block — either on a tick-based game
 * mutation for longer than Bun's 255s idleTimeout cap, or as a long-lived SSE
 * stream meant to stay open indefinitely — and so needs that cap disabled
 * entirely via `server.timeout(req, 0)`. Mirrors the CLI's own
 * `GAME_API_TIMEOUT_MS=0` treatment of the mutation routes (sync goal, raw,
 * accounts register, accounts remove, abort) in `src/cli/commands.ts`.
 */
export function isUnboundedRequest(req: Request): boolean {
	const { pathname } = new URL(req.url);
	if (req.method === "GET") {
		return /\/(crafting|combat)\/events$/.test(pathname);
	}
	if (req.method === "POST") {
		return (
			/\/goal$/.test(pathname) ||
			/\/raw$/.test(pathname) ||
			pathname === "/accounts/register" ||
			/\/loop$/.test(pathname)
		);
	}
	if (req.method === "DELETE") {
		return /^\/accounts\/[^/]+$/.test(pathname) || /\/abort$/.test(pathname);
	}
	return false;
}

export interface ServerOptions {
	port?: number;
	manager: LibAccountManager;
	store: StateStore;
	db: Database;
	client: SpacemoltClient;
	configDir: string;
	craftingEventsStore: CraftingEventsStore;
	combatEventsStore: CombatEventsStore;
	/**
	 * Shared with the caller (rather than constructed privately here) so
	 * combat detection — wired into `LibAccountManager` before `startServer()`
	 * runs — can force-release an account's in-progress work through the same
	 * bookkeeping this server's own force-abort route uses. Defaults to a
	 * fresh `Map`/`Set` for callers (tests) that don't need to share them.
	 */
	executingGoals?: Map<string, ExecutingGoalEntry>;
	claimedAccounts?: Set<string>;
}

export interface DispatcherServer {
	port: number;
	loopManager: LoopManager;
	jobManager: JobManager;
	stop(): Promise<void>;
}

export const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Wait for `work` up to `ms`, then stop waiting regardless. Returns whether
 * the deadline was hit before `work` settled. `work` itself is never
 * cancelled — this only bounds how long the caller waits for it.
 */
async function waitUpTo(ms: number, work: Promise<unknown>): Promise<boolean> {
	let timedOut = false;
	const timeout = new Promise<void>((resolve) => {
		setTimeout(() => {
			timedOut = true;
			resolve();
		}, ms);
	});
	await Promise.race([work, timeout]);
	return timedOut;
}

/**
 * Give in-flight requests a grace period to finish normally before giving up
 * on waiting. `server.stop()`'s default graceful drain waits for every open
 * connection to close on its own — but a long-lived SSE stream
 * (`GET /accounts/:playerId/crafting/events`) never finishes by itself, so an
 * unbounded graceful drain would hang shutdown indefinitely as long as any
 * client keeps one open.
 *
 * Does NOT fall back to `server.stop(true)` on timeout — verified live that
 * calling it while an earlier unresolved `server.stop()` call is still
 * pending never resolves either (a Bun quirk, not documented). Instead this
 * just stops waiting and returns; the caller (`index.ts`'s shutdown handler)
 * calls `process.exit()` shortly after, which tears down any still-open
 * sockets at the OS level regardless of Bun's internal state.
 */
export async function stopServerWithGracePeriod(
	server: { stop(closeActiveConnections?: boolean): Promise<void> },
	graceMs: number,
): Promise<void> {
	const timedOut = await waitUpTo(graceMs, server.stop());
	if (timedOut) {
		log.warn(
			`Shutdown grace period (${graceMs}ms) elapsed with connections still open — proceeding without waiting further`,
		);
	}
}

/**
 * Stop loops, then drain HTTP — each phase bounded independently by
 * `graceMs` (worst case `~2 * graceMs`, not unbounded). `abortLoop()` only
 * flips the abort signal; a loop mid-mutation (e.g. mid-transit — per
 * CLAUDE.md, an awaited travel/jump doesn't resolve until arrival, which can
 * be minutes) only notices it once that mutation settles, so
 * `loopManager.stopAll()` needs the same bound as the HTTP drain — otherwise
 * one slow-to-abort loop stalls shutdown indefinitely and the HTTP grace
 * period never even gets a chance to run.
 */
export async function stopGracefully(
	loopManager: { stopAll(): Promise<void> },
	server: { stop(closeActiveConnections?: boolean): Promise<void> },
	graceMs: number,
): Promise<void> {
	const loopsTimedOut = await waitUpTo(graceMs, loopManager.stopAll());
	if (loopsTimedOut) {
		log.warn(
			`Shutdown grace period (${graceMs}ms) elapsed with loop(s) still running — proceeding without waiting further`,
		);
	}
	await stopServerWithGracePeriod(server, graceMs);
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
		executingGoals: options.executingGoals ?? new Map(),
		claimedAccounts: options.claimedAccounts ?? new Set(),
		craftingEventsStore: options.craftingEventsStore,
		combatEventsStore: options.combatEventsStore,
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

	// Market / Observation (live subscription reads — subscribe first via the
	// raw passthrough: spacemolt_market.subscribe_market / spacemolt.subscribe_observation)
	router.get("/accounts/:playerId/market/:baseId", handleGetMarket);
	router.get("/accounts/:playerId/observation", handleGetObservation);

	// Crafting progress (SSE) — no subscribe-first step; the server pushes
	// crafting_update automatically whenever the account has jobs in progress.
	router.get("/accounts/:playerId/crafting/events", handleCraftingEvents);

	// Combat events (SSE) — no subscribe-first step; battle_*/player_died/
	// player_kill notifications push automatically. See CombatEventsStore.
	router.get("/accounts/:playerId/combat/events", handleCombatEvents);

	const server = Bun.serve({
		hostname: host,
		port,
		// Increase idle timeout from Bun's default 10s — sync goals, raw mutations
		// (craft batches, navigation, etc.), account registration, and account
		// removal can all take many minutes, and the default kills the
		// connection, terminating smctl with SIGTERM (exit 143).
		// 255 is the max allowed value (4.25 minutes).
		//
		// NOTE: server.timeout(req, 0) only disables the per-request deadline;
		// it does NOT override the server-level idleTimeout. Requests longer than
		// ~4 minutes WILL drop the sync connection. Use --async goals for those.
		idleTimeout: 255,
		fetch: (req, server) => {
			// Disable the per-request deadline for requests that can legitimately
			// block on a tick-based game mutation for a long time — matches the CLI's
			// own GAME_API_TIMEOUT_MS=0 treatment of these same routes (sync goal,
			// raw, accounts register, accounts remove, abort).
			// (Does not extend past the 255s idle timeout — use --async goals for long-running work.)
			if (isUnboundedRequest(req)) {
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
			await stopGracefully(loopManager, server, SHUTDOWN_GRACE_MS);
			log.info("Server stopped");
		},
	};
}
