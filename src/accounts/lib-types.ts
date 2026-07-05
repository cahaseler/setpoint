import type {
	ClerkPlayer,
	Commands,
	ConnectionClosedError,
	GameState,
	MarketBook,
	MutationResult,
	NotificationPayloads,
	ObservationView,
	QueryResult,
	RegisterParams,
	RegisterResult,
	StateSection,
	TypedNotificationType,
} from "@spacemolt/lib";

/**
 * Superset boundary over a lib `Account`, covering both the account-manager's
 * connection-lifecycle needs and the server layer's need to issue
 * commands/queries/mutations directly. The real lib `Account` satisfies this
 * structurally (verified against `node_modules/@spacemolt/lib/dist/account.d.ts`).
 *
 * `player` reuses `GameState["player"]` rather than a hand-rolled shape — the
 * real `Account.player` getter returns exactly that slice, which has no
 * `username` field (`id` is also optional there, not guaranteed). The store
 * key / username this account is managed under is `account.id`, not
 * `account.player.username`.
 */
export interface LibManagedAccount {
	readonly player?: GameState["player"];
	/** Store key / username this account is managed under (Account.id). */
	readonly id?: string | undefined;
	/** Live push-fed state cache. Treat as read-only. */
	readonly state: Readonly<GameState>;
	/** Force a live `get_status` re-seed of the cache. Returns the refreshed state. */
	refresh(): Promise<Readonly<GameState>>;
	/**
	 * Typed, generated command facade grouped by tool:
	 * `account.commands.spacemolt.jump({ id: 'sol' })`.
	 */
	readonly commands: Commands;
	/** Run a read-only command; resolves synchronously with the result. */
	query(tool: string, action: string, payload?: Record<string, unknown>): Promise<QueryResult>;
	/**
	 * Run a command, dispatching to `query`/`mutate` based on the spec's
	 * `x-is-mutation` classification.
	 */
	send(
		tool: string,
		action: string,
		payload?: Record<string, unknown>,
	): Promise<QueryResult | MutationResult>;
	/** Run a mutation; resolves when the action executes on a later tick. */
	mutate(tool: string, action: string, payload?: Record<string, unknown>): Promise<MutationResult>;
	onStateChange(listener: (changed: StateSection[]) => void): void;
	close(): void;
	/**
	 * The cached order book for a base, if subscribed. Subscribing itself is not
	 * part of this boundary — issue `spacemolt_market.subscribe_market` via
	 * `query`/`commands` (or the HTTP raw passthrough) first; the lib's internal
	 * `market_update` listener keeps this cache current afterward regardless of
	 * how the subscribe call was made.
	 */
	market(baseId: string): MarketBook | undefined;
	/**
	 * The current observation-watch view, if subscribed. Subscribing itself is
	 * not part of this boundary — issue `spacemolt.subscribe_observation` via
	 * `query`/`commands` (or the HTTP raw passthrough) first; the lib's internal
	 * `observation_update` listener keeps this cache current afterward
	 * regardless of how the subscribe call was made.
	 */
	observation(): ObservationView | null;
	/**
	 * Listen for a typed server push by notification type (e.g. `crafting_update`).
	 * Returns an unsubscribe function. Unlike market/observation, most
	 * notification types (including `crafting_update`) require no explicit
	 * subscribe call — the server sends them automatically whenever relevant.
	 * Two overloads (matching the real lib `Account.on`): a typed one for
	 * known notification types, and a loose one for untyped/future ones.
	 */
	on<K extends TypedNotificationType>(
		type: K,
		handler: (payload: NotificationPayloads[K]) => void,
	): () => void;
	on(type: string, handler: (payload: Record<string, unknown>) => void): () => void;
}

/** The subset of a lib `Account` the account layer (connection/state) depends on. */
export type LibAccountLike = Pick<
	LibManagedAccount,
	"player" | "id" | "state" | "onStateChange" | "close"
>;

/** The subset of the lib `SpacemoltClient` the account layer depends on. */
export interface AccountClientLike {
	/**
	 * `onConnect` fires as each account finishes connecting — a fleet-wide call
	 * can legitimately take minutes (the lib paces connects to respect the
	 * server's per-IP WS-connection cap), so callers that need each account
	 * usable as soon as it's up (not just once the whole batch settles) should
	 * index/wire it here rather than waiting on the returned array.
	 */
	connectOwned(opts: {
		filter?: (p: ClerkPlayer) => boolean;
		onConnect?: (account: LibManagedAccount) => void;
	}): Promise<LibManagedAccount[]>;
	/** Connect one stored account by store-key/username. Requires creds already in the lib's credential store. */
	connect(id: string): Promise<LibManagedAccount>;
	/** Register a brand-new account: connect, register, and persist the generated credentials. */
	register(params: RegisterParams): Promise<{ account: LibManagedAccount; result: RegisterResult }>;
	/** List the player accounts the Clerk user owns. Requires a Clerk API key. */
	listOwnedPlayers(): Promise<ClerkPlayer[]>;
	accounts(): LibManagedAccount[];
	account(id: string): LibManagedAccount | undefined;
	remove(id: string): Promise<void>;
	closeAll(): void;
	/**
	 * Fires whenever an account becomes connected+authenticated — both the
	 * initial connect and every later reconnect after an unexpected
	 * disconnect (the lib now drives reconnection itself, through the same
	 * rate-limited connect path used for the initial connect, rather than
	 * each account reconnecting independently — see the lib's
	 * `SpacemoltClient.handleAccountDisconnected`). A reconnect replaces the
	 * `LibManagedAccount` instance for that id, so this is how a caller
	 * knows to re-index/re-wire it. Returns an unsubscribe function.
	 */
	onAccountConnected(listener: (account: LibManagedAccount) => void): () => void;
	/**
	 * Fires when an account is dropped for good: a terminal close (session
	 * replaced by another connection, or an auth timeout) that is never
	 * reconnected, or a reconnect attempt that exhausted its retries.
	 */
	onAccountDisconnected(listener: (id: string, err: ConnectionClosedError) => void): () => void;
}

/** The player_id for a managed account. Throws if the account has no `player.id` yet. */
export function playerId(account: LibManagedAccount): string {
	const id = account.player?.id;
	if (!id) {
		throw new Error("Account has no player_id (player state not yet available)");
	}
	return id;
}
