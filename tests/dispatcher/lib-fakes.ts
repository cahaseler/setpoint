import type { Commands, GameState, MutationResult } from "@spacemolt/lib";
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
