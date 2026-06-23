import type { SpaceMoltClient } from "../api/client.js";
import { GameEndpoints } from "../api/endpoints.js";
import { Session } from "../api/session.js";
import type { AccountCredentials, AuthSlot } from "../api/session.js";
import type { StateStore } from "../state/store.js";
import type { StateUpdater } from "../state/updater.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { type AccountConfig, saveAccountConfig } from "./config.js";

/**
 * Serialises recovery connect() calls across all managed sessions so that
 * concurrent account reconnects (e.g. after a server restart) are spaced at
 * least minIntervalMs apart, staying within the 10 auth/min rate limit.
 */
class AuthRateLimiter implements AuthSlot {
	private lastGrantedAt = 0;
	private readonly queue: Array<() => void> = [];
	private processing = false;

	constructor(private readonly minIntervalMs: number) {}

	acquire(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.queue.push(resolve);
			if (!this.processing) {
				void this.process();
			}
		});
	}

	private async process(): Promise<void> {
		this.processing = true;
		while (this.queue.length > 0) {
			const now = Date.now();
			const wait = this.lastGrantedAt + this.minIntervalMs - now;
			if (wait > 0) {
				await new Promise<void>((r) => setTimeout(r, wait));
			}
			this.lastGrantedAt = Date.now();
			this.queue.shift()?.();
		}
		this.processing = false;
	}
}

const log = createLogger("account-mgr");

/** Per-account runtime state. */
export interface ManagedAccount {
	config: AccountConfig;
	session: Session;
	endpoints: GameEndpoints;
}

export type PendingAccountStatus = "pending" | "connecting" | "connected" | "failed";

/** An account that has been queued for connection but may not be connected yet. */
export interface PendingAccount {
	username: string;
	credentials: AccountCredentials;
	/** Full config if player_id was provided upfront. */
	config?: AccountConfig;
	status: PendingAccountStatus;
	/** Error message when status is "failed". */
	error?: string;
	/** ISO timestamp when the account was queued. */
	queuedAt: string;
	/** Known upfront for full-config, discovered after login for credentials-only. */
	playerId?: string;
}

export interface AccountManagerOptions {
	/**
	 * Delay between session creations (ms).
	 * With 10 auth/min rate limit, minimum safe interval is 6000ms.
	 * Defaults to 6500ms for safety margin.
	 */
	staggerDelayMs?: number;
	/** Keepalive interval per session (ms). Defaults to 10 minutes. */
	keepaliveIntervalMs?: number;
	/** State updater to wire into sessions for automatic state tracking. */
	stateUpdater?: StateUpdater;
	/** State store for persisting and resuming sessions across restarts. */
	stateStore?: StateStore;
	/** Config directory for saving account configs after successful connection. */
	configDir?: string;
	/**
	 * Called when an account connects via the queue (queueAccount / queueByCredentials).
	 * Not called for accounts connected via connectAll() — callers handle bulk resumption
	 * after connectAll returns.
	 */
	onAccountConnected?: (playerId: string) => void;
}

const DEFAULT_STAGGER_DELAY_MS = 6500;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Manages the lifecycle of multiple SpaceMolt accounts.
 *
 * Handles staggered session creation to stay within rate limits,
 * tracks per-account sessions and endpoints, and provides access
 * to individual accounts by username or player ID.
 */
export class AccountManager {
	private readonly client: SpaceMoltClient;
	private readonly accounts: Map<string, ManagedAccount> = new Map();
	private readonly pendingQueue: Map<string, PendingAccount> = new Map();
	private processingQueue = false;
	private readonly staggerDelayMs: number;
	private readonly keepaliveIntervalMs: number;
	private readonly stateUpdater: StateUpdater | undefined;
	private readonly stateStore: StateStore | undefined;
	private readonly configDir: string | undefined;
	private onAccountConnectedCb: ((playerId: string) => void) | undefined;
	/** Shared rate limiter passed to every session to stagger recovery reconnects. */
	private readonly authRateLimiter: AuthRateLimiter;

	constructor(client: SpaceMoltClient, options: AccountManagerOptions = {}) {
		this.client = client;
		this.staggerDelayMs = options.staggerDelayMs ?? DEFAULT_STAGGER_DELAY_MS;
		this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
		this.stateUpdater = options.stateUpdater;
		this.stateStore = options.stateStore;
		this.configDir = options.configDir;
		this.onAccountConnectedCb = options.onAccountConnected;
		this.authRateLimiter = new AuthRateLimiter(this.staggerDelayMs);
	}

	/**
	 * Register a callback to be called whenever an account connects via the queue.
	 * Can be set after construction, so that callers can wire this up after
	 * creating the infrastructure that needs to react to connections.
	 */
	setOnAccountConnected(cb: (playerId: string) => void): void {
		this.onAccountConnectedCb = cb;
	}

	/** Number of managed accounts. */
	get size(): number {
		return this.accounts.size;
	}

	/** Get a managed account by username (case-insensitive). */
	getByUsername(username: string): ManagedAccount | undefined {
		const lower = username.toLowerCase();
		for (const account of this.accounts.values()) {
			if (account.config.username.toLowerCase() === lower) {
				return account;
			}
		}
		return undefined;
	}

	/** Get a managed account by player ID. */
	getByPlayerId(playerId: string): ManagedAccount | undefined {
		return this.accounts.get(playerId);
	}

	/** Get all managed accounts. */
	getAll(): ManagedAccount[] {
		return [...this.accounts.values()];
	}

	// ── Queue Methods ──────────────────────────────────────────────

	/**
	 * Queue an account with full config (username + password + player_id).
	 * Returns immediately; connection happens in the background.
	 */
	queueAccount(config: AccountConfig): PendingAccount {
		const key = config.username.toLowerCase();

		if (this.accounts.has(config.player_id)) {
			throw new Error("Account already connected");
		}
		if (this.pendingQueue.has(key)) {
			throw new Error("Account already queued");
		}

		const pending: PendingAccount = {
			username: config.username,
			credentials: { username: config.username, password: config.password },
			config,
			status: "pending",
			queuedAt: new Date().toISOString(),
			playerId: config.player_id,
		};

		this.pendingQueue.set(key, pending);
		log.info(`Queued account: ${config.username} (player_id: ${config.player_id})`);

		void this.processQueue();
		return pending;
	}

	/**
	 * Queue an account with just username + password (player_id discovered on login).
	 * Returns immediately; connection happens in the background.
	 */
	queueByCredentials(credentials: AccountCredentials): PendingAccount {
		const key = credentials.username.toLowerCase();

		if (this.getByUsername(credentials.username)) {
			throw new Error("Account already connected");
		}
		if (this.pendingQueue.has(key)) {
			throw new Error("Account already queued");
		}

		const pending: PendingAccount = {
			username: credentials.username,
			credentials,
			status: "pending",
			queuedAt: new Date().toISOString(),
		};

		this.pendingQueue.set(key, pending);
		log.info(`Queued account: ${credentials.username} (credentials only)`);

		void this.processQueue();
		return pending;
	}

	/** Get a pending account by username (case-insensitive). */
	getPending(username: string): PendingAccount | undefined {
		return this.pendingQueue.get(username.toLowerCase());
	}

	/** Get a pending account by player ID. */
	getPendingByPlayerId(playerId: string): PendingAccount | undefined {
		for (const pending of this.pendingQueue.values()) {
			if (pending.playerId === playerId) {
				return pending;
			}
		}
		return undefined;
	}

	/** Get all pending accounts. */
	getAllPending(): PendingAccount[] {
		return [...this.pendingQueue.values()];
	}

	/** Remove a pending or failed account from the queue. Returns true if removed. */
	removePending(username: string): boolean {
		return this.pendingQueue.delete(username.toLowerCase());
	}

	// ── Queue Processor ────────────────────────────────────────────

	private async processQueue(): Promise<void> {
		if (this.processingQueue) {
			return;
		}
		this.processingQueue = true;

		try {
			while (true) {
				const next = this.findNextPending();
				if (!next) {
					break;
				}

				next.status = "connecting";
				log.info(`Connecting queued account: ${next.username}`);

				try {
					let account: ManagedAccount;
					if (next.config) {
						({ account } = await this.connectAccountInternal(next.config));
					} else {
						account = await this.connectByCredentials(next.credentials);
					}

					next.status = "connected";
					next.playerId = account.config.player_id;
					this.pendingQueue.delete(next.username.toLowerCase());

					if (this.onAccountConnectedCb) {
						this.onAccountConnectedCb(account.config.player_id);
					}

					// Save config to disk
					if (this.configDir) {
						try {
							await saveAccountConfig(account.config, this.configDir);
						} catch (err) {
							log.warn(`Account connected but config save failed: ${errorMessage(err)}`);
						}
					}
				} catch (err) {
					const message = errorMessage(err);
					next.status = "failed";
					next.error = message;
					log.error(`Failed to connect ${next.username}: ${message}`);
				}

				// Stagger before next connection
				await this.delay(this.staggerDelayMs);
			}
		} finally {
			this.processingQueue = false;
		}
	}

	private findNextPending(): PendingAccount | undefined {
		for (const pending of this.pendingQueue.values()) {
			if (pending.status === "pending") {
				return pending;
			}
		}
		return undefined;
	}

	// ── Direct Connection Methods ──────────────────────────────────

	/**
	 * Connect all accounts with staggered session creation.
	 *
	 * Creates sessions sequentially with a delay between each to respect
	 * the 20 sessions/min and 10 auth/min rate limits. Each session
	 * requires 1 session creation + 1 auth call = 2 rate-limited operations.
	 *
	 * Skips the stagger delay for accounts that have a valid stored session,
	 * since resuming uses only a query (not auth) and doesn't hit rate limits.
	 *
	 * Returns the list of accounts that connected successfully.
	 * Failed accounts are logged but do not stop other accounts from connecting.
	 */
	async connectAll(accountConfigs: AccountConfig[]): Promise<ManagedAccount[]> {
		const connected: ManagedAccount[] = [];
		const RESUME_MARGIN_MS = 2 * 60 * 1000;

		for (let i = 0; i < accountConfigs.length; i++) {
			const config = accountConfigs[i];
			if (!config) {
				continue;
			}

			// Skip stagger if this account likely has a valid stored session to resume
			const stored = this.stateStore?.getSessionInfo(config.player_id);
			const likelyResume =
				stored != null && stored.expiresAt > new Date(Date.now() + RESUME_MARGIN_MS);

			if (i > 0 && !likelyResume) {
				log.info(`Waiting ${this.staggerDelayMs}ms before connecting ${config.username}...`);
				await this.delay(this.staggerDelayMs);
			}

			try {
				const { account } = await this.connectAccountInternal(config);
				connected.push(account);
			} catch (err) {
				log.error(`Failed to connect ${config.username}: ${errorMessage(err)}`);
			}
		}

		log.info(`Connected ${connected.length}/${accountConfigs.length} accounts`);
		return connected;
	}

	/** Connect a single account. */
	async connectAccount(config: AccountConfig): Promise<ManagedAccount> {
		const { account } = await this.connectAccountInternal(config);
		return account;
	}

	/**
	 * Core connection logic: tries to resume a persisted session first,
	 * falls back to full createSession + login if resume fails or no session stored.
	 */
	private async connectAccountInternal(
		config: AccountConfig,
	): Promise<{ account: ManagedAccount; wasResumed: boolean }> {
		const credentials: AccountCredentials = {
			username: config.username,
			password: config.password,
		};

		const session = new Session(this.client, credentials, {
			keepaliveIntervalMs: this.keepaliveIntervalMs,
			authSlot: this.authRateLimiter,
		});

		// Wire response callback for automatic state tracking
		if (this.stateUpdater) {
			const updater = this.stateUpdater;
			session.onResponse((structuredContent) => {
				updater.processResponse(config.player_id, structuredContent);
			});
		}

		// Wire session-changed callback to persist session info
		if (this.stateStore) {
			const store = this.stateStore;
			session.onSessionChanged((sid, exp) => {
				store.setSessionInfo(config.player_id, sid, exp);
			});
		}

		// Attempt to resume stored session
		const RESUME_MARGIN_MS = 2 * 60 * 1000;
		const stored = this.stateStore?.getSessionInfo(config.player_id);
		let wasResumed = false;
		if (stored && stored.expiresAt > new Date(Date.now() + RESUME_MARGIN_MS)) {
			wasResumed = await session.tryResume(stored.sessionId, stored.expiresAt);
		}

		if (!wasResumed) {
			// Pace the login through the shared auth limiter. connectAll() skips its
			// own stagger when a stored session looks resumable, but if that resume
			// fails (e.g. the server dropped sessions during downtime) the fallback
			// login still needs pacing — otherwise a whole fleet re-logs in at once
			// and trips the auth rate limit / IP block. The limiter's interval equals
			// connectAll's stagger, so this adds no delay on the cold-start path where
			// the stagger already spaced this call.
			await this.authRateLimiter.acquire();
			log.info(`Connecting account: ${config.username}`);
			const loginResponse = await session.connect();

			// Process login response into state store
			if (this.stateUpdater) {
				this.stateUpdater.processLoginResponse(config.player_id, loginResponse);
			}
		}

		const endpoints = new GameEndpoints(session);
		const account: ManagedAccount = { config, session, endpoints };

		this.accounts.set(config.player_id, account);

		return { account, wasResumed };
	}

	/**
	 * Connect an account using only username + password.
	 * Logs in to discover the player_id, then wires up state tracking.
	 * Returns the managed account with the full config (including player_id).
	 */
	async connectByCredentials(credentials: AccountCredentials): Promise<ManagedAccount> {
		const session = new Session(this.client, credentials, {
			keepaliveIntervalMs: this.keepaliveIntervalMs,
			authSlot: this.authRateLimiter,
		});

		log.info(`Connecting account by credentials: ${credentials.username}`);
		const loginResponse = await session.connect();

		const playerId = session.info?.playerId;
		if (!playerId) {
			session.disconnect();
			throw new Error(`Login succeeded but no player_id returned for ${credentials.username}`);
		}

		// Check for duplicate after discovering player_id
		if (this.accounts.has(playerId)) {
			session.disconnect();
			throw new Error(`Account with player_id ${playerId} is already connected`);
		}

		const config: AccountConfig = {
			username: credentials.username,
			password: credentials.password,
			player_id: playerId,
		};

		// Wire response callback for automatic state tracking
		if (this.stateUpdater) {
			const updater = this.stateUpdater;
			session.onResponse((structuredContent) => {
				updater.processResponse(playerId, structuredContent);
			});
			updater.processLoginResponse(playerId, loginResponse);
		}

		// Wire session-changed callback to persist session info
		if (this.stateStore) {
			const store = this.stateStore;
			session.onSessionChanged((sid, exp) => {
				store.setSessionInfo(playerId, sid, exp);
			});
		}

		const endpoints = new GameEndpoints(session);
		const account: ManagedAccount = { config, session, endpoints };

		this.accounts.set(playerId, account);

		return account;
	}

	/** Disconnect a specific account by player ID. */
	disconnectAccount(playerId: string): void {
		const account = this.accounts.get(playerId);
		if (account) {
			account.session.disconnect();
			this.accounts.delete(playerId);
			log.info(`Disconnected account: ${account.config.username}`);
		}
	}

	/** Disconnect all accounts and clear the pending queue. */
	disconnectAll(): void {
		for (const account of this.accounts.values()) {
			account.session.disconnect();
		}
		const count = this.accounts.size;
		this.accounts.clear();
		this.pendingQueue.clear();
		log.info(`Disconnected all ${count} accounts`);
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}
}
