import type { Database } from "bun:sqlite";
import type { CombatEnvelope, PirateRadioEnvelope } from "@setpoint/protocol";
import type { SpacemoltClient } from "@spacemolt/lib";
import type { LibAccountManager } from "../accounts/lib-manager.js";
import type { CombatModeStore } from "../combat/combat-mode-store.js";

import type { CraftingEventsStore } from "../state/crafting-events-store.js";
import type { EventBuffer } from "../state/event-buffer.js";
import type { StateStore } from "../state/store.js";
import { errorMessage } from "../util/errors.js";
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
	handleEnsureFleet,
	handleExecuteGoal,
	handleExecuteGoalAsync,
	handleGetAccount,
	handleGetCombatMode,
	handleGetJob,
	handleGetLogLevel,
	handleGetLoop,
	handleGetMarket,
	handleGetObservation,
	handleGetState,
	handleGetStateSection,
	handleGetSystem,
	handleHealth,
	handleListAccounts,
	handlePatchLoop,
	handlePirateRadioEvents,
	handleRawAction,
	handleRefreshState,
	handleRegisterAccount,
	handleSetCombatMode,
	handleSetLogLevel,
	handleStartLoop,
	handleStopLoop,
} from "./handlers.js";
import { type RouteHandler, errorResponse } from "./http.js";
import { JobManager } from "./job-manager.js";
import { LoopManager } from "./loop-manager.js";

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
		return /\/(crafting|combat|pirate-radio)\/events$/.test(pathname);
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
	combatEventsStore: EventBuffer<CombatEnvelope>;
	pirateRadioStore: EventBuffer<PirateRadioEnvelope>;
	combatModeStore: CombatModeStore;
	/** Whether an account is mid-battle. Late-bound: the combat reactor is built after the server. */
	isInCombat?: ((playerId: string) => boolean) | undefined;
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

/** A Bun route table: path pattern → HTTP method → handler. */
type RouteTable = Record<
	string,
	Record<string, (req: Bun.BunRequest, server: Bun.Server<undefined>) => Promise<Response>>
>;

/**
 * Adapt a handler to Bun's route signature: supply the shared context, read
 * `:param` segments off `req.params` (Bun percent-decodes them), log the
 * request, and turn a thrown handler error into a 500 rather than letting it
 * reach Bun's default error page.
 *
 * Also lifts the per-request deadline for requests that can legitimately block
 * on a tick-based game mutation or hold an SSE stream open — matching the
 * CLI's own `GAME_API_TIMEOUT_MS=0` treatment of the same routes. This does
 * not extend past the server-level 255s idleTimeout; use `--async` goals for
 * work longer than that.
 */
function route(
	handler: RouteHandler<HandlerContext>,
	ctx: HandlerContext,
): (req: Bun.BunRequest, server: Bun.Server<undefined>) => Promise<Response> {
	return async (req: Bun.BunRequest, server: Bun.Server<undefined>): Promise<Response> => {
		if (isUnboundedRequest(req)) {
			server.timeout(req, 0);
		}
		log.info(`${req.method} ${new URL(req.url).pathname}`);
		try {
			return await handler(req, req.params as Record<string, string>, ctx);
		} catch (err) {
			log.error(`Handler error: ${errorMessage(err)}`);
			return errorResponse("Internal server error", 500);
		}
	};
}

/**
 * The daemon's full route table, in Bun's `routes` shape.
 *
 * Bun matches by specificity rather than declaration order, so a static
 * segment always beats a `:param` one (`/accounts/register` wins over
 * `/accounts/:playerId`) regardless of where each appears here. Anything
 * unmatched falls through to `Bun.serve`'s `fetch`, which 404s.
 *
 * Exported so tests can serve the real table instead of re-declaring paths —
 * a route registered here at the wrong path is then a test failure, not a
 * silent 404 in production.
 */
export function buildRoutes(ctx: HandlerContext): RouteTable {
	const r = (handler: RouteHandler<HandlerContext>) => route(handler, ctx);
	return {
		"/dashboard/data": { GET: r(handleDashboardData) },
		"/health": { GET: r(handleHealth) },

		// Accounts
		"/accounts": { GET: r(handleListAccounts), POST: r(handleAddAccount) },
		"/accounts/register": { POST: r(handleRegisterAccount) },
		"/accounts/:playerId": { GET: r(handleGetAccount), DELETE: r(handleDeleteAccount) },

		// State
		"/accounts/:playerId/state": { GET: r(handleGetState) },
		"/accounts/:playerId/state/refresh": { POST: r(handleRefreshState) },
		"/accounts/:playerId/state/:section": { GET: r(handleGetStateSection) },

		// Goals & Raw
		"/accounts/:playerId/goal": { POST: r(handleExecuteGoal) },
		"/accounts/:playerId/goal/async": { POST: r(handleExecuteGoalAsync) },
		"/accounts/:playerId/raw": { POST: r(handleRawAction) },
		"/accounts/:playerId/abort": { DELETE: r(handleAbortAccount) },

		// Jobs
		"/jobs/:jobId": { GET: r(handleGetJob) },

		// Loops
		"/accounts/:playerId/loop": {
			GET: r(handleGetLoop),
			POST: r(handleStartLoop),
			PATCH: r(handlePatchLoop),
			DELETE: r(handleStopLoop),
		},

		"/accounts/:playerId/fleet": { POST: r(handleEnsureFleet) },

		"/accounts/:playerId/combat-mode": {
			GET: r(handleGetCombatMode),
			PATCH: r(handleSetCombatMode),
		},

		// Config
		"/log-level": { GET: r(handleGetLogLevel), POST: r(handleSetLogLevel) },

		// System data (routed through a specific account)
		"/accounts/:playerId/system": { GET: r(handleGetSystem) },
		"/accounts/:playerId/system/:systemId": { GET: r(handleGetSystem) },

		// Market / Observation (live subscription reads — subscribe first via the
		// raw passthrough: spacemolt_market.subscribe_market / spacemolt.subscribe_observation)
		"/accounts/:playerId/market/:baseId": { GET: r(handleGetMarket) },
		"/accounts/:playerId/observation": { GET: r(handleGetObservation) },

		// Crafting progress (SSE) — no subscribe-first step; the server pushes
		// crafting_update automatically whenever the account has jobs in progress.
		"/accounts/:playerId/crafting/events": { GET: r(handleCraftingEvents) },

		// Combat events (SSE) — no subscribe-first step; battle_*/player_died/
		// player_kill notifications push automatically. See state/event-buffer.ts.
		"/accounts/:playerId/combat/events": { GET: r(handleCombatEvents) },
		// Also push-only with no subscribe step: the server sends pirate_radio
		// to any account in range to intercept a transmission.
		"/accounts/:playerId/pirate-radio/events": { GET: r(handlePirateRadioEvents) },
	};
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
		pirateRadioStore: options.pirateRadioStore,
		combatModeStore: options.combatModeStore,
		isInCombat: options.isInCombat,
	};

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
		routes: buildRoutes(ctx),
		fetch: () => errorResponse("Not found", 404),
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
