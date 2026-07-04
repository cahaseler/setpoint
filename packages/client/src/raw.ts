/**
 * Typed raw passthrough (`sp.account(id).raw`) — a `Proxy`-based facade over
 * `@spacemolt/lib`'s `Commands`, translating `raw.<group>.<action>(params)`
 * calls into `POST /accounts/:id/raw` requests (`handleRawAction` in
 * `src/server/handlers.ts`).
 *
 * Param types are taken directly from `Commands[group][action]`, so the
 * typed surface tracks the lib's generated command signatures. The return
 * type is NOT the lib's WS-based `MutationResult`/`QueryResult` directly —
 * it's the daemon's normalized `RawEnvelope`, since the daemon's HTTP raw
 * route flattens both into one shape (see `RawEnvelope`'s doc comment) — but
 * `RawEnvelope`'s `structuredContent` is still inferred per action from the
 * lib's own return type below, so it's never `unknown` for a real command.
 */

import type { MutationResult, QueryResult, RawEnvelope } from "@setpoint/protocol";
import type { Commands } from "@spacemolt/lib";
import type { SetpointClient } from "./client.js";

/**
 * `structuredContent`'s shape for a given lib return type `R`: a query's own
 * response type (`R extends QueryResult<infer T>`), or a mutation's whole
 * delta shape — including its action-specific `details` — read directly off
 * `R['delta']` rather than reconstructed, so it stays in lockstep with
 * whatever `MutationResult<TDetails>['delta']` actually is.
 *
 * Checked against the real `QueryResult`/`MutationResult` interfaces, not a
 * hand-rolled `{ structuredContent?: infer T }` shape — `structuredContent`
 * is optional on `QueryResult` itself, and TS conditional-type inference on
 * an optional property matches *any* type (including ones missing the
 * property entirely), inferring `unknown` — silently discarding the
 * mutation branch below for every action. `QueryResult`'s required `result`
 * field is what actually anchors the check.
 */
type StructuredContentOf<R> = R extends QueryResult<infer T>
	? T
	: R extends MutationResult<infer _TDetails>
		? R["delta"]
		: unknown;

/**
 * Typed facade over `Commands`: each group/action keeps the lib's exact
 * parameter list (including zero-arg and optional-param actions, e.g.
 * `spacemolt.undock()` or `spacemolt.accept_mission()`), and now also keeps
 * the lib's exact per-action response shape — `structuredContent` is typed
 * to the query's response, or to the mutation's delta (with its
 * action-specific `delta.details`, e.g. `JumpResponse` for `jump`) — instead
 * of collapsing every action to the same generic `RawEnvelope`.
 *
 * `Commands[G][A] extends (...args: infer Args) => Promise<infer R>`
 * preserves the source function's arity/optionality via `Args` (so both
 * `undock()` and `jump({id})` typecheck) while also capturing its resolved
 * value `R` to infer `structuredContent`'s type from.
 */
export type RawApi = {
	[G in keyof Commands]: {
		[A in keyof Commands[G]]: Commands[G][A] extends (...args: infer Args) => Promise<infer R>
			? (...args: Args) => Promise<RawEnvelope<StructuredContentOf<R>>>
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
