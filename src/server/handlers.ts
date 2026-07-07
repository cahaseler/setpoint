import type { MarketBookSnapshot, ObservationSnapshot } from "@setpoint/protocol";
import { type LoopType, loopPatchSchemas, loopSchemas } from "@setpoint/protocol";
import type { MarketBook, ObservationView, SpacemoltClient } from "@spacemolt/lib";
import { loadRegistrationConfig } from "../accounts/config.js";
import type { LibAccountManager } from "../accounts/lib-manager.js";
import { type LibManagedAccount, playerId as playerIdOf } from "../accounts/lib-types.js";
import type { ProgressRef } from "../dispatcher/goals.js";
import { makeLibGoalContext } from "../dispatcher/lib-goal-context.js";
import type { CraftingEventsStore } from "../state/crafting-events-store.js";
import { STATE_SECTION_KEYS, type StateSectionKey, type StateStore } from "../state/store.js";
import { ApiError, HttpError, errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { type LogLevel, getLogLevel, setLogLevel } from "../util/logger.js";
import {
	createGoal,
	deprecatedTypeMessage,
	formatGoalError,
	getGoalTypes,
	isZodLikeError,
} from "./goal-registry.js";
import type { JobManager } from "./job-manager.js";
import type {
	EnhancedMiningLoopApiOptions,
	HaulingLoopApiOptions,
	LoopManager,
	LoopStatus,
	MiningLoopApiOptions,
	TradingLoopApiOptions,
} from "./loop-manager.js";
import { type RouteParams, errorResponse, jsonResponse } from "./router.js";
import { getGoalSchemas, getLoopSchemas } from "./schemas.js";

const log = createLogger("handlers");

/** Shared context available to all handlers. */
export interface HandlerContext {
	manager: LibAccountManager;
	store: StateStore;
	loopManager: LoopManager;
	jobManager: JobManager;
	client: SpacemoltClient;
	configDir: string;
	startedAt: string;
	craftingEventsStore: CraftingEventsStore;
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
	/**
	 * Accounts synchronously claimed by a goal submission that hasn't yet
	 * reached its durable "running" record (`executingGoals`/`jobManager`).
	 * The claim must be added in the same tick as the "is anything already
	 * running" checks — otherwise two concurrent submissions for the same
	 * account can both pass those checks before either one registers,
	 * because `req.json()` and goal construction both await before this
	 * account previously got recorded as busy.
	 */
	claimedAccounts: Set<string>;
}

/** Resolve an account by player_id or username (case-insensitive). */
function resolveAccount(ctx: HandlerContext, idOrName: string): LibManagedAccount | undefined {
	return ctx.manager.getByPlayerId(idOrName) ?? ctx.manager.getByUsername(idOrName);
}

/**
 * Build a resolver that re-looks-up the account by player_id on every call,
 * instead of pinning a single `Account` instance. A goal or loop can run long
 * enough for the underlying WebSocket to drop and reconnect — the lib replaces
 * the `Account` instance on reconnect, so anything holding the old instance
 * would keep sending on a permanently dead socket. Throws if the account is no
 * longer connected (e.g. a terminal disconnect), which surfaces as a clear
 * failure instead of "cannot send on a closed socket".
 */
function resolveLiveAccount(ctx: HandlerContext, playerId: string): () => LibManagedAccount {
	return () => {
		const account = ctx.manager.getByPlayerId(playerId);
		if (!account) {
			throw new Error(`Account ${playerId} is no longer connected`);
		}
		return account;
	};
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

export async function handleListAccounts(
	_req: Request,
	_params: RouteParams,
	ctx: HandlerContext,
): Promise<Response> {
	const connected = ctx.manager.getAll().map((a) => {
		const id = playerIdOf(a);
		const state = ctx.store.getState(id);
		return {
			player_id: id,
			username: a.id ?? null,
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
			loop: ctx.loopManager.getStatus(id) ?? null,
		};
	});

	// Owned-but-not-connected accounts come from Clerk. Match against the
	// connected usernames (account.id) case-insensitively; ClerkPlayer.id is not
	// assumed to equal player_id. Degrade to connected-only if Clerk fails.
	const connectedUsernames = new Set(
		ctx.manager
			.getAll()
			.map((a) => a.id?.toLowerCase())
			.filter((u): u is string => u !== undefined),
	);

	const notConnected: Array<Record<string, unknown>> = [];
	try {
		const owned = await ctx.manager.listOwned();
		for (const p of owned) {
			if (connectedUsernames.has(p.username.toLowerCase())) {
				continue;
			}
			notConnected.push({
				player_id: p.id,
				username: p.username,
				empire: p.empire,
				status: ctx.manager.isConnecting(p.username) ? "connecting" : "disconnected",
				credits: null,
				ship: null,
				location: null,
				loop: null,
			});
		}
	} catch (err) {
		log.warn(`Failed to list owned players: ${errorMessage(err)}`);
	}

	return jsonResponse({ accounts: [...connected, ...notConnected] });
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
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const actualId = playerIdOf(account);
	const state = ctx.store.getState(actualId);

	return jsonResponse({
		player_id: actualId,
		username: account.id ?? null,
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

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return errorResponse("Body must be a JSON object", 400);
	}

	const username = (body as Record<string, unknown>)["username"];
	if (typeof username !== "string" || username.length === 0) {
		return errorResponse(
			"username is required (string) — the account must be owned by the configured Clerk user",
			400,
		);
	}

	if (ctx.manager.getByUsername(username)) {
		return errorResponse(`Account "${username}" is already connected`, 409);
	}

	// Connect in the background. Owned accounts authenticate via the lib's
	// credential store; connecting can take seconds under the auth rate limit,
	// so we return 202 immediately and let the caller poll GET /accounts.
	void ctx.manager.connectOne(username).catch((err) => {
		log.error(`[${username}] Background connect failed: ${errorMessage(err)}`);
	});

	return jsonResponse(
		{
			username,
			status: "connecting",
			message: "Account connection started; poll GET /accounts for status",
		},
		202,
	);
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
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const actualId = playerIdOf(account);
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

	await ctx.manager.remove(actualId);
	return jsonResponse({ message: "Account disconnected", player_id: actualId });
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

	// Register + connect through the lib. It generates and persists the account's
	// credentials in the credential store and returns the generated password.
	try {
		const { account, result } = await ctx.manager.register({
			username,
			empire,
			registration_code: registrationCode,
		});

		return jsonResponse(
			{
				player_id: result.player_id,
				username: account.id ?? username,
				password: result.password,
				empire,
				status: "connected",
				message: "Account registered and connected",
			},
			201,
		);
	} catch (err) {
		return errorResponse(`Registration failed: ${errorMessage(err)}`, 500);
	}
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

	const actualId = playerIdOf(account);

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

	// Block if another submission for this account is mid-flight (claimed
	// below, before this one has a durable executingGoals/jobManager record).
	if (ctx.claimedAccounts.has(actualId)) {
		return errorResponse(
			"Another request for this account is already being processed. Try again shortly.",
			409,
		);
	}

	// Claim the account now, synchronously and before any `await` below — the
	// checks above and this claim must run in the same uninterrupted tick, or
	// two concurrent requests for the same account can both pass every check
	// before either one is recorded as busy. Released on every early return
	// below, and once executingGoals.set() makes it redundant.
	ctx.claimedAccounts.add(actualId);

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		ctx.claimedAccounts.delete(actualId);
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		ctx.claimedAccounts.delete(actualId);
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const goalType = typed["type"];

	if (typeof goalType !== "string") {
		ctx.claimedAccounts.delete(actualId);
		return errorResponse(`type is required (string). Supported: ${getGoalTypes().join(", ")}`, 400);
	}

	const deprecated = deprecatedTypeMessage(goalType);
	if (deprecated) {
		ctx.claimedAccounts.delete(actualId);
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
		ctx.claimedAccounts.delete(actualId);
		return errorResponse(formatGoalError(err), 400);
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

	const resolveLive = resolveLiveAccount(ctx, actualId);
	const goalCtx = makeLibGoalContext(resolveLive, goalController.signal);
	// Non-forced: escalates to a live refresh only if the cache is stale (idle
	// account), so a one-off goal's precondition check doesn't silently no-op
	// against externally-drifted state.
	await goalCtx.refreshState();
	const goalPromise = goal.execute(goalCtx);

	ctx.executingGoals.set(actualId, {
		goalType,
		goalOptions: opts,
		startedAt: new Date().toISOString(),
		controller: goalController,
		progress,
		promise: goalPromise,
	});
	// executingGoals is now the durable "busy" record for this account.
	ctx.claimedAccounts.delete(actualId);

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
			`[${actualId}] Client disconnected during ${goalType} after ${elapsed}s — signaling the goal to stop; executingGoals lock stays held until it actually does`,
		);
		// Signal the goal itself to stop (existing signal?.aborted checks in
		// navigate-to-system, mine-with-jettison, etc. pick this up between
		// steps/hops) — a client disconnect must not leave the goal running
		// orphaned in the background. The executingGoals lock is deliberately
		// NOT cleared here: it's released below once goalPromise actually
		// settles, whether that's fast (the abort took effect) or not (an
		// in-flight jump mutation can't be interrupted mid-transit). Clearing
		// it eagerly here would let a fresh submission for the same account
		// start immediately and race the still-running orphaned execution —
		// which is exactly the bug this fixes.
		goalController.abort();
		writer.close().catch(() => {});
	};
	reqSignal.addEventListener("abort", onAbort);

	goalPromise
		.then(async (result) => {
			clearInterval(keepaliveTimer);
			reqSignal.removeEventListener("abort", onAbort);
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			ctx.executingGoals.delete(actualId);

			if (clientAborted) {
				log.warn(
					`[${actualId}] ${goalType} completed in ${elapsed}s but client already disconnected`,
				);
				return;
			}

			log.info(`[${actualId}] Sync goal completed: ${goalType} in ${elapsed}s`);
			// Refresh state after completion: many mutation responses (deposit, sell, etc.)
			// don't include V2GameState, leaving the state store stale.
			try {
				await resolveLive().refresh();
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
			ctx.executingGoals.delete(actualId);

			if (clientAborted) {
				log.warn(
					`[${actualId}] ${goalType} failed after ${elapsed}s but client already disconnected: ${errorMessage(err)}`,
				);
				return;
			}

			log.warn(
				`[${actualId}] Sync goal failed: ${goalType} after ${elapsed}s — ${errorMessage(err)}`,
			);
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

	const actualId = playerIdOf(account);

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

	// Block if another submission for this account is mid-flight (claimed
	// below, before this one has a durable jobManager record).
	if (ctx.claimedAccounts.has(actualId)) {
		return errorResponse(
			"Another request for this account is already being processed. Try again shortly.",
			409,
		);
	}

	// Claim the account now, synchronously and before any `await` below — the
	// checks above and this claim must run in the same uninterrupted tick, or
	// two concurrent requests for the same account can both pass every check
	// before either one is recorded as busy. Released on every early return
	// below, and once jobManager.create() makes it redundant.
	ctx.claimedAccounts.add(actualId);

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		ctx.claimedAccounts.delete(actualId);
		return errorResponse("Invalid JSON body", 400);
	}

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		ctx.claimedAccounts.delete(actualId);
		return errorResponse("Body must be a JSON object", 400);
	}

	const typed = body as Record<string, unknown>;
	const goalType = typed["type"];

	if (typeof goalType !== "string") {
		ctx.claimedAccounts.delete(actualId);
		return errorResponse(`type is required (string). Supported: ${getGoalTypes().join(", ")}`, 400);
	}

	const deprecated = deprecatedTypeMessage(goalType);
	if (deprecated) {
		ctx.claimedAccounts.delete(actualId);
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
		ctx.claimedAccounts.delete(actualId);
		return errorResponse(formatGoalError(err), 400);
	}

	const job = ctx.jobManager.create(actualId, goalType, opts);
	// jobManager.isRunning() is now the durable "busy" record for this account.
	ctx.claimedAccounts.delete(actualId);

	try {
		const jobController = new AbortController();
		const jobProgress: ProgressRef = {
			goalType,
			goalOptions: opts,
			completedSteps: [],
			remainingSteps: [],
		};
		const resolveLive = resolveLiveAccount(ctx, actualId);
		const goalCtx = makeLibGoalContext(resolveLive, jobController.signal);
		// Non-forced: escalates to a live refresh only if the cache is stale (idle
		// account), so a one-off goal's precondition check doesn't silently no-op
		// against externally-drifted state.
		await goalCtx.refreshState();
		const jobPromise = goal
			.execute(goalCtx)
			.then(async (result) => {
				// Refresh state after completion: many mutation responses (deposit, sell, etc.)
				// don't include V2GameState, leaving the state store stale.
				try {
					await resolveLive().refresh();
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
		// subscribe_market/unsubscribe_market and subscribe_observation/unsubscribe_observation
		// must go through the lib's typed wrapper methods rather than the generic
		// account.send() dispatch below — seeding/dropping the market/observation
		// caches read by GET /accounts/:playerId/market|observation is a side effect
		// of those wrapper methods specifically, not of the bare query/mutate call.
		// Routing raw (un)subscribe calls through send() leaves those caches
		// untouched: a raw resubscribe looks like it worked (server state is
		// correct) while the local mirror silently keeps serving whatever it held
		// before, indefinitely, for any item/station with no fresh market_update
		// push after the fact.
		if (resolvedToolGroup === "spacemolt_market" && action === "subscribe_market") {
			const snapshot = await account.subscribeMarket();
			return jsonResponse({ result: snapshot, structuredContent: snapshot });
		}
		if (resolvedToolGroup === "spacemolt_market" && action === "unsubscribe_market") {
			await account.unsubscribeMarket();
			return jsonResponse({ result: null, structuredContent: undefined });
		}
		if (resolvedToolGroup === "spacemolt" && action === "subscribe_observation") {
			const snapshot = await account.subscribeObservation(actionParams["active_scan"] === true);
			return jsonResponse({ result: snapshot, structuredContent: snapshot });
		}
		if (resolvedToolGroup === "spacemolt" && action === "unsubscribe_observation") {
			await account.unsubscribeObservation();
			return jsonResponse({ result: null, structuredContent: undefined });
		}

		// account.send() dispatches to query/mutate by the spec's mutation flag.
		// Mutations resolve with { command, tick, delta, autoDocked?, autoUndocked? };
		// queries resolve with { result, structuredContent? }. Normalize both to a
		// stable envelope. Push events (notifications) arrive on the event stream,
		// not on command results, so there is nothing to relay here.
		const response = await account.send(resolvedToolGroup, action, actionParams);
		return jsonResponse(
			"delta" in response
				? {
						result: response.delta,
						structuredContent: response.delta,
						tick: response.tick,
						command: response.command,
					}
				: {
						result: response.result,
						structuredContent: response.structuredContent,
					},
		);
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

	const state = ctx.store.getState(playerIdOf(account));
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
		// refresh() re-seeds the lib's push-fed state cache via get_status; the
		// account's onStateChange stream projects the change into the store
		// synchronously before this resolves.
		await account.refresh();

		const state = ctx.store.getState(playerIdOf(account));
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

	const data = ctx.store.getSection(playerIdOf(sectionAccount), section as StateSectionKey);
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

	const status = ctx.loopManager.getStatus(playerIdOf(loopAccount));
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

	const current = ctx.loopManager.getStatus(playerIdOf(account));
	if (!current?.running) {
		return errorResponse("No loop running on this account", 409);
	}

	// Validate patch keys against the loop's zod partial schema (from
	// `@setpoint/protocol`, the single source of truth for loop option
	// shapes) — the patch merges keys verbatim into the persisted config, so
	// an unknown key (e.g. a body wrapped in {"options": ...}) would silently
	// corrupt it. `loopPatchSchemas[type].shape` is a plain object, not a zod
	// object with `.strict()`, so `.parse()` alone would silently strip
	// unknown keys rather than reject them — hence the explicit key check.
	if (isLoopType(current.type)) {
		const validKeys = Object.keys(loopPatchSchemas[current.type].shape);
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

		try {
			loopPatchSchemas[current.type].parse(patch);
		} catch (err) {
			return errorResponse(formatLoopPatchError(err), 400);
		}
	}

	const status = ctx.loopManager.patchLoopOptions(playerIdOf(account), patch);
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

	const actualId = playerIdOf(account);

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

	if (typeof loopType !== "string" || !isLoopType(loopType)) {
		return errorResponse(
			`Unknown loop type: ${String(loopType)}. Supported: ${getLoopTypes().join(", ")}`,
			400,
		);
	}

	const options = typed["options"];
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		return errorResponse("options must be a JSON object", 400);
	}

	const opts = options as Record<string, unknown>;

	const actualId = playerIdOf(account);

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

	const resolveLive = resolveLiveAccount(ctx, actualId);

	try {
		let status: LoopStatus;

		// Each branch validates `opts` against the matching zod schema in
		// `loopSchemas` (from `@setpoint/protocol`) before constructing the
		// LoopManager options — the schema is the single source of truth for a
		// loop's option shape, mirroring the goal-registry pattern.
		if (loopType === "mining") {
			const apiOptions = resolveListPrices(loopSchemas.mining.parse(opts)) as MiningLoopApiOptions;
			status = ctx.loopManager.startMiningLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "enhanced-mining") {
			const apiOptions = resolveListPrices(
				loopSchemas["enhanced-mining"].parse(opts),
			) as EnhancedMiningLoopApiOptions;
			status = ctx.loopManager.startEnhancedMiningLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "trading") {
			const apiOptions = loopSchemas.trading.parse(opts) as TradingLoopApiOptions;
			status = ctx.loopManager.startTradingLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "hauling") {
			const apiOptions = loopSchemas.hauling.parse(opts) as HaulingLoopApiOptions;
			status = ctx.loopManager.startHaulingLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "storage-transfer") {
			const apiOptions = loopSchemas["storage-transfer"].parse(opts);
			status = ctx.loopManager.startStorageTransferLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "salvage") {
			const apiOptions = loopSchemas.salvage.parse(opts);
			status = ctx.loopManager.startSalvageLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "roaming-salvage") {
			const apiOptions = loopSchemas["roaming-salvage"].parse(opts);
			status = ctx.loopManager.startRoamingSalvageLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "tow-salvage") {
			const apiOptions = loopSchemas["tow-salvage"].parse(opts);
			status = ctx.loopManager.startTowSalvageLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "exploration") {
			const apiOptions = loopSchemas.exploration.parse(opts);
			status = ctx.loopManager.startExplorationLoop(actualId, apiOptions, resolveLive);
		} else if (loopType === "guard") {
			const apiOptions = loopSchemas.guard.parse(opts);
			status = ctx.loopManager.startGuardLoop(actualId, apiOptions, resolveLive);
		} else {
			throw new HttpError(`Unsupported loop type: ${loopType}`, 400);
		}

		// Persist loop config for auto-resume on restart
		ctx.loopManager.saveLoopConfig(actualId, loopType, opts, ctx.configDir).catch((err) => {
			log.warn(`Failed to save loop config: ${errorMessage(err)}`);
		});

		return jsonResponse(status, 201);
	} catch (err) {
		const message = formatGoalError(err);
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

	const actualId = playerIdOf(account);

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
		const id = playerIdOf(account);
		return {
			player_id: id,
			username: account.id,
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

/** All loop types recognized by `@setpoint/protocol`'s `loopSchemas`/`loopPatchSchemas`. */
function getLoopTypes(): LoopType[] {
	return Object.keys(loopSchemas) as LoopType[];
}

/** Type guard narrowing a raw string to `LoopType` if it's a known, schema-backed loop type. */
function isLoopType(type: string): type is LoopType {
	return Object.hasOwn(loopSchemas, type);
}

/**
 * Format a `handlePatchLoop` validation error into a readable 400 message.
 *
 * Mirrors `formatGoalError` (see `goal-registry.ts`), but without the
 * "options." path prefix — a loop PATCH body is a flat partial merged
 * directly onto the live options, not wrapped in an `options` object like
 * `handleStartLoop`'s body.
 */
function formatLoopPatchError(err: unknown): string {
	if (isZodLikeError(err)) {
		return err.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
	}
	return err instanceof Error ? err.message : "Invalid patch options";
}

/**
 * Normalize `listPrices` after zod validation: `loopSchemas.mining`/
 * `loopSchemas["enhanced-mining"]` accept either an object of item_id → price
 * or a JSON string of the same (for CLI/form convenience), but
 * `LoopManager.startMiningLoop`/`startEnhancedMiningLoop` only accept the
 * object form. A string value is parsed here; a non-object parse result
 * throws the same validation-style error the old hand-rolled validator did.
 */
function resolveListPrices<T extends { listPrices?: Record<string, number> | string | undefined }>(
	validated: T,
): Omit<T, "listPrices"> & { listPrices?: Record<string, number> } {
	const { listPrices, ...rest } = validated;
	if (typeof listPrices !== "string") {
		return { ...rest, ...(listPrices !== undefined ? { listPrices } : {}) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(listPrices);
	} catch {
		throw new Error("options.listPrices must be a valid JSON object of item_id → price");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("options.listPrices must be an object of item_id → price");
	}
	return { ...rest, listPrices: parsed as Record<string, number> };
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
		const actualId = playerIdOf(account);
		const state = ctx.store.getState(actualId);
		const currentSystemId = state?.location?.system_id;

		if (!systemId || systemId === currentSystemId) {
			// Account is in the requested system (or no system specified) — get_system
			// always returns the player's current system and takes no params.
			const result = await account.query("spacemolt", "get_system");
			return jsonResponse(result.structuredContent);
		}

		// Remote system: try to find an account that's actually IN that system
		for (const other of ctx.manager.getAll()) {
			const otherState = ctx.store.getState(playerIdOf(other));
			if (otherState?.location?.system_id === systemId) {
				const result = await other.query("spacemolt", "get_system");
				return jsonResponse(result.structuredContent);
			}
		}

		// No account in target system — fall back to faction intel
		const intelResult = await account.query("spacemolt_intel", "query_intel", {
			system_id: systemId,
		});
		const entries = intelResult.structuredContent?.["entries"] as
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

// ── Market / Observation ────────────────────────────────────────────
//
// These read the lib's `MarketCache`/`ObservationCache` directly (no SQLite
// mirror — the same as `account.state` for goals). There is no subscribe
// endpoint here: issue `spacemolt_market.subscribe_market` or
// `spacemolt.subscribe_observation` via the raw passthrough
// (`POST /accounts/:playerId/raw`) first, then read with these.

function serializeMarketBook(book: MarketBook): MarketBookSnapshot {
	return {
		base_id: book.base_id,
		...(book.base_name !== undefined ? { base_name: book.base_name } : {}),
		tick: book.tick,
		items: [...book.items.values()],
	};
}

function serializeObservation(view: ObservationView): ObservationSnapshot {
	return {
		...(view.poi_id !== undefined ? { poi_id: view.poi_id } : {}),
		...(view.system_id !== undefined ? { system_id: view.system_id } : {}),
		tick: view.tick,
		nearby: [...view.nearby.values()],
		system: [...view.system.values()],
		cloaked: [...view.cloaked.values()],
		unknownSignature: view.unknownSignature,
		activeScan: view.activeScan,
	};
}

export function handleGetMarket(_req: Request, params: RouteParams, ctx: HandlerContext): Response {
	const playerId = params["playerId"];
	const baseId = params["baseId"];
	if (!playerId || !baseId) {
		return errorResponse("Missing playerId or baseId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const book = account.market(baseId);
	if (!book) {
		return errorResponse(
			`No market data for base "${baseId}" — subscribe first via the raw passthrough (toolGroup: "spacemolt_market", action: "subscribe_market")`,
			404,
		);
	}

	return jsonResponse(serializeMarketBook(book));
}

export function handleGetObservation(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Response {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const view = account.observation();
	if (!view) {
		return errorResponse(
			'No observation data — subscribe first via the raw passthrough (toolGroup: "spacemolt", action: "subscribe_observation")',
			404,
		);
	}

	return jsonResponse(serializeObservation(view));
}

// ── Crafting Events ──────────────────────────────────────────────────

const SSE_HEADERS: Record<string, string> = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
};

/**
 * Streams `crafting_update` pushes for an account as Server-Sent Events:
 * the buffered backlog immediately on connect, then each new push live as it
 * arrives. Unlike market/observation, no subscribe-first step is needed —
 * the server sends `crafting_update` automatically whenever the account has
 * jobs in progress (see `CraftingEventsStore`/`onCraftingUpdate` in
 * `lib-manager.ts`).
 */
export function handleCraftingEvents(
	_req: Request,
	params: RouteParams,
	ctx: HandlerContext,
): Response {
	const playerId = params["playerId"];
	if (!playerId) {
		return errorResponse("Missing playerId", 400);
	}

	const account = resolveAccount(ctx, playerId);
	if (!account) {
		return errorResponse("Account not found", 404);
	}

	const actualId = playerIdOf(account);
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;

	const stream = new ReadableStream<Uint8Array>({
		start(controller): void {
			for (const envelope of ctx.craftingEventsStore.recent(actualId)) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
			}
			unsubscribe = ctx.craftingEventsStore.subscribe(actualId, (envelope) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
			});
		},
		cancel(): void {
			unsubscribe?.();
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
