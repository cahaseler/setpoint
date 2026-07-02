import type { components } from "../generated/api-types.js";
import { ApiError, RateLimitError, SessionExpiredError, errorMessage } from "../util/errors.js";
import { createLogger, redactToken } from "../util/logger.js";
import type { ApiResponse, AuthParams, SpaceMoltClient } from "./client.js";

const log = createLogger("session");

type LoginResponse = components["schemas"]["LoginResponse"];

export type SessionState = "disconnected" | "connecting" | "active" | "recovering";

/**
 * Controls access to the auth endpoint across multiple sessions.
 * Implementations must cap granted acquire() calls to stay within the
 * server's fixed-window auth rate limit.
 */
export interface AuthSlot {
	acquire(): Promise<void>;
}

export interface SessionInfo {
	sessionId: string;
	playerId: string | undefined;
	createdAt: Date;
	expiresAt: Date;
}

export interface AccountCredentials {
	username: string;
	password: string;
}

/**
 * Called after every successful API response.
 * Allows external systems (like the state updater) to observe all responses.
 */
export type ResponseCallback = (structuredContent: unknown) => void;

/** Called when the session ID or expiry changes (connect, resume, keepalive). */
export type SessionChangedCallback = (sessionId: string, expiresAt: Date) => void;

/** Tracks a single account's session lifecycle. */
/** Maximum number of recovery attempts before giving up. */
const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Delay between action_in_progress polls in ms.
 * Slightly longer than one tick (10s) to give the current game action time to advance.
 */
const ACTION_IN_PROGRESS_WAIT_MS = 12_000;

/**
 * Maximum number of action_in_progress polls before giving up.
 * Sized to cover a worst-case reconnect mid-travel (~270s / 12s ≈ 23 polls), with margin.
 */
const MAX_ACTION_IN_PROGRESS_RETRIES = 25;

/** Delay between recovery attempts in ms. */
const RECOVERY_DELAY_MS = 1000;

/**
 * Whether the error means the ship is busy with an in-flight action and the
 * command should be re-polled: action_in_progress (action queued this tick)
 * or in_transit (mid-jump, arrival pending).
 */
function isShipBusyError(err: unknown): err is ApiError {
	return (
		err instanceof ApiError && (err.code === "action_in_progress" || err.code === "in_transit")
	);
}

export class Session {
	private client: SpaceMoltClient;
	private credentials: AccountCredentials;
	private sessionInfo: SessionInfo | undefined;
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
	private _state: SessionState = "disconnected";
	private _lastLoginResponse: LoginResponse | undefined;
	private responseCallbacks: ResponseCallback[] = [];
	private sessionChangedCallbacks: SessionChangedCallback[] = [];
	/** Shared recovery promise — concurrent callers wait for the same recovery. */
	private recoveryPromise: Promise<void> | undefined;

	/** Interval between keepalive polls in ms. Defaults to 10 minutes. */
	readonly keepaliveIntervalMs: number;
	/** Delay between action_in_progress polls in ms. Defaults to 12 seconds. */
	private readonly actionInProgressWaitMs: number;
	/** Maximum number of action_in_progress polls before giving up. Defaults to 25. */
	private readonly maxActionInProgressRetries: number;
	/** Optional shared rate limiter — acquired before each connect() during recovery. */
	private readonly authSlot: AuthSlot | undefined;

	constructor(
		client: SpaceMoltClient,
		credentials: AccountCredentials,
		options: {
			keepaliveIntervalMs?: number;
			actionInProgressWaitMs?: number;
			maxActionInProgressRetries?: number;
			authSlot?: AuthSlot;
		} = {},
	) {
		this.client = client;
		this.credentials = credentials;
		this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 10 * 60 * 1000;
		this.actionInProgressWaitMs = options.actionInProgressWaitMs ?? ACTION_IN_PROGRESS_WAIT_MS;
		this.maxActionInProgressRetries =
			options.maxActionInProgressRetries ?? MAX_ACTION_IN_PROGRESS_RETRIES;
		this.authSlot = options.authSlot;
	}

	/**
	 * Register a callback that fires after every successful API response.
	 * Returns an unsubscribe function.
	 */
	onResponse(callback: ResponseCallback): () => void {
		this.responseCallbacks.push(callback);
		return () => {
			const index = this.responseCallbacks.indexOf(callback);
			if (index >= 0) {
				this.responseCallbacks.splice(index, 1);
			}
		};
	}

	/**
	 * Register a callback that fires when the session ID or expiry changes.
	 * Fires after successful connect(), tryResume(), and keepalive expiry updates.
	 * Returns an unsubscribe function.
	 */
	onSessionChanged(callback: SessionChangedCallback): () => void {
		this.sessionChangedCallbacks.push(callback);
		return () => {
			const index = this.sessionChangedCallbacks.indexOf(callback);
			if (index >= 0) {
				this.sessionChangedCallbacks.splice(index, 1);
			}
		};
	}

	get state(): SessionState {
		return this._state;
	}

	get info(): SessionInfo | undefined {
		return this.sessionInfo;
	}

	get sessionId(): string | undefined {
		return this.sessionInfo?.sessionId;
	}

	get lastLoginResponse(): LoginResponse | undefined {
		return this._lastLoginResponse;
	}

	/**
	 * Establish a session: create session → login → start keepalive.
	 * Returns the login response containing initial player/ship/system state.
	 */
	async connect(): Promise<LoginResponse> {
		if (this._state === "active") {
			log.warn(`Session for ${this.credentials.username} already active, reconnecting`);
			this.stopKeepalive();
		}

		this._state = "connecting";
		log.info(`Connecting session for ${this.credentials.username}`);

		try {
			// Step 1: Create API session
			const sessionResponse = await this.client.createSession();
			const sessionId = sessionResponse.session?.id;
			if (!sessionId) {
				throw new Error("Session creation returned no session ID");
			}

			this.sessionInfo = {
				sessionId,
				playerId: sessionResponse.session?.player_id,
				createdAt: new Date(sessionResponse.session?.created_at ?? Date.now()),
				expiresAt: new Date(sessionResponse.session?.expires_at ?? Date.now()),
			};

			log.info(`Session created: ${redactToken(sessionId)}`);

			// Step 2: Login
			const loginParams: AuthParams = {
				username: this.credentials.username,
				password: this.credentials.password,
			};

			const loginResponse = await this.client.authAction<LoginResponse>(
				"login",
				loginParams,
				sessionId,
				this.credentials.username,
			);

			// Update session info from login response (may have player_id now)
			if (loginResponse.session) {
				this.sessionInfo = {
					sessionId: loginResponse.session.id ?? sessionId,
					playerId: loginResponse.session.player_id,
					createdAt: new Date(loginResponse.session.created_at ?? Date.now()),
					expiresAt: new Date(loginResponse.session.expires_at ?? Date.now()),
				};
			}

			this._lastLoginResponse = loginResponse.structuredContent;
			this._state = "active";

			log.info(`Logged in as ${this.credentials.username} (player: ${this.sessionInfo.playerId})`);

			// Step 3: Start keepalive
			this.startKeepalive();
			this.notifySessionChanged();

			return loginResponse.structuredContent;
		} catch (err) {
			this._state = "disconnected";
			throw err;
		}
	}

	/** Disconnect: stop keepalive, clear session state. */
	disconnect(): void {
		this.stopKeepalive();
		this.sessionInfo = undefined;
		this._state = "disconnected";
		log.info(`Disconnected session for ${this.credentials.username}`);
	}

	/**
	 * Execute a game action through this session.
	 * Automatically handles session expiry by triggering recovery.
	 */
	async execute<T>(
		toolGroup: string,
		action: string,
		params: Record<string, unknown> = {},
	): Promise<ApiResponse<T>> {
		// If recovery is in progress, wait for it before trying the action
		if (this.recoveryPromise) {
			await this.recoveryPromise;
		}

		const sid = this.sessionId;
		if (!sid) {
			throw new Error(`No active session for ${this.credentials.username}`);
		}

		try {
			const response = await this.client.gameAction<T>(
				toolGroup,
				action,
				params,
				sid,
				this.credentials.username,
			);

			// Update session expiry from response
			if (response.session?.expires_at) {
				this.updateExpiry(new Date(response.session.expires_at));
			}

			return this.notifyAndUnwrap(response);
		} catch (err) {
			if (err instanceof SessionExpiredError) {
				await this.ensureRecovered();
				// Retry once with the fresh session
				return this.executeOnce<T>(toolGroup, action, params);
			}
			// The game server returns action_in_progress when the ship is busy — including
			// during long multi-tick travels — and in_transit when the ship is mid-jump.
			// Poll every tick until the action resolves. This handles reconnect-mid-travel:
			// the ship keeps traveling server-side but our HTTP connection dropped, so
			// subsequent calls see action_in_progress/in_transit until the travel
			// completes (up to ~270s worst case at 12s per poll = ~23 polls).
			if (isShipBusyError(err)) {
				for (let attempt = 0; attempt < this.maxActionInProgressRetries; attempt++) {
					log.warn(
						`${err.code} for ${this.credentials.username}, waiting ${this.actionInProgressWaitMs}ms before retry ${attempt + 1}/${this.maxActionInProgressRetries}...`,
					);
					await new Promise<void>((resolve) => setTimeout(resolve, this.actionInProgressWaitMs));
					try {
						return await this.executeOnce<T>(toolGroup, action, params);
					} catch (retryErr) {
						if (isShipBusyError(retryErr)) {
							continue;
						}
						throw retryErr;
					}
				}
				throw err;
			}
			// Respect the server's Retry-After guidance before retrying once.
			if (err instanceof RateLimitError) {
				log.warn(
					`Rate limited for ${this.credentials.username}, waiting ${err.retryAfterSeconds}s before retry...`,
				);
				await new Promise<void>((resolve) => setTimeout(resolve, err.retryAfterSeconds * 1000));
				return this.executeOnce<T>(toolGroup, action, params);
			}
			throw err;
		}
	}

	/**
	 * Execute a game action once without automatic recovery.
	 * Used for post-recovery retries to avoid infinite recursion.
	 */
	private async executeOnce<T>(
		toolGroup: string,
		action: string,
		params: Record<string, unknown>,
	): Promise<ApiResponse<T>> {
		const sid = this.sessionId;
		if (!sid) {
			throw new Error(`No active session for ${this.credentials.username}`);
		}

		const response = await this.client.gameAction<T>(
			toolGroup,
			action,
			params,
			sid,
			this.credentials.username,
		);

		if (response.session?.expires_at) {
			this.updateExpiry(new Date(response.session.expires_at));
		}

		return this.notifyAndUnwrap(response);
	}

	/**
	 * Ensure the session is recovered. If recovery is already in progress,
	 * joins the existing recovery. Otherwise starts a new one.
	 *
	 * This prevents concurrent callers from racing to create multiple sessions.
	 */
	private async ensureRecovered(): Promise<void> {
		if (this.recoveryPromise) {
			return this.recoveryPromise;
		}

		this.recoveryPromise = this.doRecover();
		try {
			await this.recoveryPromise;
		} finally {
			this.recoveryPromise = undefined;
		}
	}

	/**
	 * Recover from a session expiry: reconnect with retries.
	 * Rate limit errors during recovery wait the server's Retry-After time
	 * without consuming a recovery attempt.
	 */
	private async doRecover(): Promise<void> {
		this._state = "recovering";
		this.stopKeepalive();

		for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt++) {
			try {
				if (attempt > 0) {
					log.info(
						`Recovery attempt ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS} for ${this.credentials.username}`,
					);
					await new Promise((resolve) => setTimeout(resolve, RECOVERY_DELAY_MS));
				} else {
					log.warn(`Session expired for ${this.credentials.username}, recovering...`);
				}

				// Acquire a shared auth slot before connecting to prevent concurrent
				// recovery attempts from multiple accounts blasting the auth rate limit.
				await this.authSlot?.acquire();
				await this.connect();
				return; // Success
			} catch (err) {
				if (err instanceof RateLimitError) {
					log.warn(
						`Recovery rate limited for ${this.credentials.username}, waiting ${err.retryAfterSeconds}s...`,
					);
					await new Promise<void>((resolve) => setTimeout(resolve, err.retryAfterSeconds * 1000));
					// Don't count rate limit waits as recovery attempts — retry the same attempt
					attempt--;
					continue;
				}
				if (err instanceof SessionExpiredError && attempt + 1 < MAX_RECOVERY_ATTEMPTS) {
					log.warn(
						`Recovery attempt ${attempt + 1} failed for ${this.credentials.username}, retrying...`,
					);
					continue;
				}
				throw err;
			}
		}
	}

	/**
	 * Attempt to resume a previously persisted session without full reconnect.
	 *
	 * Validates the stored session by calling get_state. On success, sets state
	 * to active and fires onSessionChanged. On any error (e.g. 401 if the game
	 * server restarted), returns false so the caller falls back to full connect.
	 */
	async tryResume(sessionId: string, expiresAt: Date): Promise<boolean> {
		const RESUME_MARGIN_MS = 2 * 60 * 1000;
		if (expiresAt <= new Date(Date.now() + RESUME_MARGIN_MS)) {
			log.debug(`Skipping resume for ${this.credentials.username}: session expires too soon`);
			return false;
		}

		this._state = "connecting";
		this.sessionInfo = {
			sessionId,
			playerId: undefined,
			createdAt: new Date(),
			expiresAt,
		};

		try {
			log.info(`Attempting session resume for ${this.credentials.username}`);
			const response = await this.client.gameAction(
				"spacemolt",
				"get_state",
				{},
				sessionId,
				this.credentials.username,
			);

			// Update expiry and player_id from response
			if (this.sessionInfo) {
				this.sessionInfo.expiresAt = new Date(
					response.session?.expires_at ?? expiresAt.toISOString(),
				);
				this.sessionInfo.playerId = response.session?.player_id;
			}

			this._state = "active";
			this.notifyResponse(response.structuredContent);
			this.startKeepalive();
			this.notifySessionChanged();

			log.info(`Resumed session for ${this.credentials.username}`);
			return true;
		} catch (err) {
			log.info(
				`Session resume failed for ${this.credentials.username}, will reconnect: ${errorMessage(
					err,
				)}`,
			);
			this.sessionInfo = undefined;
			this._state = "disconnected";
			return false;
		}
	}

	private startKeepalive(): void {
		this.stopKeepalive();
		this.keepaliveTimer = setInterval(() => {
			void this.keepalivePoll();
		}, this.keepaliveIntervalMs);
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = undefined;
		}
	}

	private async keepalivePoll(): Promise<void> {
		const sid = this.sessionId;
		if (!sid) {
			return;
		}

		try {
			log.debug(`Keepalive poll for ${this.credentials.username}`);
			// get_queue is the cheapest authenticated query (~128B vs ~6KB for
			// get_state). All we need from keepalive is to bump the server's
			// LastSeen and surface an expired session; the queue section is a
			// harmless bonus state update.
			const response = await this.client.gameAction(
				"spacemolt",
				"get_queue",
				{},
				sid,
				this.credentials.username,
			);

			if (response.session?.expires_at) {
				this.updateExpiry(new Date(response.session.expires_at));
				this.notifySessionChanged();
			}

			this.notifyResponse(response.structuredContent);
		} catch (err) {
			if (err instanceof SessionExpiredError) {
				log.warn(`Keepalive detected expired session for ${this.credentials.username}`);
				try {
					await this.ensureRecovered();
				} catch (reconnectErr) {
					log.error(
						`Failed to recover session for ${this.credentials.username}: ${
							reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)
						}`,
					);
					this._state = "disconnected";
				}
			} else if (err instanceof RateLimitError) {
				log.warn(
					`Keepalive rate limited for ${this.credentials.username}, retry in ${err.retryAfterSeconds}s`,
				);
			} else {
				log.error(`Keepalive error for ${this.credentials.username}: ${errorMessage(err)}`);
			}
		}
	}

	private notifyResponse(structuredContent: unknown): void {
		for (const callback of this.responseCallbacks) {
			try {
				callback(structuredContent);
			} catch (err) {
				log.error(`Response callback error: ${errorMessage(err)}`);
			}
		}
	}

	/**
	 * Feed the full response envelope to the state updater, then hand the caller
	 * the action result.
	 *
	 * v2 mutation responses return the post-action V2GameState (ship, cargo,
	 * location, ...) as structuredContent, with the action's own result nested
	 * under `details`. The state updater needs the full envelope — it extracts
	 * the state fields, which is why the local store is now fresh after every
	 * mutation — but callers expect the action result at the top level (the
	 * pre-`details` contract). So we unwrap `details` when present. Query
	 * responses (get_state, get_cargo, ...) omit `details` entirely and pass
	 * through unchanged.
	 */
	private notifyAndUnwrap<T>(response: ApiResponse<T>): ApiResponse<T> {
		this.notifyResponse(response.structuredContent);
		const sc: unknown = response.structuredContent;
		if (sc !== null && typeof sc === "object" && "details" in sc) {
			const details = (sc as { details?: unknown }).details;
			if (details !== undefined) {
				return { ...response, structuredContent: details as T };
			}
		}
		return response;
	}

	private notifySessionChanged(): void {
		if (!this.sessionInfo) {
			return;
		}
		const { sessionId, expiresAt } = this.sessionInfo;
		for (const callback of this.sessionChangedCallbacks) {
			try {
				callback(sessionId, expiresAt);
			} catch (err) {
				log.error(`Session changed callback error: ${errorMessage(err)}`);
			}
		}
	}

	private updateExpiry(expiresAt: Date): void {
		if (this.sessionInfo) {
			this.sessionInfo.expiresAt = expiresAt;
		}
	}
}
