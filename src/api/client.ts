import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { components } from "../generated/api-types.js";
import {
	type BandwidthTracker,
	bandwidthTracker as defaultTracker,
} from "../util/bandwidth-tracker.js";
import { ApiError, HttpError, RateLimitError, SessionExpiredError } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("api-client");

// Read version from package.json at module load
const pkgPath = join(import.meta.dir, "..", "..", "package.json");
const pkgVersion = (() => {
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
		return pkg.version;
	} catch {
		return "unknown";
	}
})();
const USER_AGENT = `setpoint/${pkgVersion}`;

type V2Response = components["schemas"]["V2Response"];
type SessionInfo = NonNullable<V2Response["session"]>;
type Notification = NonNullable<V2Response["notifications"]>[number];

/** Parsed response from the SpaceMolt API with typed structuredContent. */
export interface ApiResponse<T = unknown> {
	/** Human-readable result text. */
	result: unknown;
	/** Typed structured content for programmatic use. */
	structuredContent: T;
	/** Accumulated notifications since last request. */
	notifications: Notification[];
	/** Current session info. */
	session: SessionInfo | undefined;
}

/** Standard request body shape for gameplay endpoints. */
export interface GameActionParams {
	id?: string;
	quantity?: number;
	text?: string;
}

/** Auth request body shape for login/register endpoints. */
export interface AuthParams {
	username?: string;
	password?: string;
	registration_code?: string;
	empire?: "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim";
}

export interface SpaceMoltClientOptions {
	/** Base URL for the SpaceMolt API. Defaults to https://game.spacemolt.com */
	baseUrl?: string;
	/** Custom fetch implementation for testing. */
	fetch?: typeof globalThis.fetch;
	/** Delay in milliseconds between retries on 5xx errors. Defaults to 5000. */
	retryDelayMs?: number;
	/** Bandwidth tracker instance. Defaults to the module-level singleton. Pass a fresh instance in tests. */
	bandwidthTracker?: BandwidthTracker;
}

const DEFAULT_BASE_URL = "https://game.spacemolt.com";
const DEFAULT_RETRY_DELAY_MS = 5_000;

/**
 * Game error codes signalling a recoverable session/auth problem: the session
 * must be re-established (recreate + login) and the request retried. The game
 * returns these in the response body (often not as HTTP 401) — e.g. after a
 * game-server restart wipes logins it returns `not_authenticated` ("You must be
 * logged in") — so without this they would bypass the 401-based recovery path
 * and surface as hard failures (failed keepalives, failed async jobs).
 */
const SESSION_RECOVERY_CODES: ReadonlySet<string> = new Set([
	"session_invalid",
	"not_authenticated",
	"session_required",
]);

/**
 * Low-level HTTP client for the SpaceMolt v2 REST API.
 *
 * Handles request construction, response envelope parsing, and error
 * classification. Does NOT manage sessions — that's the session manager's job.
 */
export class SpaceMoltClient {
	private readonly baseUrl: string;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly retryDelayMs: number;
	private readonly tracker: BandwidthTracker;

	constructor(options: SpaceMoltClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.tracker = options.bandwidthTracker ?? defaultTracker;
	}

	/** Create a new API session. Returns the session ID. */
	async createSession(): Promise<ApiResponse<{ id: string }>> {
		return this.request<{ id: string }>("POST", "/api/v2/session");
	}

	/**
	 * Execute a game action (POST /api/v2/{toolGroup}/{action}).
	 * Requires a session ID.
	 */
	async gameAction<T = unknown>(
		toolGroup: string,
		action: string,
		params: Record<string, unknown>,
		sessionId: string,
		accountId?: string,
	): Promise<ApiResponse<T>> {
		return this.request<T>(
			"POST",
			`/api/v2/${toolGroup}/${action}`,
			{ ...params },
			sessionId,
			accountId,
		);
	}

	/**
	 * Execute an auth action (login, register, logout, claim).
	 * Requires a session ID.
	 */
	async authAction<T = unknown>(
		action: string,
		params: AuthParams,
		sessionId: string,
		accountId?: string,
	): Promise<ApiResponse<T>> {
		return this.request<T>(
			"POST",
			`/api/v2/spacemolt_auth/${action}`,
			{ ...params },
			sessionId,
			accountId,
		);
	}

	/** Poll notifications (GET /api/v2/notifications). */
	async getNotifications(sessionId: string): Promise<ApiResponse<unknown>> {
		return this.request<unknown>("GET", "/api/v2/notifications", undefined, sessionId);
	}

	/**
	 * Transparently forward an arbitrary game-API request and relay the raw
	 * response (status, content type, body) without parsing, retrying, or
	 * throwing on game-level errors.
	 *
	 * Used by the daemon's raw-passthrough proxy: the external spacemolt CLI is
	 * pointed at the daemon (via SPACEMOLT_URL), so its requests egress with our
	 * User-Agent and Accept-Encoding — branded, compressed, and bandwidth-tracked
	 * like the rest of the daemon's traffic — while the CLI keeps full control of
	 * request shaping and response handling. The game's response is relayed back
	 * verbatim so the CLI's behavior is unchanged.
	 */
	async forward(
		method: string,
		path: string,
		body: string | undefined,
		sessionId: string | undefined,
		contentType: string | undefined,
		accountId = "raw-proxy",
	): Promise<{ status: number; contentType: string; body: string }> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Accept-Encoding": "zstd, gzip",
			"User-Agent": USER_AGENT,
		};
		if (sessionId) {
			headers["X-Session-Id"] = sessionId;
		}
		if (contentType) {
			headers["Content-Type"] = contentType;
		}

		let response: Response;
		try {
			const init: RequestInit = { method, headers };
			if (body !== undefined && method !== "GET" && method !== "HEAD") {
				init.body = body;
			}
			response = await this.fetchFn(url, init);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Network error";
			throw new HttpError(`Forward to ${path} failed: ${message}`, 0);
		}

		const bodyText = await response.text();
		const contentLengthHeader = response.headers.get("content-length");
		const contentLength =
			contentLengthHeader !== null ? Number.parseInt(contentLengthHeader, 10) : null;
		const bytes =
			contentLength !== null && !Number.isNaN(contentLength)
				? contentLength
				: new TextEncoder().encode(bodyText).length;
		this.tracker.record(accountId, path.split("?")[0] ?? path, bytes);

		return {
			status: response.status,
			contentType: response.headers.get("content-type") ?? "application/json",
			body: bodyText,
		};
	}

	private async request<T>(
		method: "GET" | "POST",
		path: string,
		body?: Record<string, unknown>,
		sessionId?: string,
		accountId?: string,
	): Promise<ApiResponse<T>> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Accept-Encoding": "zstd, gzip",
			"User-Agent": USER_AGENT,
		};

		if (sessionId) {
			headers["X-Session-Id"] = sessionId;
		}

		if (body && method === "POST") {
			headers["Content-Type"] = "application/json";
		}

		log.debug(`${method} ${path}`);

		const MAX_RETRIES = 5;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			let response: Response;
			try {
				const init: RequestInit = { method, headers };
				if (method === "POST") {
					init.body = JSON.stringify(body ?? {});
				}
				response = await this.fetchFn(url, init);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Network error";
				throw new HttpError(`Request to ${path} failed: ${message}`, 0);
			}

			// Retry on 5xx (server/proxy errors like 502, 503, 524) — these are transient.
			// Uses exponential backoff with jitter to avoid thundering herd when many
			// accounts are running concurrently.
			if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
				const backoff = this.retryDelayMs * 2 ** attempt;
				const jitter = Math.random() * backoff;
				const delay = Math.round(backoff + jitter);
				log.warn(
					`${method} ${path} returned HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
				);
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
				continue;
			}

			// Buffer body text once — used for both parsing and bandwidth measurement.
			// Content-Length gives compressed wire bytes (gzip); fall back to UTF-8 byte
			// count of the decompressed body when the header is absent (chunked transfer).
			const bodyText = await response.text();
			const contentLengthHeader = response.headers.get("content-length");
			const contentLength =
				contentLengthHeader !== null ? Number.parseInt(contentLengthHeader, 10) : null;
			const bytes =
				contentLength !== null && !Number.isNaN(contentLength)
					? contentLength
					: new TextEncoder().encode(bodyText).length;

			if (accountId) {
				this.tracker.record(accountId, path, bytes);
			}

			return this.parseBodyText<T>(response, path, bodyText);
		}

		// Unreachable, but TypeScript needs it
		throw new HttpError(`Request to ${path} failed after ${MAX_RETRIES} retries`, 500);
	}

	/**
	 * Throw the typed error for a response-body error. Session/auth codes become
	 * SessionExpiredError so the session layer's recovery + retry fires (the game
	 * signals these in-body, not necessarily via HTTP 401).
	 */
	private throwResponseError(error: NonNullable<V2Response["error"]>, statusCode: number): never {
		if (error.code && SESSION_RECOVERY_CODES.has(error.code)) {
			throw new SessionExpiredError(error.message ?? undefined);
		}
		throw ApiError.fromResponse(error, statusCode);
	}

	private parseBodyText<T>(response: Response, path: string, bodyText: string): ApiResponse<T> {
		if (response.status === 401) {
			throw new SessionExpiredError();
		}

		if (response.status === 429) {
			const retryAfter = Number.parseFloat(response.headers.get("Retry-After") ?? "60");
			let message = "Rate limited";
			try {
				const body = JSON.parse(bodyText) as { message?: string };
				message = body.message ?? message;
			} catch {
				// No JSON body in 429 — use default message
			}
			throw new RateLimitError(message, Number.isNaN(retryAfter) ? 60 : retryAfter);
		}

		const contentType = response.headers.get("content-type") ?? "";
		const isJson = contentType.includes("application/json");

		if (!response.ok) {
			if (isJson) {
				try {
					const body = JSON.parse(bodyText) as V2Response;
					if (body.error) {
						this.throwResponseError(body.error, response.status);
					}
				} catch (err) {
					if (err instanceof ApiError) {
						throw err;
					}
					// JSON parse failed — fall through to generic error
				}
			}
			throw new HttpError(`HTTP ${response.status} from ${path}`, response.status);
		}

		if (!isJson) {
			throw new HttpError(
				`HTTP ${response.status} from ${path}: expected JSON but got ${contentType || "unknown content type"}`,
				response.status,
			);
		}

		const body = JSON.parse(bodyText) as V2Response;

		if (body.error) {
			this.throwResponseError(body.error, response.status);
		}

		return {
			result: body.result,
			structuredContent: body.structuredContent as T,
			notifications: body.notifications ?? [],
			session: body.session,
		};
	}
}
