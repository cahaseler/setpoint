/** Account-scoped goal/loop/state API, plus the top-level accounts collection API, for `@setpoint/client`. */

import type {
	CombatEnvelope,
	CombatMode,
	CombatModeStatus,
	CraftingUpdateEnvelope,
	Empire,
	GoalOptionsMap,
	GoalResult,
	GoalType,
	JobRecord,
	LoopOptionsMap,
	LoopStatus,
	LoopType,
	MarketBookSnapshot,
	ObservationSnapshot,
	PirateRadioEnvelope,
	ReconcileResult,
	V2GameState,
} from "@setpoint/protocol";
import type { GetSystemResponse } from "@spacemolt/lib";
import type { SetpointClient } from "./client.js";
import { GoalFailedError, SetpointHttpError } from "./errors.js";
import { type WaitForJobOptions, waitForJob } from "./jobs.js";
import { type RawApi, createRawApi } from "./raw.js";

/**
 * True for the daemon's sync-goal failure body — `{error: string}` with no
 * `success` field. `handleExecuteGoal` streams this shape at HTTP 200 when
 * the goal throws (see `GoalFailedError`'s doc comment), so `goal()` must
 * check the body shape rather than trusting `response.ok`.
 */
function isGoalFailureBody(body: unknown): body is { error: string } {
	return (
		typeof body === "object" &&
		body !== null &&
		typeof (body as Record<string, unknown>)["error"] === "string" &&
		!("success" in (body as Record<string, unknown>))
	);
}

export interface AbortOptions {
	/** Fire abort signals and clean up in-memory state immediately, instead of just reporting status. */
	force?: boolean;
}

/**
 * Loop API scoped to a single account. Mirrors the daemon's
 * `POST|GET|PATCH|DELETE /accounts/:id/loop` routes (`src/server/handlers.ts`).
 */
export class AccountLoopApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Starts a loop, persisting its config on the daemon. Body is `{type, options}` (matches `handleStartLoop`).
	 *
	 * Replacing a running loop waits for the old one to actually stop, which can
	 * legitimately take a while, so the request timeout is disabled (`timeoutMs: 0`)
	 * rather than inherited from the client default.
	 */
	async start<T extends LoopType>(type: T, options: LoopOptionsMap[T]): Promise<LoopStatus> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
			{ body: { type, options }, timeoutMs: 0 },
		);
		return result as LoopStatus;
	}

	/** Gets the current loop status, or `{running: false}` if no loop has ever run on this account. */
	async get(): Promise<LoopStatus | { running: false }> {
		const result = await this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
		);
		return result as LoopStatus | { running: false };
	}

	/**
	 * Patches a running loop's options in place, without restarting it. The
	 * body is the FLAT partial itself — unlike `start`, it is NOT wrapped in
	 * an `options` object (matches `handlePatchLoop`).
	 */
	async patch<T extends LoopType>(partial: Partial<LoopOptionsMap[T]>): Promise<LoopStatus> {
		const result = await this.client.request(
			"PATCH",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
			{ body: partial },
		);
		return result as LoopStatus;
	}

	/** Stops the running loop and deletes its persisted config. */
	async stop(): Promise<{ message: string }> {
		const result = await this.client.request(
			"DELETE",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
		);
		return result as { message: string };
	}
}

/**
 * Game-state API scoped to a single account. Mirrors the daemon's
 * `GET /accounts/:id/state[/:section]` and `POST /accounts/:id/state/refresh`
 * routes (`src/server/handlers.ts`).
 */
export class AccountStateApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/** Gets the full local game state (as fresh as the last mutation response). */
	async get(): Promise<V2GameState> {
		const result = await this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/state`,
		);
		return result as V2GameState;
	}

	/** Gets a single state section (e.g. `"ship"`, `"cargo"`, `"location"`). */
	async section(name: string): Promise<unknown> {
		return this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/state/${encodeURIComponent(name)}`,
		);
	}

	/** Forces a live `get_state` call against the game server and returns the refreshed state. */
	async refresh(): Promise<V2GameState> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/state/refresh`,
		);
		return result as V2GameState;
	}
}

/**
 * System/POI-map API scoped to a single account. Mirrors the daemon's
 * `GET /accounts/:id/system[/:systemId]` route (`handleGetSystem` in
 * `src/server/handlers.ts`).
 */
export class AccountSystemApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Gets system/POI map data. With no `systemId`, returns the account's
	 * current system (`get_system` always reports the player's own system).
	 * With a `systemId`, the daemon returns that system directly if the
	 * account is there, another connected account's live view if one is in
	 * that system, or a reshaped faction-intel snapshot as a fallback —
	 * `handleGetSystem` normalizes all three to (approximately) this shape.
	 */
	async get(systemId?: string): Promise<GetSystemResponse> {
		const path =
			systemId === undefined
				? `/accounts/${encodeURIComponent(this.id)}/system`
				: `/accounts/${encodeURIComponent(this.id)}/system/${encodeURIComponent(systemId)}`;
		const result = await this.client.request("GET", path);
		return result as GetSystemResponse;
	}
}

/**
 * Live market API scoped to a single account. Mirrors the daemon's
 * `GET /accounts/:id/market/:baseId` route (`handleGetMarket` in
 * `src/server/handlers.ts`).
 */
export class AccountMarketApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Gets the cached order book for a base. There is no subscribe method here —
	 * subscribe first via `account.raw.spacemolt_market.subscribe_market()`
	 * (throws `SetpointHttpError` 404 if not subscribed / no data cached yet).
	 */
	async get(baseId: string): Promise<MarketBookSnapshot> {
		const result = await this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/market/${encodeURIComponent(baseId)}`,
		);
		return result as MarketBookSnapshot;
	}
}

/**
 * Live observation-watch API scoped to a single account. Mirrors the
 * daemon's `GET /accounts/:id/observation` route (`handleGetObservation` in
 * `src/server/handlers.ts`).
 */
export class AccountObservationApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Gets the cached observation-watch view. There is no subscribe method
	 * here — subscribe first via
	 * `account.raw.spacemolt.subscribe_observation()` (throws
	 * `SetpointHttpError` 404 if not subscribed / no data cached yet).
	 */
	async get(): Promise<ObservationSnapshot> {
		const result = await this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/observation`,
		);
		return result as ObservationSnapshot;
	}
}

/**
 * Live crafting-progress API scoped to a single account. Mirrors the
 * daemon's `GET /accounts/:id/crafting/events` route (`handleCraftingEvents`
 * in `src/server/handlers.ts`) — a Server-Sent Events stream, unlike every
 * other account sub-API here, since crafting progress needs no subscribe-first
 * step and consumers want each push as it happens, not just the latest cache.
 */
export class AccountCraftingApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Streams `crafting_update` pushes for this account: the daemon's buffered
	 * backlog (last ~50 events) immediately, then each new push live as it
	 * arrives. The generator runs until the connection closes or `signal`
	 * aborts — consume with `for await (const envelope of account.crafting.events())`.
	 */
	async *events(opts?: { signal?: AbortSignal }): AsyncGenerator<
		CraftingUpdateEnvelope,
		void,
		void
	> {
		const url = `${this.client.baseUrl}/accounts/${encodeURIComponent(this.id)}/crafting/events`;
		const response = await fetch(url, opts?.signal ? { signal: opts.signal } : {});

		if (!response.ok || !response.body) {
			let body: { error?: string } = {};
			try {
				body = (await response.json()) as { error?: string };
			} catch {
				/* non-JSON error body */
			}
			throw new SetpointHttpError(response.status, body);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				buffered += decoder.decode(value, { stream: true });
				let boundary = buffered.indexOf("\n\n");
				while (boundary !== -1) {
					const frame = buffered.slice(0, boundary);
					buffered = buffered.slice(boundary + 2);
					if (frame.startsWith("data: ")) {
						yield JSON.parse(frame.slice("data: ".length)) as CraftingUpdateEnvelope;
					}
					boundary = buffered.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}
}

/**
 * Live combat-event API scoped to a single account. Mirrors the daemon's
 * `GET /accounts/:id/combat/events` route (`handleCombatEvents` in
 * `src/server/handlers.ts`) — a Server-Sent Events stream of self-relevant
 * `battle_*`/`player_died`/`player_kill` pushes plus synthetic
 * `combat_interrupted`/`combat_recovery_*` events, same shape/rationale as
 * {@link AccountCraftingApi}.
 */
export class AccountCombatApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Streams combat events for this account: the daemon's buffered backlog
	 * (last ~50 events) immediately, then each new push live as it arrives.
	 * The generator runs until the connection closes or `signal` aborts —
	 * consume with `for await (const envelope of account.combat.events())`.
	 */
	async *events(opts?: { signal?: AbortSignal }): AsyncGenerator<CombatEnvelope, void, void> {
		const url = `${this.client.baseUrl}/accounts/${encodeURIComponent(this.id)}/combat/events`;
		const response = await fetch(url, opts?.signal ? { signal: opts.signal } : {});

		if (!response.ok || !response.body) {
			let body: { error?: string } = {};
			try {
				body = (await response.json()) as { error?: string };
			} catch {
				/* non-JSON error body */
			}
			throw new SetpointHttpError(response.status, body);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				buffered += decoder.decode(value, { stream: true });
				let boundary = buffered.indexOf("\n\n");
				while (boundary !== -1) {
					const frame = buffered.slice(0, boundary);
					buffered = buffered.slice(boundary + 2);
					if (frame.startsWith("data: ")) {
						yield JSON.parse(frame.slice("data: ".length)) as CombatEnvelope;
					}
					boundary = buffered.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}
}

/**
 * Consumes a daemon SSE route as a typed async generator: connects, yields
 * each `data:` frame parsed as `T`, and runs until the connection closes or
 * `signal` aborts.
 */
async function* streamEvents<T>(
	url: string,
	opts?: { signal?: AbortSignal },
): AsyncGenerator<T, void, void> {
	const response = await fetch(url, opts?.signal ? { signal: opts.signal } : {});

	if (!response.ok || !response.body) {
		let body: { error?: string } = {};
		try {
			body = (await response.json()) as { error?: string };
		} catch {
			/* non-JSON error body */
		}
		throw new SetpointHttpError(response.status, body);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return;
			buffered += decoder.decode(value, { stream: true });
			let boundary = buffered.indexOf("\n\n");
			while (boundary !== -1) {
				const frame = buffered.slice(0, boundary);
				buffered = buffered.slice(boundary + 2);
				if (frame.startsWith("data: ")) {
					yield JSON.parse(frame.slice("data: ".length)) as T;
				}
				boundary = buffered.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/**
 * Live pirate-radio API scoped to a single account. Mirrors the daemon's
 * `GET /accounts/:id/pirate-radio/events` route (`handlePirateRadioEvents` in
 * `src/server/handlers.ts`) — a Server-Sent Events stream of intercepted
 * pirate transmissions, same shape/rationale as {@link AccountCraftingApi}.
 */
export class AccountPirateRadioApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Streams `pirate_radio` pushes for this account: the daemon's buffered
	 * backlog (last ~50 events) immediately, then each new push live as it
	 * arrives. The generator runs until the connection closes or `signal`
	 * aborts — consume with
	 * `for await (const envelope of account.pirateRadio.events())`.
	 */
	events(opts?: { signal?: AbortSignal }): AsyncGenerator<PirateRadioEnvelope, void, void> {
		const url = `${this.client.baseUrl}/accounts/${encodeURIComponent(this.id)}/pirate-radio/events`;
		return streamEvents<PirateRadioEnvelope>(url, opts);
	}
}

/**
 * Combat-response mode API scoped to a single account. Mirrors the daemon's
 * `GET|PATCH /accounts/:id/combat-mode` routes (`src/server/handlers.ts`).
 * `"flee"` (the default) is setpoint's built-in auto-flee response on combat
 * entry; `"external"` skips it — the account is still released from any
 * running loop/goal, but no automatic `spacemolt_battle.stance` calls are
 * sent, so hand-written combat logic can drive the ship instead.
 */
export class AccountCombatModeApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/** Gets the account's current combat-mode setting. */
	async get(): Promise<CombatModeStatus> {
		const result = await this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/combat-mode`,
		);
		return result as CombatModeStatus;
	}

	/**
	 * Signals that an external combat driver is alive for this account.
	 *
	 * Call this every tick the driver is running, whether or not it issued a
	 * command — holding position is a legitimate and common move, so silence on
	 * the command channel is not evidence of a dead driver. If the daemon sees
	 * no heartbeat for five ticks while the account is in a battle, it takes the
	 * fight with its built-in flee response rather than leaving a ship that
	 * neither fights nor flees.
	 *
	 * The account's configured mode is not changed when that happens: re-arming
	 * the driver is the caller's business, and the next battle starts external
	 * again.
	 */
	/**
	 * Streams a battle's tick-by-tick log.
	 *
	 * `battle/status` reports other participants only as percentages and only
	 * answers for the asking account, so following a fight with N pilots costs N
	 * polls per tick. The log carries absolute hull, shield, zone, stance and
	 * target for every participant, so one stream describes the whole fight.
	 *
	 * Pass `sinceTick` to resume after a reconnect instead of replaying.
	 */
	battleLog(options: { battleId?: string; sinceTick?: number } = {}): EventSource {
		const params = new URLSearchParams();
		if (options.battleId !== undefined) params.set("battleId", options.battleId);
		if (options.sinceTick !== undefined) params.set("sinceTick", String(options.sinceTick));
		const query = params.size > 0 ? `?${params.toString()}` : "";
		return new EventSource(
			`${this.client.baseUrl}/accounts/${encodeURIComponent(this.id)}/battle-log/events${query}`,
		);
	}

	async heartbeat(): Promise<{ playerId: string; acknowledgedAt: string }> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/combat-heartbeat`,
		);
		return result as { playerId: string; acknowledgedAt: string };
	}

	/** Sets and persists the account's combat-mode setting — takes effect on the next combat entry, no restart needed. */
	async set(mode: CombatMode): Promise<CombatModeStatus> {
		const result = await this.client.request(
			"PATCH",
			`/accounts/${encodeURIComponent(this.id)}/combat-mode`,
			{ body: { mode } },
		);
		return result as CombatModeStatus;
	}
}

/**
 * Fleet sub-API for an account, over `POST /accounts/:id/fleet`.
 *
 * Runs on the LEADER account. The daemon drives the invitees' accepts itself,
 * but never takes an account away from work it is already doing: a member
 * mid-loop, mid-goal or in combat comes back as a failed subject naming why,
 * and it is left alone. Releasing an account is an operator action
 * (`DELETE /accounts/:id/abort`).
 */
export class AccountFleetApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Reconciles this account's fleet to exactly `members`, which may be player
	 * ids or usernames. An empty list disbands the fleet — a leader cannot
	 * simply leave one.
	 *
	 * Does not move ships: a member that is not already at the leader's POI
	 * fails `not_at_poi` and reports where it actually is, so a caller can tell
	 * an inbound ship from a stray one.
	 */
	/**
	 * Moves the fleet by moving its leader, then brings every member to
	 * readiness — fuel and repair do not cascade from the leader, so each pays
	 * its own way on arrival.
	 *
	 * Waits for a leader that is mid-jump rather than refusing: mid-transit the
	 * leader reports no POI, so members measured against it would all look like
	 * strays.
	 */
	async move(options: {
		systemId: string;
		poiId: string;
		baseId?: string;
		refuel?: boolean;
		repair?: boolean;
		maxWaitMs?: number;
	}): Promise<FleetOperationResult> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/fleet/move`,
			{ body: options },
		);
		return result as FleetOperationResult;
	}

	async ensure(members: string[]): Promise<ReconcileResult> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/fleet`,
			{ body: { members } },
		);
		return result as ReconcileResult;
	}
}

/** Goal API scoped to a single account, identified by player_id or username. */
export class AccountApi {
	/** Loop sub-API for this account (`sp.account(id).loop`). */
	readonly loop: AccountLoopApi;

	/** Game-state sub-API for this account (`sp.account(id).state`). */
	readonly state: AccountStateApi;

	/** System/POI-map sub-API for this account (`sp.account(id).system`). */
	readonly system: AccountSystemApi;

	/** Live market sub-API for this account (`sp.account(id).market`). */
	readonly market: AccountMarketApi;

	/** Live observation-watch sub-API for this account (`sp.account(id).observation`). */
	readonly observation: AccountObservationApi;

	/** Live crafting-progress sub-API for this account (`sp.account(id).crafting`). */
	readonly crafting: AccountCraftingApi;

	/** Live combat-event sub-API for this account (`sp.account(id).combat`). */
	readonly combat: AccountCombatApi;

	/** Combat-response mode sub-API for this account (`sp.account(id).combatMode`). */
	readonly combatMode: AccountCombatModeApi;

	/** Live pirate-radio sub-API for this account (`sp.account(id).pirateRadio`). */
	readonly pirateRadio: AccountPirateRadioApi;

	/** Fleet-composition sub-API for this account as leader (`sp.account(id).fleet`). */
	readonly fleet: AccountFleetApi;

	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {
		this.loop = new AccountLoopApi(client, id);
		this.state = new AccountStateApi(client, id);
		this.system = new AccountSystemApi(client, id);
		this.market = new AccountMarketApi(client, id);
		this.observation = new AccountObservationApi(client, id);
		this.crafting = new AccountCraftingApi(client, id);
		this.combat = new AccountCombatApi(client, id);
		this.combatMode = new AccountCombatModeApi(client, id);
		this.pirateRadio = new AccountPirateRadioApi(client, id);
		this.fleet = new AccountFleetApi(client, id);
	}

	/**
	 * Typed raw-passthrough API for this account (`sp.account(id).raw`).
	 * `raw.<group>.<action>(params)` POSTs `/accounts/:id/raw` and returns the
	 * daemon's `RawEnvelope`, typed via `@spacemolt/lib`'s `Commands`.
	 */
	get raw(): RawApi {
		return createRawApi(this.client, this.id);
	}

	/**
	 * Executes a goal synchronously, blocking until the daemon returns a result.
	 *
	 * Sync goals can legitimately run for minutes, so the request timeout is
	 * disabled (`timeoutMs: 0`) rather than inherited from the client default.
	 */
	async goal<T extends GoalType>(type: T, options: GoalOptionsMap[T]): Promise<GoalResult> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/goal`,
			{
				body: { type, options },
				timeoutMs: 0,
			},
		);
		if (isGoalFailureBody(result)) {
			throw new GoalFailedError(result.error);
		}
		return result as GoalResult;
	}

	/** Submits a goal for background execution, returning a job id immediately (HTTP 202). */
	async goalAsync<T extends GoalType>(
		type: T,
		options: GoalOptionsMap[T],
	): Promise<{ job_id: string }> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/goal/async`,
			{
				body: { type, options },
			},
		);
		return result as { job_id: string };
	}

	/**
	 * Submits a goal asynchronously and polls until it reaches a terminal
	 * status, returning the result on success and throwing on failure.
	 */
	async runToCompletion<T extends GoalType>(
		type: T,
		options: GoalOptionsMap[T],
		opts?: WaitForJobOptions,
	): Promise<GoalResult> {
		const { job_id } = await this.goalAsync(type, options);
		const job = await waitForJob(this.client, job_id, opts);
		if (job.status === "failed") {
			throw new Error(job.error ?? `Job ${job_id} failed`);
		}
		return job.result as GoalResult;
	}

	/**
	 * Releases the account from all in-progress work (loop, sync goal, or async
	 * job). A forced abort can wait on in-progress game mutations to release, so
	 * its timeout is disabled rather than inherited from the client default; a
	 * non-forced abort keeps the client's default (it's expected to fail fast).
	 */
	async abort(opts?: AbortOptions): Promise<{ message: string }> {
		const result = await this.client.request(
			"DELETE",
			`/accounts/${encodeURIComponent(this.id)}/abort`,
			{
				body: opts?.force !== undefined ? { force: opts.force } : undefined,
				...(opts?.force ? { timeoutMs: 0 } : {}),
			},
		);
		return result as { message: string };
	}
}

// ── Top-level accounts collection (`sp.accounts`) ────────────────────

/** Slimmed ship summary, as embedded in account list/detail responses. */
export interface AccountShipSummary {
	hull: number;
	max_hull: number;
	fuel: number;
	max_fuel: number;
	cargo_used?: number;
	cargo_capacity?: number;
}

/** Slimmed location summary, as embedded in account list/detail responses. */
export interface AccountLocationSummary {
	system: string | undefined;
	poi: string | undefined;
	docked: string | null;
}

/** One entry in `GET /accounts` (`handleListAccounts`) for a connected account. */
export interface ConnectedAccountSummary {
	player_id: string;
	username: string;
	status: "connected";
	credits: number | null;
	ship: AccountShipSummary | null;
	location: AccountLocationSummary | null;
	loop: LoopStatus | null;
}

/** One entry in `GET /accounts` (`handleListAccounts`) for an account still queued for connection. */
export interface PendingAccountSummary {
	player_id: string | null;
	username: string;
	empire: string;
	status: string;
	credits: null;
	ship: null;
	location: null;
	loop: null;
}

export type AccountSummary = ConnectedAccountSummary | PendingAccountSummary;

/** Response of `GET /accounts` (`handleListAccounts`). */
export interface AccountsListResult {
	accounts: AccountSummary[];
}

/** Slimmed state snapshot embedded in `GET /accounts/:id` (`handleGetAccount`). */
export interface AccountDetailState {
	credits: number | undefined;
	ship: { hull: number; max_hull: number; fuel: number; max_fuel: number } | null;
	location: AccountLocationSummary | null;
}

/**
 * `GET /accounts/:id` (`handleGetAccount`) response. The daemon only resolves
 * connected accounts (`resolveAccount` looks up `ctx.manager`, which holds
 * connected accounts only) — an unresolved id/username 404s instead of
 * returning a "pending" shape, so there is no separate pending-detail variant.
 */
export interface ConnectedAccountDetail {
	player_id: string;
	username: string;
	status: "connected";
	state: AccountDetailState | null;
	loop: LoopStatus | null;
	hasRunningJob: boolean;
	runningJob: unknown;
	hasExecutingGoal: boolean;
	executingGoal: unknown;
	recentJobs: JobRecord[];
}

/** Response of `POST /accounts` (`handleAddAccount`). */
export interface AddAccountResult {
	username: string;
	status: string;
	message: string;
}

export interface RegisterAccountOptions {
	username: string;
	empire: Empire;
}

/** Response of `POST /accounts/register` (`handleRegisterAccount`). */
export interface RegisterAccountResult {
	player_id: string;
	username: string;
	password: string;
	empire: string;
	status: string;
	message: string;
}

/** Response of `DELETE /accounts/:id` (`handleDeleteAccount`). */
export interface RemoveAccountResult {
	message: string;
	player_id?: string;
	username?: string;
}

/**
 * Top-level accounts collection API (`sp.accounts`). Mirrors the daemon's
 * `GET|POST /accounts`, `GET|DELETE /accounts/:id`, and
 * `POST /accounts/register` routes (`src/server/handlers.ts`).
 */
export class AccountsApi {
	constructor(private readonly client: SetpointClient) {}

	/** Lists all connected and pending accounts. */
	async list(): Promise<AccountsListResult> {
		const result = await this.client.request("GET", "/accounts");
		return result as AccountsListResult;
	}

	/** Gets details for a single account, by player_id or username. Throws `SetpointHttpError` (404) if not found. */
	async get(id: string): Promise<ConnectedAccountDetail> {
		const result = await this.client.request("GET", `/accounts/${encodeURIComponent(id)}`);
		return result as ConnectedAccountDetail;
	}

	/** Queues an account for background connection (HTTP 202). */
	async add(username: string): Promise<AddAccountResult> {
		const result = await this.client.request("POST", "/accounts", { body: { username } });
		return result as AddAccountResult;
	}

	/**
	 * Registers a brand-new account with the game server and connects it.
	 * Calls the game API twice (createSession + register), so the timeout is
	 * disabled rather than inherited from the client default.
	 */
	async register(options: RegisterAccountOptions): Promise<RegisterAccountResult> {
		const result = await this.client.request("POST", "/accounts/register", {
			body: { username: options.username, empire: options.empire },
			timeoutMs: 0,
		});
		return result as RegisterAccountResult;
	}

	/**
	 * Disconnects and removes an account, by player_id or username. The
	 * timeout is disabled rather than inherited from the client default.
	 */
	async remove(id: string): Promise<RemoveAccountResult> {
		const result = await this.client.request("DELETE", `/accounts/${encodeURIComponent(id)}`, {
			timeoutMs: 0,
		});
		return result as RemoveAccountResult;
	}
}
