import type {
	ClerkPlayer,
	Commands,
	GameState,
	MarketBook,
	MutationResult,
	ObservationView,
	QueryResult,
	RegisterParams,
	RegisterResult,
	StateSection,
} from "@spacemolt/lib";
import type { AccountClientLike, LibManagedAccount } from "../../src/accounts/lib-types.js";

/** Generic recording proxy: any `commands.<group>.<action>(...)` call resolves to an empty MutationResult. */
function makeFakeCommands(): Commands {
	const groupProxy = new Proxy(
		{},
		{
			get: (_group, action) => {
				if (typeof action !== "string") return undefined;
				return (): Promise<MutationResult> =>
					Promise.resolve({ command: action, tick: 0, delta: {} });
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
	return commandsProxy as unknown as Commands;
}

export class FakeAccount implements LibManagedAccount {
	closed = false;
	private _state: GameState;
	private listener: ((changed: StateSection[]) => void) | null = null;
	readonly commands: Commands = makeFakeCommands();
	private readonly marketBooks = new Map<string, MarketBook>();
	private _observation: ObservationView | null = null;
	constructor(
		private readonly playerId: string,
		readonly id: string,
		initialState: GameState = {},
	) {
		this._state = initialState;
	}
	get player(): { id: string; username?: string; empire?: string } {
		return { id: this.playerId };
	}
	get state(): Readonly<GameState> {
		return this._state;
	}
	/** Test helper: replace state and emit the given changed sections. */
	emitStateChange(changed: StateSection[], nextState?: GameState): void {
		if (nextState) {
			this._state = nextState;
		}
		this.listener?.(changed);
	}
	onStateChange(listener: (changed: StateSection[]) => void): void {
		this.listener = listener;
	}
	refresh(): Promise<Readonly<GameState>> {
		return Promise.resolve(this._state);
	}
	query(_tool: string, action: string, _payload?: Record<string, unknown>): Promise<QueryResult> {
		return Promise.resolve({ result: action, structuredContent: {} });
	}
	send(
		_tool: string,
		action: string,
		_payload?: Record<string, unknown>,
	): Promise<QueryResult | MutationResult> {
		return Promise.resolve({ command: action, tick: 0, delta: {} });
	}
	mutate(
		_tool: string,
		action: string,
		_payload?: Record<string, unknown>,
	): Promise<MutationResult> {
		return Promise.resolve({ command: action, tick: 0, delta: {} });
	}
	close(): void {
		this.closed = true;
	}
	market(baseId: string): MarketBook | undefined {
		return this.marketBooks.get(baseId);
	}
	/** Simulates having subscribed and received data for a base's order book. */
	setMarketBook(baseId: string, book: MarketBook): void {
		this.marketBooks.set(baseId, book);
	}
	observation(): ObservationView | null {
		return this._observation;
	}
	/** Simulates having subscribed and received observation-watch data. */
	setObservation(view: ObservationView | null): void {
		this._observation = view;
	}
}

export class FakeClient implements AccountClientLike {
	lastFilter?: ((p: ClerkPlayer) => boolean) | undefined;
	/** Number of times listOwnedPlayers() has been called — for TTL-cache tests. */
	listOwnedPlayersCallCount = 0;
	private connected = new Map<string, FakeAccount>();
	constructor(
		private readonly players: ClerkPlayer[],
		private readonly accountsByUsername: Map<string, FakeAccount>,
	) {}
	connectOwned(opts: {
		filter?: (p: ClerkPlayer) => boolean;
		onConnect?: (account: LibManagedAccount) => void;
	}): Promise<LibManagedAccount[]> {
		this.lastFilter = opts.filter;
		const selected = opts.filter ? this.players.filter(opts.filter) : this.players;
		for (const player of selected) {
			const acct = this.accountsByUsername.get(player.username);
			if (acct) {
				this.connected.set(player.username, acct);
				opts.onConnect?.(acct);
			}
		}
		return Promise.resolve([...this.connected.values()]);
	}
	/** Connect a single stored account by username. Throws if it isn't in the fixture map (simulates unknown creds). */
	connect(id: string): Promise<LibManagedAccount> {
		const acct = this.accountsByUsername.get(id);
		if (!acct) {
			return Promise.reject(new Error(`FakeClient.connect: no stored account for "${id}"`));
		}
		this.connected.set(id, acct);
		return Promise.resolve(acct);
	}
	/** Registers a brand-new account: creates and connects a FakeAccount keyed by username, playerId `pid-<username>`. */
	register(
		params: RegisterParams,
	): Promise<{ account: LibManagedAccount; result: RegisterResult }> {
		const playerId = `pid-${params.username}`;
		const account = new FakeAccount(playerId, params.username);
		this.accountsByUsername.set(params.username, account);
		this.connected.set(params.username, account);
		return Promise.resolve({
			account,
			result: { password: "generated-password", player_id: playerId, state: {} },
		});
	}
	/** Passthrough over the fixture player list, ignoring connection status. */
	listOwnedPlayers(): Promise<ClerkPlayer[]> {
		this.listOwnedPlayersCallCount++;
		return Promise.resolve(this.players);
	}
	accounts(): LibManagedAccount[] {
		return [...this.connected.values()];
	}
	account(id: string): LibManagedAccount | undefined {
		return this.connected.get(id);
	}
	remove(id: string): Promise<void> {
		this.connected.get(id)?.close();
		this.connected.delete(id);
		return Promise.resolve();
	}
	closeAll(): void {
		for (const a of this.connected.values()) {
			a.close();
		}
		this.connected.clear();
	}
}
