/** Typed error classes for `@setpoint/client`. */

/** Shape of the JSON body returned alongside a non-2xx response, when parseable. */
export interface SetpointHttpErrorBody {
	error?: string;
}

/** Thrown for any non-2xx HTTP response other than 410 (see `DeprecatedGoalError`). */
export class SetpointHttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: SetpointHttpErrorBody,
	) {
		super(body.error ?? `Request failed with status ${status}`);
		this.name = "SetpointHttpError";
	}
}

/** Thrown for HTTP 410 responses — the endpoint has been removed (e.g. deprecated managed crafting goals). */
export class DeprecatedGoalError extends SetpointHttpError {
	constructor(body: SetpointHttpErrorBody) {
		super(410, body);
		this.name = "DeprecatedGoalError";
	}
}

/**
 * Thrown when a synchronous goal (`account.goal()`) fails during execution.
 *
 * `handleExecuteGoal` (`src/server/handlers.ts`) commits an HTTP 200 response
 * before the goal runs, then streams the goal's outcome once it settles. A
 * failed goal streams `{error: string}` — NOT a `GoalResult` — over that same
 * 200 response, so the client can't distinguish success from failure by
 * status code alone. `AccountApi.goal()` detects that shape and throws this
 * instead of resolving, matching `runToCompletion`'s throw-on-failure behavior.
 */
export class GoalFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalFailedError";
	}
}

/** Thrown when the server is not reachable (ECONNREFUSED, ECONNRESET, etc.), after retries are exhausted. */
export class ConnectionError extends Error {
	constructor(
		public readonly baseUrl: string,
		cause?: unknown,
	) {
		super(`Could not connect to ${baseUrl}`);
		this.name = "ConnectionError";
		if (cause instanceof Error) {
			this.cause = cause;
		}
	}
}

/** Thrown when the server accepted the connection but did not respond within the configured timeout. */
export class TimeoutError extends Error {
	constructor(
		public readonly baseUrl: string,
		public readonly timeoutMs: number,
		public readonly path: string,
	) {
		super(`Server did not respond within ${Math.round(timeoutMs / 1000)}s for ${path}`);
		this.name = "TimeoutError";
	}
}
