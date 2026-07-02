import type { ClerkPlayer, GameState, StateSection } from "@spacemolt/lib";

/** The subset of a lib `Account` the account layer depends on. */
export interface LibAccountLike {
	readonly player?: { id: string };
	/** Store key / username this account is managed under (Account.id). */
	readonly id?: string;
	/** Live push-fed state cache. Treat as read-only. */
	readonly state: Readonly<GameState>;
	onStateChange(listener: (changed: StateSection[]) => void): void;
	close(): void;
}

/** The subset of the lib `SpacemoltClient` the account layer depends on. */
export interface AccountClientLike {
	connectOwned(opts: { filter?: (p: ClerkPlayer) => boolean }): Promise<LibAccountLike[]>;
	accounts(): LibAccountLike[];
	account(id: string): LibAccountLike | undefined;
	remove(id: string): Promise<void>;
	closeAll(): void;
}
