import type {
	ClerkPlayer,
	Commands,
	GameState,
	MutationResult,
	QueryResult,
	RegisterResult,
	StateSection,
} from "@spacemolt/lib";
import type { LibManagedAccount } from "../../src/accounts/lib-types.js";
import type { LibGoalAccount } from "../../src/dispatcher/lib-goal-context.js";

/** One recorded command invocation, for assertions. `action` is the command name (e.g. "travel"). */
export interface RecordedCall {
	action: string;
	params?: unknown;
}

/**
 * Programmable handlers keyed by command name (e.g. `travel`, `dock`, `buy`).
 * A handler returns the value the command resolves to (a `MutationResult`, a
 * `QueryResult`, etc.) or throws to simulate a game error. Commands with no
 * handler resolve to an empty `MutationResult`.
 */
export type FakeCommandHandlers = Record<string, (params?: unknown) => Promise<unknown> | unknown>;

/** A minimal MutationResult with an empty delta — the default for handlers that don't set state. */
export function fakeMutationResult(command: string): MutationResult {
	return { command, tick: 0, delta: {} };
}

/**
 * In-memory `LibGoalAccount` double. Holds a mutable `GameState`; command
 * handlers may call `setState` to simulate a delta being applied to the cache
 * (so a goal's post-mutation `account.state` read sees the new value). Tracks
 * every command call and every `refresh()` call.
 *
 * `commands` is a generic recording proxy: any command on any group
 * (`commands.spacemolt.dock()`, `commands.spacemolt_market.view_market(...)`)
 * is recorded and dispatched to the handler of the same name — so no per-command
 * wiring is needed as new goals are ported. Param typing is enforced separately,
 * at each goal's real call site against the lib's `Commands` type.
 */
export class FakeLibGoalAccount implements LibGoalAccount {
	private _state: GameState;
	readonly calls: RecordedCall[] = [];
	refreshCalls = 0;
	/** State returned by the next `refresh()` (defaults to current state). */
	refreshReturns?: GameState;
	readonly commands: Commands;

	constructor(initial: GameState = {}, handlers: FakeCommandHandlers = {}) {
		this._state = initial;

		const groupProxy = new Proxy(
			{},
			{
				get: (_group, action) => {
					if (typeof action !== "string") return undefined;
					return (params?: unknown): Promise<unknown> => {
						this.calls.push(params === undefined ? { action } : { action, params });
						const handler = handlers[action];
						return Promise.resolve(handler ? handler(params) : fakeMutationResult(action));
					};
				},
			},
		);

		const commandsProxy = new Proxy(
			{},
			{
				get: (_target, group) => {
					if (typeof group !== "string") return undefined;
					return groupProxy;
				},
			},
		);

		this.commands = commandsProxy as unknown as Commands;
	}

	get state(): Readonly<GameState> {
		return this._state;
	}

	/** Merge a partial into the cached state (simulates a delta being applied). */
	setState(patch: GameState): void {
		this._state = { ...this._state, ...patch };
	}

	refresh(): Promise<Readonly<GameState>> {
		this.refreshCalls++;
		if (this.refreshReturns) {
			this._state = this.refreshReturns;
		}
		return Promise.resolve(this._state);
	}
}

/** Options for a `FakeLibManagedAccount`. */
export interface FakeLibManagedAccountOptions {
	/** The account's `player.id` — the player_id it is indexed under. */
	playerId?: string;
	/** The account's `id` — the store-key/username it is managed under. */
	username?: string;
	/** Initial game-state cache. */
	state?: GameState;
	/**
	 * Handlers keyed by action name. Shared by the `commands` proxy and the
	 * `query`/`send`/`mutate` low-level paths. A handler returns the resolved
	 * value (a `QueryResult`, `MutationResult`, …) or throws to simulate an error.
	 */
	handlers?: FakeCommandHandlers;
}

/**
 * Full `LibManagedAccount` double for the server/account layers. Extends
 * `FakeLibGoalAccount` (mutable state cache, recording `commands` proxy,
 * `refresh()`) and adds `player`/`id`, the `query`/`send`/`mutate` low-level
 * dispatch (recorded into `calls` and routed to the same handlers), and an
 * `onStateChange` registry with `emitStateChange` for projector tests.
 */
export class FakeLibManagedAccount extends FakeLibGoalAccount implements LibManagedAccount {
	readonly player?: GameState["player"];
	readonly id?: string | undefined;
	private readonly listeners: Array<(changed: StateSection[]) => void> = [];
	private readonly sendHandlers: FakeCommandHandlers;

	constructor(opts: FakeLibManagedAccountOptions = {}) {
		super(opts.state ?? {}, opts.handlers ?? {});
		this.sendHandlers = opts.handlers ?? {};
		if (opts.playerId !== undefined) {
			this.player = { id: opts.playerId } as GameState["player"];
		}
		if (opts.username !== undefined) {
			this.id = opts.username;
		}
	}

	private dispatch(action: string, payload?: Record<string, unknown>): Promise<unknown> {
		this.calls.push(payload === undefined ? { action } : { action, params: payload });
		const handler = this.sendHandlers[action];
		return Promise.resolve(handler ? handler(payload) : fakeMutationResult(action));
	}

	query(_tool: string, action: string, payload?: Record<string, unknown>): Promise<QueryResult> {
		return this.dispatch(action, payload) as Promise<QueryResult>;
	}

	send(
		_tool: string,
		action: string,
		payload?: Record<string, unknown>,
	): Promise<QueryResult | MutationResult> {
		return this.dispatch(action, payload) as Promise<QueryResult | MutationResult>;
	}

	mutate(
		_tool: string,
		action: string,
		payload?: Record<string, unknown>,
	): Promise<MutationResult> {
		return this.dispatch(action, payload) as Promise<MutationResult>;
	}

	onStateChange(listener: (changed: StateSection[]) => void): void {
		this.listeners.push(listener);
	}

	close(): void {}

	/** Fire the registered onStateChange listeners (for projector wiring tests). */
	emitStateChange(changed: StateSection[]): void {
		for (const l of this.listeners) {
			l(changed);
		}
	}
}

/** Overridable behaviours for a `makeFakeLibManager` double. */
export interface FakeLibManagerOverrides {
	connectOne?: (idOrUsername: string) => Promise<LibManagedAccount>;
	register?: (params: {
		username: string;
		empire: string;
		registration_code?: string;
	}) => Promise<{ account: LibManagedAccount; result: RegisterResult }>;
	remove?: (playerId: string) => Promise<void>;
	listOwned?: () => Promise<ClerkPlayer[]>;
	isConnecting?: (idOrUsername: string) => boolean;
}

/**
 * Build a `LibAccountManager` double over a fixed set of connected accounts,
 * indexing by `player.id` and `id` (username, case-insensitive). Lifecycle
 * methods (`connectOne`/`register`/`remove`/`listOwned`/`isConnecting`) default
 * to sensible no-ops and can be overridden per test. Returned as the real
 * `LibAccountManager` type via a structural cast — only the surface the server
 * layer uses is implemented.
 */
export function makeFakeLibManager(
	accounts: FakeLibManagedAccount[],
	overrides: FakeLibManagerOverrides = {},
): import("../../src/accounts/lib-manager.js").LibAccountManager {
	const byPlayerId = new Map<string, FakeLibManagedAccount>();
	const byUsername = new Map<string, FakeLibManagedAccount>();
	for (const a of accounts) {
		if (a.player?.id) byPlayerId.set(a.player.id, a);
		if (typeof a.id === "string") byUsername.set(a.id.toLowerCase(), a);
	}

	const manager = {
		get size() {
			return byPlayerId.size;
		},
		getAll: () => accounts,
		getByPlayerId: (id: string) => byPlayerId.get(id),
		getByUsername: (username: string) => byUsername.get(username.toLowerCase()),
		connect: () => Promise.resolve(),
		connectOne:
			overrides.connectOne ??
			((idOrUsername: string) => {
				const found = byUsername.get(idOrUsername.toLowerCase());
				return found
					? Promise.resolve(found as LibManagedAccount)
					: Promise.reject(new Error(`No stored account: ${idOrUsername}`));
			}),
		register: overrides.register ?? (() => Promise.reject(new Error("register not stubbed"))),
		remove: overrides.remove ?? (() => Promise.resolve()),
		disconnect: overrides.remove ?? (() => Promise.resolve()),
		listOwned: overrides.listOwned ?? (() => Promise.resolve([] as ClerkPlayer[])),
		isConnecting: overrides.isConnecting ?? (() => false),
		disconnectAll: () => {},
	};

	return manager as unknown as import("../../src/accounts/lib-manager.js").LibAccountManager;
}
