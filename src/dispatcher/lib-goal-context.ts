import type { FindRouteResponse, GameState, MutationResult, QueryResult } from "@spacemolt/lib";
import type { GoalResult } from "./goals.js";

/**
 * The subset of a lib `Account`'s `spacemolt` command group the ported slice
 * goals invoke. Typed with the lib's generated param/result types so calls are
 * checked and fakes stay honest. The real `account.commands.spacemolt` object
 * structurally satisfies this.
 */
export interface LibGoalCommands {
	travel(params: { id: string }): Promise<MutationResult>;
	undock(): Promise<MutationResult>;
	find_route(params: { id: string }): Promise<QueryResult<FindRouteResponse>>;
	jump(params: { id: string }): Promise<MutationResult>;
	refuel(params?: { id?: string; quantity?: number; target?: string }): Promise<MutationResult>;
}

/**
 * Narrow boundary over a lib `Account` for goal execution. The real `Account`
 * satisfies this structurally (`get state()`, `refresh()`, `get commands()`);
 * tests supply a fake. Kept separate from `LibAccountLike` (the account-manager
 * boundary) because goal execution needs `commands`/`refresh` that the manager
 * does not.
 */
export interface LibGoalAccount {
	/**
	 * Live, push-fed game-state cache. Always current — safe to read directly
	 * after any awaited mutation, whose delta is applied to the cache before the
	 * mutation promise resolves.
	 */
	readonly state: Readonly<GameState>;
	/** Force a live `get_status` re-seed of the cache. Returns the refreshed state. */
	refresh(): Promise<Readonly<GameState>>;
	readonly commands: { spacemolt: LibGoalCommands };
}

/** Context passed to a lib-backed goal during execution. */
export interface LibGoalContext {
	/** The lib account: typed commands + live state cache. */
	readonly account: LibGoalAccount;
	/**
	 * Live view of current game state. A getter over `account.state`, so it is
	 * never a stale snapshot even if `execute` runs long after context creation.
	 */
	readonly state: Readonly<GameState>;
	/**
	 * Return current game state. Non-forced returns the push-fed cache for free
	 * (no wire call — this is the bandwidth win). Pass `{ force: true }` to run a
	 * live `get_status` re-seed via `account.refresh()` — required after jumps,
	 * whose deltas may not carry position, and when location is unknown.
	 */
	refreshState(opts?: { force?: boolean }): Promise<Readonly<GameState>>;
	/** Signal for external cancellation. Goals should check this before starting work. */
	signal?: AbortSignal;
}

/** A lib-backed primitive goal — same contract as `Goal`, over `LibGoalContext`. */
export interface LibGoal {
	/** Unique identifier for this goal type. */
	readonly name: string;
	/** Execute the goal: check state, validate prereqs, take action if needed. */
	execute(ctx: LibGoalContext): Promise<GoalResult>;
}

/**
 * Build a `LibGoalContext` around a lib account. `state` is a live getter over
 * `account.state`; `refreshState` reads the cache for free unless `force` runs a
 * live `account.refresh()`.
 */
export function makeLibGoalContext(account: LibGoalAccount, signal?: AbortSignal): LibGoalContext {
	return {
		account,
		get state(): Readonly<GameState> {
			return account.state;
		},
		refreshState(opts?: { force?: boolean }): Promise<Readonly<GameState>> {
			if (opts?.force) {
				return account.refresh();
			}
			return Promise.resolve(account.state);
		},
		...(signal ? { signal } : {}),
	};
}
