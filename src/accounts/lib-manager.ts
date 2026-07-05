import type { CraftingUpdateEvent } from "@setpoint/protocol";
import {
	type ClerkPlayer,
	type GameState,
	type RegisterParams,
	type RegisterResult,
	STATE_SECTIONS,
	type StateSection,
} from "@spacemolt/lib";
import { markStateFresh } from "../dispatcher/state-freshness.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import { type LibConfig, buildOwnedFilter } from "./lib-config.js";
import type { AccountClientLike, LibManagedAccount } from "./lib-types.js";

const log = createLogger("lib-account-mgr");

/** How long a `listOwned()` result is trusted before refreshing from Clerk. Keeps a polling dashboard from hammering Clerk's API on every GET /accounts request. */
const OWNED_LIST_TTL_MS = 60_000;

export interface LibAccountManagerOptions {
	/** Called on every account state change: (playerId, changed sections, the account). Phase 2 wires the SQLite projector here. */
	onStateChange?: (playerId: string, changed: StateSection[], account: LibManagedAccount) => void;
	/**
	 * Called whenever a live `refresh()` reveals fields that changed without a
	 * corresponding push update having already applied them to the cache —
	 * i.e. a gap in the lib's notification coverage. Wired by wrapping
	 * `account.refresh()` once per account in `indexAndWire`, so every
	 * existing and future call site (opportunistic post-mutation refreshes,
	 * the diagnostic sweep in `state/drift-sweep.ts`, etc.) is covered without
	 * changes at the call site.
	 */
	onDrift?: (
		playerId: string,
		before: Readonly<GameState>,
		after: Readonly<GameState>,
		account: LibManagedAccount,
	) => void;
	/**
	 * Called on every `crafting_update` push for an account. Unlike
	 * market/observation, this notification type requires no explicit
	 * subscribe call — the server sends it automatically whenever the account
	 * has jobs in progress — so wiring it here (once per account, in
	 * `indexAndWire`) is sufficient; there's no subscribe-first step for
	 * callers to remember.
	 */
	onCraftingUpdate?: (
		playerId: string,
		event: CraftingUpdateEvent,
		account: LibManagedAccount,
	) => void;
}

/**
 * Owns the lib client and the connected accounts. `connect()` calls
 * `connectOwned` with the configured filter, indexes accounts by player_id and
 * username, and wires each account's state-change stream to the optional hook.
 */
export class LibAccountManager {
	private readonly byPlayerId = new Map<string, LibManagedAccount>();
	private readonly usernameToPlayerId = new Map<string, string>();
	/** Usernames/ids with an in-flight connectOne/register call. */
	private readonly connecting = new Set<string>();
	/** Cached `listOwned()` result and the time it was fetched, for the TTL below. */
	private ownedListCache: { players: ClerkPlayer[]; fetchedAt: number } | undefined;

	constructor(
		private readonly client: AccountClientLike,
		private readonly config: LibConfig,
		private readonly opts: LibAccountManagerOptions = {},
	) {
		// The single place indexAndWire ever runs — covers the initial connect
		// AND every later reconnect (the lib now drives reconnection itself
		// through the same rate-limited connect path used for the initial
		// connect, replacing the LibManagedAccount instance for that id; see
		// AccountClientLike.onAccountConnected). Registered once here, up
		// front, rather than per connect()/connectOne()/register() call, so a
		// reconnect firing long after any of those calls returned still gets
		// re-indexed the same way.
		this.client.onAccountConnected((account) => {
			if (!account.player?.id) {
				log.warn("Connected account has no player_id after connect; skipping index");
				return;
			}
			this.indexAndWire(account);
		});
		this.client.onAccountDisconnected((id, err) => {
			log.warn(
				`[${id}] Account disconnected and will not be reconnected (code=${err.code ?? "?"}): ${err.message}`,
			);
		});
	}

	/**
	 * Index a newly-connected account by player_id and username, wire its
	 * onStateChange stream to the optional hook, and backfill the projector
	 * with the account's current state. Shared by `connect()`, `connectOne()`,
	 * and `register()` so every connection path gets identical treatment.
	 */
	private indexAndWire(account: LibManagedAccount): string {
		const playerId = account.player?.id;
		if (!playerId) {
			throw new Error("Connected account has no player_id after connect");
		}
		this.byPlayerId.set(playerId, account);
		if (typeof account.id === "string") {
			this.usernameToPlayerId.set(account.id.toLowerCase(), playerId);
		}
		const onChange = this.opts.onStateChange;
		if (onChange) {
			account.onStateChange((changed) => {
				markStateFresh(account);
				onChange(playerId, changed, account);
			});
			// Backfill: the lib seeds full state during connect(), before our listener
			// was attached (onStateChange has no replay). Fire once with the current
			// state so the projection reflects freshly-connected accounts. The projector
			// filters undefined sections and applyUpdate skips null/undefined, so passing
			// the full section list is safe and idempotent.
			onChange(playerId, [...STATE_SECTIONS], account);
		}
		const onDrift = this.opts.onDrift;
		if (onDrift) {
			const originalRefresh = account.refresh.bind(account);
			// Wraps the single instance every caller (dispatcher, server handlers,
			// the drift sweep) already shares via byPlayerId/usernameToPlayerId — an
			// own-property override shadows the lib's prototype method, so no call
			// site needs to change.
			(account as { refresh: LibManagedAccount["refresh"] }).refresh = async () => {
				const before = account.state;
				const after = await originalRefresh();
				onDrift(playerId, before, after, account);
				return after;
			};
		}
		const onCraftingUpdate = this.opts.onCraftingUpdate;
		if (onCraftingUpdate) {
			// Wrapped in try/catch so a throwing handler (e.g. an SSE consumer's
			// controller.enqueue() failing) can never escape back into the lib's
			// TypedEmitter.emit() call stack — that emit loop has no isolation of
			// its own between listeners, and a frame-routing call with no
			// try/catch above it must never see an exception from application code.
			account.on("crafting_update", (event) => {
				try {
					onCraftingUpdate(playerId, event, account);
				} catch (err) {
					log.error(`[${playerId}] onCraftingUpdate handler threw: ${errorMessage(err)}`);
				}
			});
		}
		// The lib seeds state during connect() without firing onStateChange (no
		// replay), so mark freshness explicitly here — otherwise a freshly-connected
		// account would read as stale immediately.
		markStateFresh(account);
		return playerId;
	}

	async connect(): Promise<void> {
		const filter = buildOwnedFilter(this.config.filter);
		// Indexing happens via the onAccountConnected listener registered in
		// the constructor, not an onConnect param here — the same listener
		// also covers every later reconnect, so there's one path, not two.
		await this.client.connectOwned({ filter });
		log.info(`Connected ${this.byPlayerId.size} account(s)`);
	}

	/**
	 * Connect a single stored account by store-key/username. Indexing happens
	 * via the onAccountConnected listener registered in the constructor,
	 * which — unlike this method — treats a missing player_id as a
	 * skip-and-warn (appropriate for a fleet-wide connect where one bad
	 * account shouldn't fail the rest). A single, explicit connectOne() call
	 * should surface that failure to its caller instead of silently
	 * succeeding with nothing indexed.
	 */
	async connectOne(idOrUsername: string): Promise<LibManagedAccount> {
		this.connecting.add(idOrUsername.toLowerCase());
		try {
			const account = await this.client.connect(idOrUsername);
			if (!account.player?.id) {
				throw new Error("Connected account has no player_id after connect");
			}
			return account;
		} finally {
			this.connecting.delete(idOrUsername.toLowerCase());
		}
	}

	/** Register a brand-new account. Indexing happens via the onAccountConnected listener registered in the constructor — see connectOne() for why this still checks player_id itself. */
	async register(
		params: RegisterParams,
	): Promise<{ account: LibManagedAccount; result: RegisterResult }> {
		this.connecting.add(params.username.toLowerCase());
		try {
			const { account, result } = await this.client.register(params);
			if (!account.player?.id) {
				throw new Error("Connected account has no player_id after connect");
			}
			return { account, result };
		} finally {
			this.connecting.delete(params.username.toLowerCase());
		}
	}

	/**
	 * List the player accounts the Clerk user owns (connected or not). Cached for
	 * `OWNED_LIST_TTL_MS` so a polling dashboard doesn't trigger a Clerk network
	 * call on every request. If a refresh fails and a stale cached value exists,
	 * that value is returned instead of throwing — the `GET /accounts` handler
	 * already degrades to connected-only accounts on error, so a stale-but-known
	 * owned list is strictly better than dropping to nothing.
	 */
	async listOwned(): Promise<ClerkPlayer[]> {
		const cache = this.ownedListCache;
		if (cache && Date.now() - cache.fetchedAt < OWNED_LIST_TTL_MS) {
			return cache.players;
		}
		try {
			const players = await this.client.listOwnedPlayers();
			this.ownedListCache = { players, fetchedAt: Date.now() };
			return players;
		} catch (err) {
			if (cache) {
				return cache.players;
			}
			throw err;
		}
	}

	/** Whether a connectOne/register call for this id/username is currently in flight. */
	isConnecting(idOrUsername: string): boolean {
		return this.connecting.has(idOrUsername.toLowerCase());
	}

	/** Look up the player_id for a username (case-insensitive). */
	private playerIdForUsername(username: string): string | undefined {
		return this.usernameToPlayerId.get(username.toLowerCase());
	}

	getByPlayerId(playerId: string): LibManagedAccount | undefined {
		return this.byPlayerId.get(playerId);
	}

	getByUsername(username: string): LibManagedAccount | undefined {
		const pid = this.playerIdForUsername(username);
		return pid ? this.byPlayerId.get(pid) : undefined;
	}

	getAll(): LibManagedAccount[] {
		return [...this.byPlayerId.values()];
	}

	get size(): number {
		return this.byPlayerId.size;
	}

	async disconnect(playerId: string): Promise<void> {
		const account = this.byPlayerId.get(playerId);
		if (!account) {
			return;
		}
		// Evict from the lib client registry too (closes + drops), so the manager
		// and the client can't diverge into a stale-closed-account leak. Fall back
		// to a direct close if the account has no id.
		if (typeof account.id === "string") {
			await this.client.remove(account.id);
		} else {
			account.close();
		}
		this.byPlayerId.delete(playerId);
		for (const [username, pid] of this.usernameToPlayerId) {
			if (pid === playerId) {
				this.usernameToPlayerId.delete(username);
			}
		}
	}

	/** Alias for `disconnect()` — removes an account (evicts from the lib client, clears both indexes). */
	async remove(playerId: string): Promise<void> {
		await this.disconnect(playerId);
	}

	disconnectAll(): void {
		this.client.closeAll();
		this.byPlayerId.clear();
		this.usernameToPlayerId.clear();
	}
}
