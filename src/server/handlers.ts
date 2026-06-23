import { randomBytes } from "node:crypto";
import {
	loadRegistrationConfig,
	parseAccountConfig,
	parseAccountCredentials,
	saveAccountConfig,
} from "../accounts/config.js";
import type { AccountManager } from "../accounts/manager.js";
import type { SpaceMoltClient } from "../api/client.js";
import type { ProgressRef } from "../dispatcher/goals.js";
import { STATE_SECTION_KEYS, type StateSectionKey, type StateStore } from "../state/store.js";
import { ApiError, HttpError, errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { type LogLevel, getLogLevel, setLogLevel } from "../util/logger.js";
import { createGoal, deprecatedTypeMessage, getGoalTypes } from "./goal-registry.js";
import type { JobManager } from "./job-manager.js";
import { buildGoalContext } from "./loop-manager.js";
import type {
	EnhancedMiningLoopApiOptions,
	ExplorationLoopApiOptions,
	GuardLoopApiOptions,
	HaulingLoopApiOptions,
	LoopManager,
	LoopStatus,
	MiningLoopApiOptions,
	RoamingSalvageLoopApiOptions,
	SalvageLoopApiOptions,
	StorageTransferLoopApiOptions,
	TradingLoopApiOptions,
} from "./loop-manager.js";
import { type RouteParams, errorResponse, jsonResponse } from "./router.js";
import { getGoalSchemas, getLoopSchemas } from "./schemas.js";

const log = createLogger("handlers");

/** Shared context available to all handlers. */
export interface HandlerContext {
	manager: AccountManager;
	store: StateStore;
	loopManager: LoopManager;
	jobManager: JobManager;
	client: SpaceMoltClient;
	configDir: string;
	startedAt: string;
	/** Accounts with a synchronous goal currently executing. Used to prevent races. */
	executingGoals: Map<
		string,
		{
			goalType: string;
			goalOptions?: Record<string, unknown>;
			startedAt: string;
			controller: AbortController;
			progress: ProgressRef;
			promise: Promise<unknown>;
		}
	>;
}

/** Resolve an account by player_id or username (case-insensitive). */
function resolveAccount(
	ctx: HandlerContext,
	idOrName: string,
): import("../accounts/manager.js").ManagedAccount | undefined {
	return ctx.manager.getByPlayerId(idOrName) ?? ctx.manager.getByUsername(idOrName);
}

// ── Health ──────────────────────────────────────────────────────────

export function handleHealth(_req: Request, _params: RouteParams, ctx: HandlerContext): Response {
	return jsonResponse({
		status: "ok",
		uptime: Date.now() - new Date(ctx.startedAt).getTime(),
		startedAt: ctx.startedAt,
		accounts: ctx.manager.size,
	});
}

// ── Accounts ────────────────────────────────────────────────────────

export function handleListAccounts(
	_req: Request,
	_params: RouteParams,
	ctx: HandlerContext,
): Response {
	const connected = ctx.manager.getAll().map((a) => {
		const state = ctx.store.getState(a.config.player_id);
		return {
			player_id: a.config.player_id,
			username: a.config.username,
			status: "connected" as const,
			credits: state?.player?.credits ?? null,
			ship: state?.ship
				? {
						hull: state.ship.hull,
						max_hull: state.ship.max_hull,
						fuel: state.ship.fuel,
						max_fuel: state.ship.max_fuel,
						cargo_used: state.ship.cargo_used,
						cargo_capacity: state.ship.cargo_capacity,
					}
				: null,
			location: state?.location
				? {
						system: state.location.system_name,
						poi: state.location.poi_name,
						docked: state.location.docked_at ?? null,
					}
				: null,
			loop: ctx.loopManager.getStatus(a.config.player_id) ?? null,
		};
	});

	const pending = ctx.manager.getAllPending().map((p) => ({
		player_id: p.playerId ?? null,
		username: p.username,
		status: p.status,
		error: p.error ?? null,
		credits: null,
		ship: null,
		location: null,
		loop: null,
	}));

	return jsonResponse({ accounts: [...connected, ...pending] });
}

export function handleGetAccount(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Response {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (account) {
		const actualId = account.config.player_id;
		const state = ctx.store.getState(actualId);

		return jsonResponse({
			player_id: actualId,
			username: account.config.username,
			status: "connected",
			state: state
				? {
						credits: state.player?.credits,
						ship: state.ship
							? {
									hull: state.ship.hull,
									max_hull: state.ship.max_hull,
									fuel: state.ship.fuel,
									max_fuel: state.ship.max_fuel,
								}
							: null,
						location: state.location
							? {
									system: state.location.system_name,
									poi: state.location.poi_name,
									docked: state.location.docked_at ?? null,
								}
							: null,
					}
				: null,
			loop: ctx.loopManager.getStatus(actualId) ?? null,
			hasRunningJob: ctx.jobManager.isRunning(actualId),
			runningJob: ctx.jobManager.getRunningJob(actualId) ?? null,
			hasExecutingGoal: ctx.executingGoals.has(actualId),
			executingGoal: ctx.executingGoals.get(actualId) ?? null,
			recentJobs: ctx.jobManager.listByAccount(actualId, 5),
		});
	}

	// Check pending queue by player_id or by username
	const pending = ctx.manager.getPendingByPlayerId(playerId) ?? ctx.manager.getPending(playerId);
	if (pending) {
		return jsonResponse({
			player_id: pending.playerId ?? null,
			username: pending.username,
			status: pending.status,
			error: pending.error ?? null,
			state: null,
			loop: null,
		});
	}

	return errorResponse("Account not found", 404);
}

export async function handleAddAccount(
	req: Request,
	_params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	// Try full config (username + password + player_id) first
	try {
		const config = parseAccountConfig(body, "api");

		try {
			const pending = ctx.manager.queueAccount(config);
			return jsonResponse(
				{
					player_id: pending.playerId ?? null,
					username: pending.username,
					status: pending.status,
					message: "Account queued for connection",
				},
				202,
			);
		} catch (err) {
			return errorResponse(err instanceof Error ? err.message : "Failed to queue account", 409);
		}
	} catch {
		// Fall through to credentials-only path
	}

	// Try credentials-only (username + password, discover player_id via login)
	let credentials: { username: string; password: string };
	try {
		credentials = parseAccountCredentials(body, "api");
	} catch (err) {
		return errorResponse(
			err instanceof Error ? err.message : "Invalid account config: need username and password",
			400,
		);
	}

	try {
		const pending = ctx.manager.queueByCredentials(credentials);
		return jsonResponse(
			{
				player_id: pending.playerId ?? null,
				username: pending.username,
				status: pending.status,
				message: "Account queued for connection",
			},
			202,
		);
	} catch (err) {
		return errorResponse(err instanceof Error ? err.message : "Failed to queue account", 409);
	}
}

export async function handleDeleteAccount(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (account) {
		const actualId = account.config.player_id;
		// Stop any running loop first
		if (ctx.loopManager.isRunning(actualId)) {
			ctx.loopManager.abortLoop(actualId);
			const loopPromise = ctx.loopManager.getPromise(actualId);
			if (loopPromise) await loopPromise.catch(() => {});
		}

		// Delete persisted loop config
		ctx.loopManager.deleteLoopConfig(actualId, ctx.configDir).catch((err) => {
			log.warn(`Failed to delete loop config: ${errorMessage(err)}`);
		});

		ctx.manager.disconnectAccount(actualId);
		return jsonResponse({ message: "Account disconnected", player_id: actualId });
	}

	// Check pending queue by player_id or username
	const pending = ctx.manager.getPendingByPlayerId(playerId) ?? ctx.manager.getPending(playerId);
	if (pending) {
		ctx.manager.removePending(pending.username);
		return jsonResponse({ message: "Pending account removed", username: pending.username });
	}

	return errorResponse("Account not found", 404);
}

// ── Registration ────────────────────────────────────────────────────

const VALID_EMPIRES = new Set(["solarian", "voidborn", "crimson", "nebula", "outerrim"]);

export async function handleRegisterAccount(
	req: Request,
	_params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const username = typed["username"];
	const empire = typed["empire"];

	if (typeof username !== "string" || username.length < 3 || username.length > 24) {
		return errorResponse("username is required (string, 3-24 chars)", 400);
	}

	if (typeof empire !== "string" || !VALID_EMPIRES.has(empire)) {
		return errorResponse(`empire is required. Valid: ${[...VALID_EMPIRES].join(", ")}`, 400);
	}

	// Check for duplicate username
	if (ctx.manager.getByUsername(username)) {
		return errorResponse(`Account with username "${username}" already connected`, 409);
	}

	// Load registration code
	let registrationCode: string;
	try {
		const regConfig = await loadRegistrationConfig(`${ctx.configDir}/registration.json`);
		registrationCode = regConfig.registration_code;
	} catch (err) {
		return errorResponse(`Failed to load registration config: ${errorMessage(err)}`, 500);
	}

	// Generate a random password
	const password = randomBytes(18).toString("base64url");

	try {
		// Create a temporary session for registration
		const sessionResponse = await ctx.client.createSession();
		const sessionId = sessionResponse.session?.id;
		if (!sessionId) {
			return errorResponse("Failed to create session for registration", 500);
		}

		// Register the account
		const registerResponse = await ctx.client.authAction<Record<string, unknown>>(
			"register",
			{
				username,
				password,
				registration_code: registrationCode,
				empire: empire as "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim",
			},
			sessionId,
		);

		// Extract player_id from the response
		const playerId =
			registerResponse.session?.player_id ??
			(registerResponse.structuredContent["player_id"] as string | undefined);

		if (!playerId) {
			return errorResponse("Registration succeeded but no player_id returned", 500);
		}

		const config = { username, password, player_id: playerId };

		// Save config to disk
		await saveAccountConfig(config, ctx.configDir);

		// Connect the account
		await ctx.manager.connectAccount(config);

		return jsonResponse(
			{
				player_id: playerId,
				username,
				password,
				message: "Account registered and connected",
			},
			201,
		);
	} catch (err) {
		return errorResponse(`Registration failed: ${errorMessage(err)}`, 500);
	}
}

// ── Session ─────────────────────────────────────────────────────────

export async function handleGetSessionId(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const sessionId = account.session.sessionId;
	if (!sessionId) {
		return errorResponse("Session not available (account may be reconnecting)", 503);
	}

	// Validate the session is still alive by making a lightweight query.
	// This triggers auto-recovery if the game server dropped the session.
	try {
		await account.session.execute("spacemolt", "get_player");
	} catch {
		// Recovery may have failed — return whatever session we have now
	}

	const freshSessionId = account.session.sessionId;
	if (!freshSessionId) {
		return errorResponse("Session not available (recovery failed)", 503);
	}

	return jsonResponse({
		session_id: freshSessionId,
		player_id: account.config.player_id,
		username: account.config.username,
	});
}

// ── Goals ───────────────────────────────────────────────────────────

export async function handleExecuteGoal(
	req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const actualId = account.config.player_id;

	// Block if a loop is running
	if (ctx.loopManager.isRunning(actualId)) {
		return errorResponse("A loop is running on this account. Stop it first.", 409);
	}

	// Block if an async goal job is already running
	if (ctx.jobManager.isRunning(actualId)) {
		return errorResponse("An async goal job is already running on this account.", 409);
	}

	// Wait for any in-progress sync goal to finish before proceeding.
	// This serializes concurrent callers per-account instead of rejecting with 409.
	if (ctx.executingGoals.has(actualId)) {
		const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes — goals can be long
		const POLL_MS = 500;
		const deadline = Date.now() + MAX_WAIT_MS;
		const waiting = ctx.executingGoals.get(actualId);
		log.info(
			`Goal queued for ${playerId}: waiting for ${waiting?.goalType ?? "unknown"} to finish`,
		);
		while (ctx.executingGoals.has(actualId) && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
		}
		if (ctx.executingGoals.has(actualId)) {
			return errorResponse("Timed out waiting for previous goal to complete on this account.", 409);
		}
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const goalType = typed["type"];

	if (typeof goalType !== "string") {
		return errorResponse(`type is required (string). Supported: ${getGoalTypes().join(", ")}`, 400);
	}

	const deprecated = deprecatedTypeMessage(goalType);
	if (deprecated) {
		return errorResponse(deprecated, 410);
	}

	const options = typed["options"];
	const opts: Record<string, unknown> =
		typeof options === "object" && options !== null && !Array.isArray(options)
			? (options as Record<string, unknown>)
			: {};

	let goal: ReturnType<typeof createGoal>;
	try {
		goal = createGoal(goalType, opts);
	} catch (err) {
		return errorResponse(err instanceof Error ? err.message : "Invalid goal options", 400);
	}

	const startTime = Date.now();
	log.info(`[${actualId}] Sync goal started: ${goalType}`);

	const goalController = new AbortController();
	const progress: ProgressRef = {
		goalType,
		goalOptions: opts,
		completedSteps: [],
		remainingSteps: [],
	};

	const goalCtx = buildGoalContext(account, ctx.store, goalController.signal);
	const goalPromise = goal.execute(goalCtx);

	ctx.executingGoals.set(actualId, {
		goalType,
		goalOptions: opts,
		startedAt: new Date().toISOString(),
		controller: goalController,
		progress,
		promise: goalPromise,
	});

	// Stream the response rather than blocking on goalPromise.
	//
	// Bun's server-level idleTimeout (max 255s) closes connections where no data
	// is flowing regardless of the per-request timeout override. For goals that take
	// longer than ~4 minutes (long-distance navigation, multi-hop fuel rescues, etc.)
	// the connection would be killed mid-execution.
	//
	// Fix: return a ReadableStream and write a keepalive newline every 30s.
	// Bun resets the idle timer whenever data is sent, so the connection stays alive
	// for arbitrarily long goals. JSON.parse (used by response.json() on the client)
	// handles leading whitespace, so no client-side changes are needed.
	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();

	const KEEPALIVE_INTERVAL_MS = 30_000;
	const keepaliveTimer = setInterval(() => {
		writer.write(encoder.encode("\n")).catch(() => clearInterval(keepaliveTimer));
	}, KEEPALIVE_INTERVAL_MS);

	const reqSignal = req.signal;
	let clientAborted = false;
	const onAbort = (): void => {
		clientAborted = true;
		clearInterval(keepaliveTimer);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		log.warn(
			`[${actualId}] Client disconnected during ${goalType} after ${elapsed}s — cleaning up executingGoals lock`,
		);
		ctx.executingGoals.delete(actualId);
		writer.close().catch(() => {});
	};
	reqSignal.addEventListener("abort", onAbort);

	goalPromise
		.then(async (result) => {
			clearInterval(keepaliveTimer);
			reqSignal.removeEventListener("abort", onAbort);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

			if (clientAborted) {
				log.warn(
					`[${actualId}] ${goalType} completed in ${elapsed}s but client already disconnected`,
				);
				return;
			}

			log.info(`[${actualId}] Sync goal completed: ${goalType} in ${elapsed}s`);
			ctx.executingGoals.delete(actualId);
			// Refresh state after completion: many mutation responses (deposit, sell, etc.)
			// don't include V2GameState, leaving the state store stale.
			// Runs after clearing executingGoals so a slow/hung getState can't
			// leave the flag stuck.
			try {
				await goalCtx.endpoints.getState();
			} catch {
				// Non-critical — state may be slightly stale if this fails
			}
			await writer.write(encoder.encode(JSON.stringify(result))).catch(() => {});
			await writer.close().catch(() => {});
		})
		.catch(async (err) => {
			clearInterval(keepaliveTimer);
			reqSignal.removeEventListener("abort", onAbort);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

			if (clientAborted) {
				log.warn(
					`[${actualId}] ${goalType} failed after ${elapsed}s but client already disconnected: ${errorMessage(err)}`,
				);
				return;
			}

			log.warn(
				`[${actualId}] Sync goal failed: ${goalType} after ${elapsed}s — ${errorMessage(err)}`,
			);
			ctx.executingGoals.delete(actualId);
			await writer
				.write(encoder.encode(JSON.stringify({ error: errorMessage(err) })))
				.catch(() => {});
			await writer.close().catch(() => {});
		});

	return new Response(readable, {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

export async function handleExecuteGoalAsync(
	req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const actualId = account.config.player_id;

	// Block if a loop is running
	if (ctx.loopManager.isRunning(actualId)) {
		return errorResponse("A loop is running on this account. Stop it first.", 409);
	}

	// Block if an async goal job is already running
	if (ctx.jobManager.isRunning(actualId)) {
		return errorResponse("An async goal job is already running on this account.", 409);
	}

	// Block if a sync goal is currently executing
	if (ctx.executingGoals.has(actualId)) {
		return errorResponse("A goal is already executing on this account. Try again shortly.", 409);
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const goalType = typed["type"];

	if (typeof goalType !== "string") {
		return errorResponse(`type is required (string). Supported: ${getGoalTypes().join(", ")}`, 400);
	}

	const deprecated = deprecatedTypeMessage(goalType);
	if (deprecated) {
		return errorResponse(deprecated, 410);
	}

	const options = typed["options"];
	const opts: Record<string, unknown> =
		typeof options === "object" && options !== null && !Array.isArray(options)
			? (options as Record<string, unknown>)
			: {};

	let goal: ReturnType<typeof createGoal>;
	try {
		goal = createGoal(goalType, opts);
	} catch (err) {
		return errorResponse(err instanceof Error ? err.message : "Invalid goal options", 400);
	}

	const job = ctx.jobManager.create(actualId, goalType, opts);

	try {
		const jobController = new AbortController();
		const jobProgress: ProgressRef = {
			goalType,
			goalOptions: opts,
			completedSteps: [],
			remainingSteps: [],
		};
		const goalCtx = buildGoalContext(account, ctx.store, jobController.signal);
		const jobPromise = goal
			.execute(goalCtx)
			.then(async (result) => {
				// Refresh state after completion: many mutation responses (deposit, sell, etc.)
				// don't include V2GameState, leaving the state store stale.
				try {
					await goalCtx.endpoints.getState();
				} catch {
					// Non-critical — state may be slightly stale if this fails
				}
				ctx.jobManager.complete(job.jobId, result);
			})
			.catch((err: unknown) => {
				const errMsg = errorMessage(err);
				log.error(`[${actualId}] Async job ${job.jobId} (${goalType}) failed: ${errMsg}`);
				ctx.jobManager.fail(job.jobId, errMsg);
			});
		ctx.jobManager.registerExecution(job.jobId, jobController, jobProgress, jobPromise);
	} catch (err) {
		ctx.jobManager.fail(job.jobId, errorMessage(err));
		return errorResponse(`Goal setup failed: ${errorMessage(err)}`, 500);
	}

	return jsonResponse({ job_id: job.jobId }, 202);
}

export function handleGetJob(_req: Request, params: RouteParams, ctx: HandlerContext): Response {
	const jobId = params["jobId"];
	if (!jobId) {
		return errorResponse("Missing jobId", 400);
	}

	const job = ctx.jobManager.get(jobId);
	if (!job) {
		return errorResponse("Job not found", 404);
	}

	return jsonResponse(job);
}

// ── Raw API Passthrough ─────────────────────────────────────────────

// The raw passthrough tool group and action become path segments in the
// upstream URL (/api/v2/<toolGroup>/<action>). Restrict them to a safe
// character set so a network caller cannot inject "../" or other path/URL
// metacharacters to reach a different endpoint.
const RAW_SEGMENT_PATTERN = /^[A-Za-z0-9_]+$/;

export async function handleRawAction(
	req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const toolGroup = typed["toolGroup"];
	const action = typed["action"];
	const rawParams = typed["params"];

	if (typeof toolGroup !== "string" || toolGroup.length === 0) {
		return errorResponse("toolGroup is required (string)", 400);
	}

	if (typeof action !== "string" || action.length === 0) {
		return errorResponse("action is required (string)", 400);
	}

	if (!RAW_SEGMENT_PATTERN.test(toolGroup)) {
		return errorResponse("toolGroup contains invalid characters", 400);
	}

	if (!RAW_SEGMENT_PATTERN.test(action)) {
		return errorResponse("action contains invalid characters", 400);
	}

	const actionParams: Record<string, unknown> =
		typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)
			? (rawParams as Record<string, unknown>)
			: {};

	// Normalize tool group: the SpaceMolt API uses "spacemolt_X" prefixes (e.g.
	// "spacemolt_facility", "spacemolt_market"). Accept short names without the
	// prefix ("facility", "market") and expand them automatically.
	// The base group is just "spacemolt" (no suffix), so that passes through unchanged.
	const resolvedToolGroup = toolGroup.startsWith("spacemolt")
		? toolGroup
		: `spacemolt_${toolGroup}`;

	try {
		const response = await account.session.execute(resolvedToolGroup, action, actionParams);
		return jsonResponse({
			result: response.result,
			structuredContent: response.structuredContent,
			notifications: response.notifications,
		});
	} catch (err) {
		const apiErr = err instanceof ApiError ? ` [code: ${err.code}]` : "";
		return errorResponse(`API call failed: ${errorMessage(err)}${apiErr}`, 500);
	}
}

// ── State ───────────────────────────────────────────────────────────

export function handleGetState(_req: Request, params: RouteParams, ctx: HandlerContext): Response {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const state = ctx.store.getState(account.config.player_id);
	if (!state) {
		return errorResponse("No state available", 404);
	}

	return jsonResponse(state);
}

export async function handleRefreshState(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	try {
		// get_state returns player, ship, cargo, location, skills, missions, modules, queue
		// The session's onResponse callback automatically processes and stores the result
		await account.session.execute("spacemolt", "get_state", {});

		const state = ctx.store.getState(account.config.player_id);
		if (!state) {
			return errorResponse("No state available after refresh", 500);
		}
		return jsonResponse(state);
	} catch (err) {
		const msg = err instanceof ApiError ? err.message : errorMessage(err);
		log.error(`State refresh failed for ${playerId}: ${msg}`);
		return errorResponse(`Refresh failed: ${msg}`, 502);
	}
}

const VALID_SECTIONS = new Set<string>(STATE_SECTION_KEYS);

export function handleGetStateSection(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Response {
	const playerId = params["playerId"];
	const section = params["section"];
	if (!playerId || !section) {
		return errorResponse("Missing playerId or section", 400);
	}

	if (!VALID_SECTIONS.has(section)) {
		return errorResponse(
			`Invalid section: ${section}. Valid: ${[...VALID_SECTIONS].join(", ")}`,
			400,
		);
	}

	const sectionAccount = resolveAccount(ctx, playerId);
	if (!sectionAccount) {
		return errorResponse("Account not found", 404);
	}

	const data = ctx.store.getSection(sectionAccount.config.player_id, section as StateSectionKey);
	if (data === undefined) {
		return errorResponse(`No ${section} data available`, 404);
	}

	return jsonResponse(data);
}

// ── Loops ───────────────────────────────────────────────────────────

export function handleGetLoop(_req: Request, params: RouteParams, ctx: HandlerContext): Response {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const loopAccount = resolveAccount(ctx, playerId);
	if (!loopAccount) {
		return errorResponse("Account not found", 404);
	}

	const status = ctx.loopManager.getStatus(loopAccount.config.player_id);
	return jsonResponse(status ?? { running: false });
}

export async function handlePatchLoop(
	req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const patch = body as Record<string, unknown>;
	if (Object.keys(patch).length === 0) {
		return errorResponse("Patch body must not be empty", 400);
	}

	const current = ctx.loopManager.getStatus(account.config.player_id);
	if (!current?.running) {
		return errorResponse("No loop running on this account", 409);
	}

	// Validate patch keys against the loop's schema — the patch merges keys
	// verbatim into the persisted config, so an unknown key (e.g. a body
	// wrapped in {"options": ...}) would silently corrupt it.
	const schema = getLoopSchemas().find((s) => s.type === current.type);
	if (schema) {
		const validKeys = schema.fields.map((f) => f.name);
		const unknown = Object.keys(patch).filter((k) => !validKeys.includes(k));
		if (unknown.length > 0) {
			const hint = unknown.includes("options")
				? ' Patch fields go at the top level (e.g. {"junkItemIds":[...]}), not nested under "options".'
				: "";
			return errorResponse(
				`Unknown option key(s) for ${current.type} loop: ${unknown.map((k) => `"${k}"`).join(", ")}.${hint} Valid keys: ${validKeys.join(", ")}`,
				400,
			);
		}
	}

	const status = ctx.loopManager.patchLoopOptions(account.config.player_id, patch);
	if (!status) {
		return errorResponse("No loop running on this account", 409);
	}

	return jsonResponse(status);
}

export async function handleStopLoop(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const actualId = account.config.player_id;

	const aborted = ctx.loopManager.abortLoop(actualId);
	// Always delete persisted config — even if no in-memory loop was found,
	// there may be a stale config file from a previous run.
	ctx.loopManager.deleteLoopConfig(actualId, ctx.configDir).catch((err) => {
		log.warn(`Failed to delete loop config: ${errorMessage(err)}`);
	});

	if (!aborted) {
		return errorResponse("No loop running on this account", 404);
	}

	log.info(`[${actualId}] Loop stopped via DELETE /loop`);
	return jsonResponse({ message: "Loop stop signal sent" });
}

export async function handleStartLoop(
	req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const loopType = typed["type"];

	if (typeof loopType === "string") {
		const deprecated = deprecatedTypeMessage(loopType);
		if (deprecated) {
			return errorResponse(deprecated, 410);
		}
	}

	const supportedTypes = [
		"mining",
		"enhanced-mining",
		"salvage",
		"roaming-salvage",
		"trading",
		"hauling",
		"storage-transfer",
		"exploration",
		"guard",
	];
	if (typeof loopType !== "string" || !supportedTypes.includes(loopType)) {
		return errorResponse(
			`Unknown loop type: ${String(loopType)}. Supported: ${supportedTypes.join(", ")}`,
			400,
		);
	}

	const options = typed["options"];
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		return errorResponse("options must be a JSON object", 400);
	}

	const opts = options as Record<string, unknown>;

	const actualId = account.config.player_id;

	// If a loop is already running, stop it before starting the new one.
	// This allows the fleet brain to update a ship's target without needing
	// a separate stop call. forceRemove() evicts immediately so isRunning()
	// returns false — the old promise settles in the background.
	if (ctx.loopManager.isRunning(actualId)) {
		log.info(`[${actualId}] Replacing existing loop with new ${loopType} loop`);
		ctx.loopManager.forceRemove(actualId);
		ctx.loopManager.deleteLoopConfig(actualId, ctx.configDir).catch((err) => {
			log.warn(`Failed to delete old loop config: ${errorMessage(err)}`);
		});
	}

	try {
		let status: LoopStatus;

		if (loopType === "mining") {
			const apiOptions = validateMiningOptions(opts);
			status = ctx.loopManager.startMiningLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "enhanced-mining") {
			const apiOptions = validateEnhancedMiningOptions(opts);
			status = ctx.loopManager.startEnhancedMiningLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "trading") {
			const apiOptions = validateTradingOptions(opts);
			status = ctx.loopManager.startTradingLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "hauling") {
			const apiOptions = validateHaulingOptions(opts);
			status = ctx.loopManager.startHaulingLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "storage-transfer") {
			const apiOptions = validateStorageTransferOptions(opts);
			status = ctx.loopManager.startStorageTransferLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "salvage") {
			const apiOptions = validateSalvageOptions(opts);
			status = ctx.loopManager.startSalvageLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "roaming-salvage") {
			const apiOptions = validateRoamingSalvageOptions(opts);
			status = ctx.loopManager.startRoamingSalvageLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "exploration") {
			const apiOptions = validateExplorationOptions(opts);
			status = ctx.loopManager.startExplorationLoop(actualId, apiOptions, account, ctx.store);
		} else if (loopType === "guard") {
			const apiOptions = validateGuardOptions(opts);
			status = ctx.loopManager.startGuardLoop(actualId, apiOptions, account, ctx.store);
		} else {
			throw new HttpError(`Unsupported loop type: ${loopType}`, 400);
		}

		// Persist loop config for auto-resume on restart
		ctx.loopManager.saveLoopConfig(actualId, loopType, opts, ctx.configDir).catch((err) => {
			log.warn(`Failed to save loop config: ${errorMessage(err)}`);
		});

		return jsonResponse(status, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to start loop";
		const status = message.includes("already running") ? 409 : 400;
		return errorResponse(message, status);
	}
}

// ── Abort ────────────────────────────────────────────────────────────

/**
 * Abort an account's in-progress work.
 *
 * **Default mode** (no `force` in body): Reports what's currently running,
 * including progress (current step, remaining steps, destination info).
 * Suggests using `force: true` if the caller wants to actually stop.
 *
 * **Force mode** (`force: true` in body): Fires AbortSignal on all running
 * loops/goals/jobs and cleans up in-memory state immediately. Old promises
 * settle in the background (deep blocking waits in Session don't check
 * abort signals, so waiting for settlement can take 30s+).
 */
export async function handleAbortAccount(
	req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const actualId = account.config.player_id;

	// Parse optional body for force flag
	let force = false;
	try {
		const body = await req.json();
		if (
			typeof body === "object" &&
			body !== null &&
			(body as Record<string, unknown>)["force"] === true
		) {
			force = true;
		}
	} catch {
		// No body or invalid JSON — default mode
	}

	// Gather current status
	const loopStatus = ctx.loopManager.getStatus(actualId);
	const loopProgress = ctx.loopManager.getProgress(actualId);
	const syncGoal = ctx.executingGoals.get(actualId);
	const runningJob = ctx.jobManager.getRunningJob(actualId);
	const jobExecution = runningJob ? ctx.jobManager.getExecutionForAccount(actualId) : undefined;

	const isIdle = !loopStatus?.running && !syncGoal && !runningJob;

	if (isIdle) {
		return jsonResponse({ message: "Account is idle, nothing to abort." });
	}

	if (!force) {
		// Default mode: report status without stopping
		const status: Record<string, unknown> = {};

		if (loopStatus?.running) {
			status["loop"] = {
				type: loopStatus.type,
				startedAt: loopStatus.startedAt,
				lastStep: loopStatus.lastStep,
				options: loopStatus.options,
				progress: loopProgress ?? null,
			};
		}

		if (syncGoal) {
			status["syncGoal"] = {
				goalType: syncGoal.goalType,
				goalOptions: syncGoal.goalOptions,
				startedAt: syncGoal.startedAt,
				progress: syncGoal.progress,
			};
		}

		if (runningJob) {
			status["asyncJob"] = {
				jobId: runningJob.jobId,
				goalType: runningJob.goalType,
				goalOptions: runningJob.goalOptions,
				submittedAt: runningJob.submittedAt,
				progress: jobExecution?.progress ?? null,
			};
		}

		return jsonResponse({
			message:
				"Account has active work. Use force: true to stop immediately. Note: force-stopping may leave ship in a lawless system.",
			status,
		});
	}

	// Force mode: fire abort signals and clean up in-memory state immediately.
	// Deep blocking waits (action_in_progress retries, transit polls) in the
	// Session layer don't check abort signals, so waiting for promises to settle
	// can take 30s+. Instead, signal everything, clean up state, and let the old
	// promises settle in the background.
	log.info(`[${actualId}] Force abort initiated`);

	if (loopStatus?.running) {
		ctx.loopManager.forceRemove(actualId);
		ctx.loopManager.deleteLoopConfig(actualId, ctx.configDir).catch((err) => {
			log.warn(`Failed to delete loop config: ${errorMessage(err)}`);
		});
	}

	if (syncGoal) {
		syncGoal.controller.abort();
	}

	if (runningJob && jobExecution) {
		jobExecution.controller.abort();
	}

	// Clean up in-memory state immediately
	ctx.executingGoals.delete(actualId);
	ctx.jobManager.failAllRunning(actualId);

	log.info(`[${actualId}] Force abort complete, signals fired and state cleaned up`);
	return jsonResponse({ message: "Account aborted — abort signals fired and state cleaned up." });
}

// ── Log Level ────────────────────────────────────────────────────────

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

export function handleGetLogLevel(
	_req: Request,
	_params: RouteParams,
	_ctx: HandlerContext,
): Response {
	return jsonResponse({ level: getLogLevel() });
}

export async function handleSetLogLevel(
	req: Request,
	_params: RouteParams,
	_ctx: HandlerContext,
): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const level = typed["level"];

	if (typeof level !== "string" || !VALID_LOG_LEVELS.has(level)) {
		return errorResponse(
			`Invalid level: ${String(level)}. Valid: ${[...VALID_LOG_LEVELS].join(", ")}`,
			400,
		);
	}

	const previous = getLogLevel();
	setLogLevel(level as LogLevel);

	return jsonResponse({ level, previous });
}

// ── ID Migration ─────────────────────────────────────────────────────

/**
 * Apply an ID migration mapping to all persisted loop configs.
 *
 * Body: the categorized migration JSON (e.g. from spacemolt.com/id-migrations.json).
 * All categories are merged into a flat old→new lookup and applied to every
 * string value in every saved loop config file.
 */
export async function handleMigrateIds(
	req: Request,
	_params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be the categorized migration JSON object", 400);
	}

	// Merge all categories into a single flat old→new mapping
	const flatMapping: Record<string, string> = {};
	for (const [, entries] of Object.entries(body as Record<string, unknown>)) {
		if (typeof entries !== "object" || entries === null) continue;
		for (const [oldId, newId] of Object.entries(entries)) {
			if (typeof newId === "string") {
				flatMapping[oldId] = newId;
			}
		}
	}

	const results = await ctx.loopManager.migrateLoopConfigs(ctx.configDir, flatMapping);
	const changed = results.filter((r) => r.changed).length;
	const totalChanges = results.reduce((sum, r) => sum + r.changes.length, 0);

	// Also remap skill IDs in the SQLite game state for all accounts
	const allAccountIds = ctx.store.getAllAccountIds();
	const skillResults: Array<{ accountId: string; changes: Array<{ from: string; to: string }> }> =
		[];

	for (const accountId of allAccountIds) {
		const result = ctx.store.migrateSkillIds(accountId, flatMapping);
		if (result.changed) {
			skillResults.push({ accountId, changes: result.changes });
			log.info(
				`Migrated skill IDs for ${accountId}: ${result.changes.map((c) => `${c.from}→${c.to}`).join(", ")}`,
			);
		}
	}

	const totalSkillChanges = skillResults.reduce((sum, r) => sum + r.changes.length, 0);

	log.info(
		`ID migration complete: ${changed}/${results.length} loop config(s) updated, ${totalChanges} ID(s) replaced, ${totalSkillChanges} skill ID(s) remapped across ${skillResults.length} account(s)`,
	);

	return jsonResponse({
		message: `Migrated ${changed}/${results.length} loop config(s), ${totalChanges} ID(s) updated, ${totalSkillChanges} skill ID(s) remapped across ${skillResults.length} account(s)`,
		results,
		skillResults,
		mappingSize: Object.keys(flatMapping).length,
	});
}

// ── Dashboard ───────────────────────────────────────────────────────

export function handleDashboardData(
	_req: Request,
	_params: RouteParams,
	ctx: HandlerContext,
): Response {
	const accounts = ctx.manager.getAll().map((account) => {
		const id = account.config.player_id;
		return {
			player_id: id,
			username: account.config.username,
			state: ctx.store.getState(id),
			loop: ctx.loopManager.getStatus(id) ?? null,
			hasRunningJob: ctx.jobManager.isRunning(id),
			runningJob: ctx.jobManager.getRunningJob(id) ?? null,
			hasExecutingGoal: ctx.executingGoals.has(id),
			executingGoal: ctx.executingGoals.get(id) ?? null,
			recentJobs: ctx.jobManager.listByAccount(id, 5),
		};
	});

	const uptimeMs = Date.now() - new Date(ctx.startedAt).getTime();
	return jsonResponse({ startedAt: ctx.startedAt, uptimeMs, accounts });
}

// ── Validation helpers ─────────────────────────────────────────────

function requireString(opts: Record<string, unknown>, key: string): string {
	const value = opts[key];
	if (typeof value !== "string") {
		throw new Error(`options.${key} is required (string)`);
	}
	return value;
}

function validateDepositTarget(
	opts: Record<string, unknown>,
): { depositTarget: "personal" | "faction" } | Record<string, never> {
	const val = opts["depositTarget"];
	if (val === "personal" || val === "faction") {
		return { depositTarget: val };
	}
	return {};
}

function parseListPrices(
	raw: unknown,
): { listPrices: Record<string, number> } | Record<string, never> {
	if (raw === undefined || raw === null || raw === "") return {};
	let obj = raw;
	if (typeof obj === "string") {
		try {
			obj = JSON.parse(obj);
		} catch {
			throw new Error("options.listPrices must be a valid JSON object of item_id → price");
		}
	}
	if (typeof obj !== "object" || Array.isArray(obj)) {
		throw new Error("options.listPrices must be an object of item_id → price");
	}
	return { listPrices: obj as Record<string, number> };
}

function validateCashSource(
	opts: Record<string, unknown>,
): { cashSource: "faction"; minCredits?: number } | Record<string, never> {
	const val = opts["cashSource"];
	if (val === "faction") {
		const minCredits = typeof opts["minCredits"] === "number" ? opts["minCredits"] : undefined;
		return { cashSource: val, ...(minCredits !== undefined ? { minCredits } : {}) };
	}
	return {};
}

function validateMiningOptions(opts: Record<string, unknown>): MiningLoopApiOptions {
	return {
		miningSystemId: requireString(opts, "miningSystemId"),
		beltPoiId: requireString(opts, "beltPoiId"),
		sellSystemId: requireString(opts, "sellSystemId"),
		sellStationPoiId: requireString(opts, "sellStationPoiId"),
		sellBaseId: requireString(opts, "sellBaseId"),
		...(typeof opts["fullThreshold"] === "number" ? { fullThreshold: opts["fullThreshold"] } : {}),
		...(typeof opts["maxAttempts"] === "number" ? { maxAttempts: opts["maxAttempts"] } : {}),
		...(typeof opts["repair"] === "boolean" ? { repair: opts["repair"] } : {}),
		...validateDepositTarget(opts),
		...(typeof opts["skipMarket"] === "boolean" ? { skipMarket: opts["skipMarket"] } : {}),
		...validateCashSource(opts),
		...(typeof opts["listPrice"] === "number" ? { listPrice: opts["listPrice"] } : {}),
		...parseListPrices(opts["listPrices"]),
		...(typeof opts["retryOnDepleted"] === "boolean"
			? { retryOnDepleted: opts["retryOnDepleted"] }
			: {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function validateEnhancedMiningOptions(
	opts: Record<string, unknown>,
): EnhancedMiningLoopApiOptions {
	const junkItemIds = opts["junkItemIds"];
	if (!Array.isArray(junkItemIds) || !junkItemIds.every((id) => typeof id === "string")) {
		throw new Error("options.junkItemIds is required (string[])");
	}

	return {
		miningSystemId: requireString(opts, "miningSystemId"),
		beltPoiId: requireString(opts, "beltPoiId"),
		sellSystemId: requireString(opts, "sellSystemId"),
		sellStationPoiId: requireString(opts, "sellStationPoiId"),
		sellBaseId: requireString(opts, "sellBaseId"),
		junkItemIds: junkItemIds as string[],
		...(typeof opts["fullThreshold"] === "number" ? { fullThreshold: opts["fullThreshold"] } : {}),
		...(typeof opts["maxAttempts"] === "number" ? { maxAttempts: opts["maxAttempts"] } : {}),
		...(typeof opts["maxJettisonRounds"] === "number"
			? { maxJettisonRounds: opts["maxJettisonRounds"] }
			: {}),
		...(typeof opts["repair"] === "boolean" ? { repair: opts["repair"] } : {}),
		...validateDepositTarget(opts),
		...(typeof opts["skipMarket"] === "boolean" ? { skipMarket: opts["skipMarket"] } : {}),
		...validateCashSource(opts),
		...(typeof opts["listPrice"] === "number" ? { listPrice: opts["listPrice"] } : {}),
		...parseListPrices(opts["listPrices"]),
		...(typeof opts["retryOnDepleted"] === "boolean"
			? { retryOnDepleted: opts["retryOnDepleted"] }
			: {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function validateSalvageOptions(opts: Record<string, unknown>): SalvageLoopApiOptions {
	return {
		salvageSystemId: requireString(opts, "salvageSystemId"),
		salvagePoiId: requireString(opts, "salvagePoiId"),
		sellSystemId: requireString(opts, "sellSystemId"),
		sellStationPoiId: requireString(opts, "sellStationPoiId"),
		sellBaseId: requireString(opts, "sellBaseId"),
		...(typeof opts["fullThreshold"] === "number" ? { fullThreshold: opts["fullThreshold"] } : {}),
		...(typeof opts["maxAttempts"] === "number" ? { maxAttempts: opts["maxAttempts"] } : {}),
		...(typeof opts["repair"] === "boolean" ? { repair: opts["repair"] } : {}),
		...validateDepositTarget(opts),
		...(typeof opts["skipMarket"] === "boolean" ? { skipMarket: opts["skipMarket"] } : {}),
		...validateCashSource(opts),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function requireStationConfig(
	opts: Record<string, unknown>,
	key: string,
): { systemId: string; poiId: string; baseId: string } {
	const station = opts[key];
	if (typeof station !== "object" || station === null || Array.isArray(station)) {
		throw new Error(`options.${key} must be an object with systemId, poiId, baseId`);
	}
	const s = station as Record<string, unknown>;
	return {
		systemId: requireString(s, "systemId"),
		poiId: requireString(s, "poiId"),
		baseId: requireString(s, "baseId"),
	};
}

function validateTradingItemsArray(opts: Record<string, unknown>): TradingLoopApiOptions["items"] {
	const items = opts["items"];
	if (!Array.isArray(items) || items.length === 0) {
		throw new Error("options.items is required (non-empty array)");
	}

	return items.map((item, i) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error(`options.items[${i}] must be an object`);
		}
		const entry = item as Record<string, unknown>;
		return {
			itemId: requireString(entry, "itemId"),
			maxBuyPrice: requireNumber(entry, "maxBuyPrice"),
			minSellPrice: requireNumber(entry, "minSellPrice"),
			...(typeof entry["maxQuantity"] === "number" ? { maxQuantity: entry["maxQuantity"] } : {}),
		};
	});
}

function requireNumber(opts: Record<string, unknown>, key: string): number {
	const value = opts[key];
	if (typeof value !== "number") {
		throw new Error(`options.${key} is required (number)`);
	}
	return value;
}

function validateTradingOptions(opts: Record<string, unknown>): TradingLoopApiOptions {
	const buyStation = requireStationConfig(opts, "buyStation");
	const sellStationRaw = opts["sellStation"];
	if (
		typeof sellStationRaw !== "object" ||
		sellStationRaw === null ||
		Array.isArray(sellStationRaw)
	) {
		throw new Error("options.sellStation must be an object with systemId, stationPoiId, baseId");
	}
	const ss = sellStationRaw as Record<string, unknown>;
	const sellStation = {
		systemId: requireString(ss, "systemId"),
		stationPoiId: requireString(ss, "stationPoiId"),
		baseId: requireString(ss, "baseId"),
	};

	return {
		buyStation,
		sellStation,
		items: validateTradingItemsArray(opts),
		...(typeof opts["refuel"] === "boolean" ? { refuel: opts["refuel"] } : {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function validateHaulingOptions(opts: Record<string, unknown>): HaulingLoopApiOptions {
	// Validate source
	const sourceRaw = opts["source"];
	if (typeof sourceRaw !== "object" || sourceRaw === null || Array.isArray(sourceRaw)) {
		throw new Error("options.source must be an object");
	}
	const src = sourceRaw as Record<string, unknown>;
	const validSourceTypes = ["personal-storage", "faction-storage", "market"];
	const sourceType = requireString(src, "type");
	if (!validSourceTypes.includes(sourceType)) {
		throw new Error(`options.source.type must be one of: ${validSourceTypes.join(", ")}`);
	}

	const sourceItems = src["items"];
	if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
		throw new Error("options.source.items is required (non-empty array)");
	}
	const parsedSourceItems = sourceItems.map((item, i) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error(`options.source.items[${i}] must be an object`);
		}
		const entry = item as Record<string, unknown>;
		return {
			itemId: requireString(entry, "itemId"),
			...(typeof entry["quantity"] === "number" ? { quantity: entry["quantity"] } : {}),
			...(typeof entry["maxPrice"] === "number" ? { maxPrice: entry["maxPrice"] } : {}),
		};
	});

	const source: HaulingLoopApiOptions["source"] = {
		systemId: requireString(src, "systemId"),
		poiId: requireString(src, "poiId"),
		baseId: requireString(src, "baseId"),
		type: sourceType as HaulingLoopApiOptions["source"]["type"],
		items: parsedSourceItems,
	};

	// Validate destination
	const destRaw = opts["destination"];
	if (typeof destRaw !== "object" || destRaw === null || Array.isArray(destRaw)) {
		throw new Error("options.destination must be an object");
	}
	const dst = destRaw as Record<string, unknown>;
	const validDestTypes = ["personal-storage", "faction-storage", "gift", "market"];
	const destType = requireString(dst, "type");
	if (!validDestTypes.includes(destType)) {
		throw new Error(`options.destination.type must be one of: ${validDestTypes.join(", ")}`);
	}

	if (destType === "gift" && typeof dst["targetPlayer"] !== "string") {
		throw new Error("options.destination.targetPlayer is required when type is 'gift'");
	}

	const destItems = dst["items"];
	let parsedDestItems: HaulingLoopApiOptions["destination"]["items"];
	if (Array.isArray(destItems)) {
		parsedDestItems = destItems.map((item, i) => {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw new Error(`options.destination.items[${i}] must be an object`);
			}
			const entry = item as Record<string, unknown>;
			return {
				itemId: requireString(entry, "itemId"),
				...(typeof entry["minPrice"] === "number" ? { minPrice: entry["minPrice"] } : {}),
			};
		});
	}

	const destination: HaulingLoopApiOptions["destination"] = {
		systemId: requireString(dst, "systemId"),
		poiId: requireString(dst, "poiId"),
		baseId: requireString(dst, "baseId"),
		type: destType as HaulingLoopApiOptions["destination"]["type"],
		...(typeof dst["targetPlayer"] === "string" ? { targetPlayer: dst["targetPlayer"] } : {}),
		...(parsedDestItems !== undefined ? { items: parsedDestItems } : {}),
	};

	return {
		source,
		destination,
		...(typeof opts["refuel"] === "boolean" ? { refuel: opts["refuel"] } : {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function validateStorageTransferOptions(
	opts: Record<string, unknown>,
): StorageTransferLoopApiOptions {
	return {
		systemId: requireString(opts, "systemId"),
		stationPoiId: requireString(opts, "stationPoiId"),
		baseId: requireString(opts, "baseId"),
		...(typeof opts["refuel"] === "boolean" ? { refuel: opts["refuel"] } : {}),
		...(typeof opts["excludeCredits"] === "boolean"
			? { excludeCredits: opts["excludeCredits"] }
			: {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function validateExplorationOptions(opts: Record<string, unknown>): ExplorationLoopApiOptions {
	return {
		systemId: requireString(opts, "systemId"),
		stationPoiId: requireString(opts, "stationPoiId"),
		baseId: requireString(opts, "baseId"),
		...(typeof opts["allowLawless"] === "boolean" ? { allowLawless: opts["allowLawless"] } : {}),
		...(typeof opts["minFuelReserve"] === "number"
			? { minFuelReserve: opts["minFuelReserve"] }
			: {}),
		...(typeof opts["repairThreshold"] === "number"
			? { repairThreshold: opts["repairThreshold"] }
			: {}),
		...(typeof opts["survey"] === "boolean" ? { survey: opts["survey"] } : {}),
		...(typeof opts["minSubmittedAtTick"] === "number"
			? { minSubmittedAtTick: opts["minSubmittedAtTick"] }
			: {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function validateGuardOptions(opts: Record<string, unknown>): GuardLoopApiOptions {
	return {
		homeSystemId: requireString(opts, "homeSystemId"),
		homeStationPoiId: requireString(opts, "homeStationPoiId"),
		homeBaseId: requireString(opts, "homeBaseId"),
		guardSystemId: requireString(opts, "guardSystemId"),
		guardPoiId: requireString(opts, "guardPoiId"),
		...(opts["cashSource"] === "faction" ? { cashSource: "faction" as const } : {}),
		...(typeof opts["minCredits"] === "number" ? { minCredits: opts["minCredits"] } : {}),
		...(typeof opts["repairThreshold"] === "number"
			? { repairThreshold: opts["repairThreshold"] }
			: {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

function validateRoamingSalvageOptions(
	opts: Record<string, unknown>,
): RoamingSalvageLoopApiOptions {
	return {
		homeSystemId: requireString(opts, "homeSystemId"),
		homeStationPoiId: requireString(opts, "homeStationPoiId"),
		homeBaseId: requireString(opts, "homeBaseId"),
		...(typeof opts["allowLawless"] === "boolean" ? { allowLawless: opts["allowLawless"] } : {}),
		...(typeof opts["fullThreshold"] === "number" ? { fullThreshold: opts["fullThreshold"] } : {}),
		...(typeof opts["minFuelReserve"] === "number"
			? { minFuelReserve: opts["minFuelReserve"] }
			: {}),
		...(typeof opts["repair"] === "boolean" ? { repair: opts["repair"] } : {}),
		...validateDepositTarget(opts),
		...validateCashSource(opts),
		...(typeof opts["maxLootAttempts"] === "number"
			? { maxLootAttempts: opts["maxLootAttempts"] }
			: {}),
		...(typeof opts["maxIterations"] === "number" ? { maxIterations: opts["maxIterations"] } : {}),
	};
}

// ── Schema endpoints ─────────────────────────────────────────────────────────

export function handleGetGoalSchemas(
	_req: Request,
	_params: RouteParams,
	_ctx: HandlerContext,
): Response {
	return jsonResponse(getGoalSchemas());
}

export function handleGetLoopSchemas(
	_req: Request,
	_params: RouteParams,
	_ctx: HandlerContext,
): Response {
	return jsonResponse(getLoopSchemas());
}

// ── Map data endpoints ──────────────────────────────────────────────────────

export async function handleGetMap(
	_req: Request,
	_params: RouteParams,
	_ctx: HandlerContext,
): Promise<Response> {
	try {
		// Proxy the public map endpoint (no auth needed, includes positions + connections)
		const res = await fetch("https://game.spacemolt.com/api/map");
		if (!res.ok) {
			throw new Error(`Public map API returned ${res.status}`);
		}
		const data = await res.json();
		return jsonResponse(data);
	} catch (err) {
		return errorResponse(`Map fetch failed: ${errorMessage(err)}`, 500);
	}
}

// ── Raw game-API proxy (for the spacemolt CLI spawned by `smctl raw`) ────────

/**
 * Transparent proxy for the external spacemolt CLI's game-API traffic.
 *
 * `smctl raw` spawns the spacemolt binary with SPACEMOLT_URL pointed at this
 * route, so the CLI's requests arrive here instead of going straight to
 * game.spacemolt.com. We forward them through SpaceMoltClient — which brands
 * them with our User-Agent, requests zstd/gzip compression, and records
 * bandwidth — then relay the game's response back verbatim. This keeps the CLI
 * as the authority for request shaping and output formatting while ensuring its
 * egress is identified and compressed like the rest of the daemon's traffic.
 */
export async function handleGameProxy(
	req: Request,
	_params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const url = new URL(req.url);
	const proxyPath = url.pathname.replace(/^\/gameproxy/, "");
	// The proxy only relays game REST calls; constrain the forwarded path to the
	// game API namespace so it cannot be coerced toward other endpoints. URL
	// parsing has already normalized any "../" segments out of the pathname.
	if (!proxyPath.startsWith("/api/v2/")) {
		return errorResponse("gameproxy path must begin with /api/v2/", 400);
	}
	const targetPath = proxyPath + url.search;
	const sessionId = req.headers.get("x-session-id") ?? undefined;
	const contentType = req.headers.get("content-type") ?? undefined;
	const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

	try {
		const result = await ctx.client.forward(req.method, targetPath, body, sessionId, contentType);
		return new Response(result.body, {
			status: result.status,
			headers: { "Content-Type": result.contentType },
		});
	} catch (err) {
		return errorResponse(`Proxy request failed: ${errorMessage(err)}`, 502);
	}
}

export async function handleGetSystem(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const systemId = params["systemId"];

	try {
		// If requesting a specific system, check if the account is currently there.
		// get_system always returns the player's current system regardless of params.
		// For remote systems, use faction intel instead.
		const actualId = account.config.player_id;
		const state = ctx.store.getState(actualId);
		const currentSystemId = state?.location?.system_id;

		if (!systemId || systemId === currentSystemId) {
			// Account is in the requested system (or no system specified) — use get_system
			const result = await account.endpoints.getSystem();
			return jsonResponse(result.structuredContent);
		}

		// Remote system: try to find an account that's actually IN that system
		for (const other of ctx.manager.getAll()) {
			const otherState = ctx.store.getState(other.config.player_id);
			if (otherState?.location?.system_id === systemId) {
				const result = await other.endpoints.getSystem();
				return jsonResponse(result.structuredContent);
			}
		}

		// No account in target system — fall back to faction intel
		const intelResult = await account.session.execute<Record<string, unknown>>(
			"spacemolt_intel",
			"query_intel",
			{ system_id: systemId },
		);
		const entries = intelResult.structuredContent["entries"] as
			| Array<Record<string, unknown>>
			| undefined;
		const entry = entries?.[0];

		if (!entry) {
			return errorResponse(`No intel available for system ${systemId}`, 404);
		}

		// Reshape intel data to match the get_system format.
		// As of v0.245.0, intel entries include full POI details (position, class,
		// description, base_name) matching get_system/get_poi output.
		const rawPois = (entry["pois"] as Array<Record<string, unknown>> | undefined) ?? [];
		const rawConns = (entry["connections"] as Array<unknown> | undefined) ?? [];

		return jsonResponse({
			system: {
				id: entry["system_id"] ?? systemId,
				name: entry["name"] ?? systemId,
				description: entry["description"],
				empire: entry["empire"],
				security_status:
					entry["police_level"] !== undefined
						? (entry["police_level"] as number) > 0
							? "secure"
							: "lawless"
						: undefined,
				connections: rawConns.map((conn: unknown) => {
					if (typeof conn === "string") {
						return { system_id: conn, name: conn, distance: 0 };
					}
					const c = conn as Record<string, unknown>;
					return {
						system_id: c["system_id"] ?? c["id"] ?? "",
						name: c["name"] ?? c["system_id"] ?? "",
						distance: (c["distance"] as number) ?? 0,
					};
				}),
				pois: rawPois.map((p: Record<string, unknown>) => ({
					id: p["id"],
					name: p["name"],
					type: p["type"],
					position: (p["position"] as { x: number; y: number } | undefined) ?? { x: 0, y: 0 },
					...(p["class"] !== undefined ? { class: p["class"] } : {}),
					...(p["description"] !== undefined ? { description: p["description"] } : {}),
					...(p["has_base"] !== undefined ? { has_base: p["has_base"] } : {}),
					...(p["base_id"] !== undefined ? { base_id: p["base_id"] } : {}),
					...(p["base_name"] !== undefined ? { base_name: p["base_name"] } : {}),
					...(p["resources"] !== undefined ? { resources: p["resources"] } : {}),
				})),
			},
			source: "intel",
		});
	} catch (err) {
		return errorResponse(`System fetch failed: ${errorMessage(err)}`, 500);
	}
}
