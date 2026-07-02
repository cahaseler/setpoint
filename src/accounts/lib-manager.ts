import { createLogger } from "../util/logger.js";
import { type LibConfig, buildOwnedFilter } from "./lib-config.js";
import type { AccountClientLike, LibAccountLike } from "./lib-types.js";

const log = createLogger("lib-account-mgr");

export interface LibAccountManagerOptions {
	/** Called on every account state change, keyed by player_id. Phase 2 wires the SQLite projector here. */
	onStateChange?: (playerId: string, changed: string[]) => void;
}

/**
 * Owns the lib client and the connected accounts. `connect()` calls
 * `connectOwned` with the configured filter, indexes accounts by player_id and
 * username, and wires each account's state-change stream to the optional hook.
 */
export class LibAccountManager {
	private readonly byPlayerId = new Map<string, LibAccountLike>();
	private readonly usernameToPlayerId = new Map<string, string>();

	constructor(
		private readonly client: AccountClientLike,
		private readonly config: LibConfig,
		private readonly opts: LibAccountManagerOptions = {},
	) {}

	async connect(): Promise<void> {
		const filter = buildOwnedFilter(this.config.filter);
		const accounts = await this.client.connectOwned({ filter });
		for (const account of accounts) {
			const playerId = account.player?.id;
			if (!playerId) {
				log.warn("Connected account has no player_id after connect; skipping index");
				continue;
			}
			this.byPlayerId.set(playerId, account);
			if (typeof account.username === "string") {
				this.usernameToPlayerId.set(account.username.toLowerCase(), playerId);
			}
			const onChange = this.opts.onStateChange;
			if (onChange) {
				account.onStateChange((changed) => onChange(playerId, changed));
			}
		}
		log.info(`Connected ${this.byPlayerId.size} account(s)`);
	}

	/** Index username→player_id lazily so callers can look up either way. */
	private playerIdForUsername(username: string): string | undefined {
		const lower = username.toLowerCase();
		const cached = this.usernameToPlayerId.get(lower);
		if (cached) {
			return cached;
		}
		return undefined;
	}

	getByPlayerId(playerId: string): LibAccountLike | undefined {
		return this.byPlayerId.get(playerId);
	}

	getByUsername(username: string): LibAccountLike | undefined {
		const pid = this.playerIdForUsername(username);
		return pid ? this.byPlayerId.get(pid) : undefined;
	}

	getAll(): LibAccountLike[] {
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
		account.close();
		this.byPlayerId.delete(playerId);
		for (const [username, pid] of this.usernameToPlayerId) {
			if (pid === playerId) {
				this.usernameToPlayerId.delete(username);
			}
		}
	}

	disconnectAll(): void {
		this.client.closeAll();
		this.byPlayerId.clear();
		this.usernameToPlayerId.clear();
	}
}
