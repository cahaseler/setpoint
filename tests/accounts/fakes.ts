import type {
	ClerkPlayer,
	Commands,
	GameState,
	MutationResult,
	QueryResult,
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
}

export class FakeClient implements AccountClientLike {
	lastFilter?: ((p: ClerkPlayer) => boolean) | undefined;
	private connected = new Map<string, FakeAccount>();
	constructor(
		private readonly players: ClerkPlayer[],
		private readonly accountsByUsername: Map<string, FakeAccount>,
	) {}
	connectOwned(opts: { filter?: (p: ClerkPlayer) => boolean }): Promise<LibManagedAccount[]> {
		this.lastFilter = opts.filter;
		const selected = opts.filter ? this.players.filter(opts.filter) : this.players;
		for (const player of selected) {
			const acct = this.accountsByUsername.get(player.username);
			if (acct) {
				this.connected.set(player.username, acct);
			}
		}
		return Promise.resolve([...this.connected.values()]);
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
