import type { ClerkPlayer, GameState, StateSection } from "@spacemolt/lib";
import type { AccountClientLike, LibAccountLike } from "../../src/accounts/lib-types.js";

export class FakeAccount implements LibAccountLike {
	closed = false;
	private _state: GameState;
	private listener: ((changed: StateSection[]) => void) | null = null;
	constructor(
		private readonly playerId: string,
		readonly id: string,
		initialState: GameState = {},
	) {
		this._state = initialState;
	}
	get player(): { id: string } {
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
	connectOwned(opts: { filter?: (p: ClerkPlayer) => boolean }): Promise<LibAccountLike[]> {
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
	accounts(): LibAccountLike[] {
		return [...this.connected.values()];
	}
	account(id: string): LibAccountLike | undefined {
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
