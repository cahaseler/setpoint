import type {
	ClerkPlayer,
	Commands,
	GameState,
	MarketBook,
	MarketItem,
	MutationResult,
	ObservationView,
	QueryResult,
	RegisterResult,
	StateSection,
	SubscribeMarketResponse,
	SubscribeObservationResponse,
} from "@spacemolt/lib";

/** Indexes a list by a key extractor, dropping entries with no key — mirrors the lib's internal `indexBy`. */
function indexBy<T, K extends string | undefined>(
	list: T[] | undefined,
	key: (item: T) => K,
): Map<string, T> {
	const map = new Map<string, T>();
	for (const item of list ?? []) {
		const k = key(item);
		if (k !== undefined) map.set(k, item);
	}
	return map;
}
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
	refreshReturns?: GameState | undefined;
	readonly commands: Commands;
	private readonly marketBooks = new Map<string, MarketBook>();
	private _observation: ObservationView | null = null;

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

	market(baseId: string): MarketBook | undefined {
		return this.marketBooks.get(baseId);
	}

	/** Simulates having subscribed and received data for a base's order book. */
	setMarketBook(baseId: string, book: MarketBook): void {
		this.marketBooks.set(baseId, book);
	}

	/** Drops a cached market book (simulates unsubscribing, or the server silently dropping the subscription). */
	dropMarketBook(baseId: string): void {
		this.marketBooks.delete(baseId);
	}

	/** All base_ids with a cached book, for `unsubscribeMarket`'s fallback base inference. */
	marketBaseIds(): string[] {
		return [...this.marketBooks.keys()];
	}

	observation(): ObservationView | null {
		return this._observation;
	}

	/** Simulates having subscribed and received observation-watch data. */
	setObservation(view: ObservationView | null): void {
		this._observation = view;
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
	private readonly notificationHandlers = new Map<
		string,
		Set<(payload: Record<string, unknown>) => void>
	>();

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

	/** Mirrors the real lib's `subscribeMarket()` — seeds the market cache from the dispatched response. */
	async subscribeMarket(): Promise<SubscribeMarketResponse> {
		const res = (await this.dispatch("subscribe_market")) as
			| { structuredContent?: SubscribeMarketResponse }
			| undefined;
		const snapshot = res?.structuredContent;
		if (snapshot?.base_id) {
			const items = new Map<string, MarketItem>();
			for (const item of snapshot.items ?? []) {
				if (item.item_id) items.set(item.item_id, item as MarketItem);
			}
			this.setMarketBook(snapshot.base_id, {
				base_id: snapshot.base_id,
				...(snapshot.base_name !== undefined ? { base_name: snapshot.base_name } : {}),
				tick: 0,
				items,
			});
		}
		return snapshot ?? ({} as SubscribeMarketResponse);
	}

	/** Mirrors the real lib's `unsubscribeMarket()` — drops the cached book for the currently-docked (or last-known) base. */
	async unsubscribeMarket(): Promise<void> {
		const baseId = this.state.location?.docked_at ?? this.marketBaseIds()[0];
		await this.dispatch("unsubscribe_market");
		if (baseId) this.dropMarketBook(baseId);
	}

	/** Mirrors the real lib's `subscribeObservation()` — seeds the observation cache from the dispatched response. */
	async subscribeObservation(activeScan = false): Promise<SubscribeObservationResponse> {
		const res = (await this.dispatch(
			"subscribe_observation",
			activeScan ? { active_scan: true } : undefined,
		)) as { structuredContent?: SubscribeObservationResponse } | undefined;
		const snapshot = res?.structuredContent;
		if (snapshot) {
			this.setObservation({
				...(snapshot.poi_id !== undefined ? { poi_id: snapshot.poi_id } : {}),
				...(snapshot.system_id !== undefined ? { system_id: snapshot.system_id } : {}),
				tick: 0,
				nearby: indexBy(snapshot.nearby, (p) => p.player_id),
				system: indexBy(snapshot.system_agents, (p) => p.player_id),
				cloaked: indexBy(snapshot.cloaked_contacts, (c) => c.target_id),
				unknownSignature: snapshot.unknown_signature ?? false,
				activeScan: snapshot.active_scan ?? false,
			});
		}
		return snapshot ?? ({} as SubscribeObservationResponse);
	}

	/** Mirrors the real lib's `unsubscribeObservation()` — clears the observation cache. */
	async unsubscribeObservation(): Promise<void> {
		await this.dispatch("unsubscribe_observation");
		this.setObservation(null);
	}

	/** Fire the registered onStateChange listeners (for projector wiring tests). */
	emitStateChange(changed: StateSection[]): void {
		for (const l of this.listeners) {
			l(changed);
		}
	}

	on(type: string, handler: (payload: Record<string, unknown>) => void): () => void {
		let handlers = this.notificationHandlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.notificationHandlers.set(type, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}

	/** Test helper: simulates a typed server push (e.g. crafting_update) arriving. */
	emitNotification(type: string, payload: Record<string, unknown>): void {
		for (const handler of this.notificationHandlers.get(type) ?? []) {
			handler(payload);
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
