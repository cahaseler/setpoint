/**
 * Typed raw passthrough (`sp.account(id).raw`) — a `Proxy`-based facade over
 * `@spacemolt/lib`'s `Commands`, translating `raw.<group>.<action>(params)`
 * calls into `POST /accounts/:id/raw` requests (`handleRawAction` in
 * `src/server/handlers.ts`).
 *
 * Param types are taken directly from `Commands[group][action]`, so the
 * typed surface tracks the lib's generated command signatures. The return
 * type is NOT the lib's WS-based `MutationResult`/`QueryResult` — it's the
 * daemon's normalized `RawEnvelope`, since the daemon's HTTP raw route
 * flattens both into one shape (see `RawEnvelope`'s doc comment).
 */

import type { RawEnvelope } from "@setpoint/protocol";
import type { Commands } from "@spacemolt/lib";
import type { SetpointClient } from "./client.js";

/**
 * Typed facade over `Commands`: each group/action keeps the lib's exact
 * parameter list (including zero-arg and optional-param actions, e.g.
 * `spacemolt.undock()` or `spacemolt.accept_mission()`), but returns
 * `Promise<RawEnvelope>` instead of the lib's result type.
 *
 * `Commands[G][A] extends (...args: infer Args) => unknown` preserves the
 * source function's arity/optionality via `Args` rather than collapsing
 * every action to a single `(params: X) => ...` shape — that's what makes
 * both `undock()` (no args) and `jump({id})` (required arg) typecheck.
 */
export type RawApi = {
	[G in keyof Commands]: {
		[A in keyof Commands[G]]: Commands[G][A] extends (...args: infer Args) => unknown
			? (...args: Args) => Promise<RawEnvelope>
			: never;
	};
};

/**
 * A prop is only ever a valid group/action name if it's a string other than
 * `"then"`. Symbols (e.g. `Symbol.toPrimitive`, `Symbol.iterator`) show up
 * when the runtime coerces the proxy in some way; `"then"` shows up when
 * `await`/`Promise.resolve` probes for thenable-ness. Returning a callable
 * function for either would make the proxy misbehave — worst case, get
 * mistaken for a thenable and hang a `Promise.resolve(raw...)` chain.
 */
function isRoutableProp(prop: string | symbol): prop is string {
	return typeof prop === "string" && prop !== "then";
}

function createActionProxy(client: SetpointClient, id: string, group: string): unknown {
	return new Proxy(
		{},
		{
			get(_target, action): unknown {
				if (!isRoutableProp(action)) return undefined;
				return (params?: unknown): Promise<RawEnvelope> =>
					client.request("POST", `/accounts/${encodeURIComponent(id)}/raw`, {
						body: { toolGroup: group, action, params },
					}) as Promise<RawEnvelope>;
			},
		},
	);
}

/** Builds the typed raw-passthrough proxy for a single account id. */
export function createRawApi(client: SetpointClient, id: string): RawApi {
	const groupProxies = new Map<string, unknown>();

	const topProxy = new Proxy(
		{},
		{
			get(_target, group): unknown {
				if (!isRoutableProp(group)) return undefined;
				let groupProxy = groupProxies.get(group);
				if (groupProxy === undefined) {
					groupProxy = createActionProxy(client, id, group);
					groupProxies.set(group, groupProxy);
				}
				return groupProxy;
			},
		},
	);

	return topProxy as RawApi;
}
