import type {
	ClerkPlayer,
	Commands,
	GameState,
	MutationResult,
	QueryResult,
	RegisterParams,
	RegisterResult,
	StateSection,
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
}

/** The subset of a lib `Account` the account layer (connection/state) depends on. */
export type LibAccountLike = Pick<
	LibManagedAccount,
	"player" | "id" | "state" | "onStateChange" | "close"
>;

/** The subset of the lib `SpacemoltClient` the account layer depends on. */
export interface AccountClientLike {
	connectOwned(opts: { filter?: (p: ClerkPlayer) => boolean }): Promise<LibManagedAccount[]>;
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
}

/** The player_id for a managed account. Throws if the account has no `player.id` yet. */
export function playerId(account: LibManagedAccount): string {
	const id = account.player?.id;
	if (!id) {
		throw new Error("Account has no player_id (player state not yet available)");
	}
	return id;
}
