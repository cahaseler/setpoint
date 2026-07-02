import type { FindRouteResponse, GameState, MutationResult, QueryResult } from "@spacemolt/lib";
import type { LibGoalAccount, LibGoalCommands } from "../../src/dispatcher/lib-goal-context.js";

/** One recorded command invocation, for assertions. */
export interface RecordedCall {
	action: keyof LibGoalCommands;
	params?: unknown;
}

/** Programmable handlers: return a value or throw to simulate game errors. */
export interface FakeCommandHandlers {
	travel?: (params: { id: string }) => Promise<MutationResult> | MutationResult;
	undock?: () => Promise<MutationResult> | MutationResult;
	find_route?: (params: { id: string }) =>
		| Promise<QueryResult<FindRouteResponse>>
		| QueryResult<FindRouteResponse>;
	jump?: (params: { id: string }) => Promise<MutationResult> | MutationResult;
	refuel?: (params?: { id?: string; quantity?: number; target?: string }) =>
		| Promise<MutationResult>
		| MutationResult;
}

/** A minimal MutationResult with an empty delta — the default for handlers that don't set state. */
export function fakeMutationResult(command: string): MutationResult {
	return { command, tick: 0, delta: {} };
}

/**
 * In-memory `LibGoalAccount` double. Holds a mutable `GameState`; command
 * handlers may call `setState` to simulate a delta being applied to the cache
 * (so a goal's post-mutation `account.state` read sees the new value). Tracks
 * every command call and every `refresh()` call.
 */
export class FakeLibGoalAccount implements LibGoalAccount {
	private _state: GameState;
	readonly calls: RecordedCall[] = [];
	refreshCalls = 0;
	/** State returned by the next `refresh()` (defaults to current state). */
	refreshReturns?: GameState;
	readonly commands: { spacemolt: LibGoalCommands };

	constructor(initial: GameState = {}, handlers: FakeCommandHandlers = {}) {
		this._state = initial;
		const record = <T>(
			action: keyof LibGoalCommands,
			params: unknown,
			run: () => Promise<T> | T,
		): Promise<T> => {
			this.calls.push(params === undefined ? { action } : { action, params });
			return Promise.resolve(run());
		};
		this.commands = {
			spacemolt: {
				travel: (params) =>
					record("travel", params, () => handlers.travel?.(params) ?? fakeMutationResult("travel")),
				undock: () =>
					record("undock", undefined, () => handlers.undock?.() ?? fakeMutationResult("undock")),
				find_route: (params) =>
					record("find_route", params, () => {
						if (!handlers.find_route) throw new Error("find_route handler not set");
						return handlers.find_route(params);
					}),
				jump: (params) =>
					record("jump", params, () => handlers.jump?.(params) ?? fakeMutationResult("jump")),
				refuel: (params) =>
					record("refuel", params, () => handlers.refuel?.(params) ?? fakeMutationResult("refuel")),
			},
		};
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
