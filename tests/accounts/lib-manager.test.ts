import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	type Account,
	type ClerkPlayer,
	ConnectionClosedError,
	type GameState,
} from "@spacemolt/lib";
import { LibAccountManager } from "../../src/accounts/lib-manager.js";
import type { AccountClientLike, LibManagedAccount } from "../../src/accounts/lib-types.js";
import { STATE_FRESHNESS_TTL_MS, isStateStale } from "../../src/dispatcher/state-freshness.js";
import { FakeAccount, FakeClient } from "./fakes.js";

/**
 * Compile-time-only proof that the real lib `Account` structurally satisfies
 * `LibManagedAccount`. Never called; exists so a future `@spacemolt/lib` bump
 * that narrows `Account` fails typecheck here instead of silently drifting.
 */
function _accountSatisfiesLibManagedAccount(account: Account): LibManagedAccount {
	return account;
}
void _accountSatisfiesLibManagedAccount;

const player = (username: string, id: string, over: Partial<ClerkPlayer> = {}): ClerkPlayer => ({
	id,
	username,
	empire: "solarian",
	hidden: false,
	...over,
});

function setup(players: ClerkPlayer[]): { client: FakeClient; accounts: Map<string, FakeAccount> } {
	const accounts = new Map<string, FakeAccount>();
	for (const p of players) {
		accounts.set(p.username, new FakeAccount(p.id, p.username));
	}
	return { client: new FakeClient(players, accounts), accounts };
}

describe("LibAccountManager", () => {
	test("connect() connects owned players and indexes by player_id and username", async () => {
		const { client } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();

		expect(mgr.size).toBe(2);
		expect(mgr.getByPlayerId("pid-a")).toBeDefined();
		expect(mgr.getByUsername("beta")).toBeDefined(); // case-insensitive
		expect(mgr.getByUsername("Beta")).toBe(mgr.getByPlayerId("pid-b"));
	});

	test("connect() passes the config filter to connectOwned", async () => {
		const { client } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		const mgr = new LibAccountManager(client, {
			clerkApiKey: "k",
			filter: { usernames: ["Alpha"] },
		});
		await mgr.connect();

		expect(mgr.size).toBe(1);
		expect(mgr.getByUsername("alpha")).toBeDefined();
		expect(mgr.getByUsername("beta")).toBeUndefined();
		expect(client.lastFilter).toBeDefined();
	});

	test("connect() indexes each account as it connects, not after the whole batch resolves", async () => {
		const { accounts } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		let resolveBeta: () => void = () => {};
		const betaGate = new Promise<void>((resolve) => {
			resolveBeta = resolve;
		});
		const connectedListeners = new Set<(account: LibManagedAccount) => void>();
		const client: AccountClientLike = {
			connectOwned: async (opts) => {
				const alpha = accounts.get("Alpha") as unknown as LibManagedAccount;
				const beta = accounts.get("Beta") as unknown as LibManagedAccount;
				opts.onConnect?.(alpha);
				for (const listener of connectedListeners) listener(alpha);
				await betaGate;
				opts.onConnect?.(beta);
				for (const listener of connectedListeners) listener(beta);
				return [alpha, beta];
			},
			connect: () => Promise.reject(new Error("not used by this test")),
			register: () => Promise.reject(new Error("not used by this test")),
			listOwnedPlayers: () => Promise.resolve([]),
			accounts: () => [],
			account: () => undefined,
			remove: () => Promise.resolve(),
			closeAll: () => {},
			onAccountConnected: (listener) => {
				connectedListeners.add(listener);
				return () => connectedListeners.delete(listener);
			},
			onAccountDisconnected: () => () => {},
		};
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		const connectPromise = mgr.connect();

		// Give the onConnect microtask for Alpha a chance to run while Beta is
		// still gated — this is the "single connection shouldn't wait on the
		// whole fleet" behavior connectOwned's onConnect callback exists for.
		await Promise.resolve();
		expect(mgr.getByPlayerId("pid-a")).toBeDefined();
		expect(mgr.getByPlayerId("pid-b")).toBeUndefined();

		resolveBeta();
		await connectPromise;
		expect(mgr.getByPlayerId("pid-b")).toBeDefined();
	});

	test("connect(onAccountReady) fires once per account, after that account is already indexed", async () => {
		const { client } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		const seenAlreadyIndexed: boolean[] = [];
		const readyIds: string[] = [];

		await mgr.connect((account) => {
			readyIds.push(account.player?.id ?? "?");
			seenAlreadyIndexed.push(mgr.getByPlayerId(account.player?.id ?? "") === account);
		});

		expect(readyIds.sort()).toEqual(["pid-a", "pid-b"]);
		expect(seenAlreadyIndexed).toEqual([true, true]);
	});

	test("wires onStateChange per account, passing playerId and the account", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		const events: Array<{ playerId: string; changed: string[]; accountId: string | undefined }> =
			[];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onStateChange: (playerId, changed, account) =>
					events.push({ playerId, changed, accountId: account.id }),
			},
		);
		await mgr.connect();

		// connect() also fires onChange once per account as a state backfill
		// (see tests/state/attach-projector.test.ts); clear those before
		// asserting on the emit this test cares about.
		events.length = 0;
		accounts.get("Beta")?.emitStateChange(["location", "ship"]);
		expect(events).toEqual([
			{ playerId: "pid-b", changed: ["location", "ship"], accountId: "Beta" },
		]);
	});

	test("a throwing onStateChange handler is caught and logged, not left to escape into the lib", async () => {
		// Regression: an onStateChange consumer failure (e.g. the SQLite projector)
		// must never propagate back into the lib's frame routing — it should be
		// caught and logged here so it's visible in daemon.log, and so subsequent
		// state changes for the same account keep being delivered normally.
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const seen: string[][] = [];
		let calls = 0;
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onStateChange: (_playerId, changed) => {
					calls++;
					if (calls === 1) throw new Error("simulated: projector failed");
					seen.push(changed);
				},
			},
		);
		await expect(mgr.connect()).resolves.toBeUndefined();
		accounts.get("Alpha")?.emitStateChange(["location"]);
		expect(seen).toEqual([["location"]]);
	});

	test("wires onDrift, passing the pre- and post-refresh state plus the account", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const account = accounts.get("Alpha") as unknown as FakeAccount & {
			refresh: () => Promise<GameState>;
		};
		// Override BEFORE connect(): indexAndWire binds the original refresh at
		// connect time, so an override afterward would never be called.
		account.refresh = () => {
			account.emitStateChange([], { player: { credits: 500 } } as unknown as GameState);
			return Promise.resolve(account.state);
		};

		const drifts: Array<{
			playerId: string;
			before: GameState;
			after: GameState;
			accountId: string | undefined;
		}> = [];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onDrift: (playerId, before, after, drAccount) =>
					drifts.push({ playerId, before, after, accountId: drAccount.id }),
			},
		);
		await mgr.connect();

		await mgr.getByPlayerId("pid-a")?.refresh();

		expect(drifts).toEqual([
			{
				playerId: "pid-a",
				before: {},
				after: { player: { credits: 500 } },
				accountId: "Alpha",
			},
		]);
	});

	test("calls onDrift even when refresh() returns unchanged state — diffing is the caller's job", async () => {
		const { client } = setup([player("Alpha", "pid-a")]);
		const drifts: unknown[] = [];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{ onDrift: (playerId, before, after) => drifts.push({ playerId, before, after }) },
		);
		await mgr.connect();

		await mgr.getByPlayerId("pid-a")?.refresh();

		expect(drifts).toHaveLength(1);
	});

	test("wires onCraftingUpdate, passing playerId, the event, and the account", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const updates: Array<{ playerId: string; runsDone: number; accountId: string | undefined }> =
			[];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onCraftingUpdate: (playerId, event, account) =>
					updates.push({
						playerId,
						runsDone: (event as { jobs: Array<{ runs_done: number }> }).jobs[0]?.runs_done ?? -1,
						accountId: account.id,
					}),
			},
		);
		await mgr.connect();

		accounts.get("Alpha")?.emitNotification("crafting_update", {
			tick: 100,
			jobs: [
				{
					job_id: "job-1",
					completed: false,
					deposited: [],
					mode: "craft",
					recipe: "widget",
					runs_done: 2,
					runs_remaining: 3,
					storage: "personal",
					venue: "workshop",
				},
			],
		});

		expect(updates).toEqual([{ playerId: "pid-a", runsDone: 2, accountId: "Alpha" }]);
	});

	test("a throwing onCraftingUpdate handler is caught and logged, not left to escape into the lib", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onCraftingUpdate: () => {
					throw new Error("controller already closed");
				},
			},
		);
		await mgr.connect();

		expect(() =>
			accounts.get("Alpha")?.emitNotification("crafting_update", {
				tick: 100,
				jobs: [
					{
						job_id: "job-1",
						completed: false,
						deposited: [],
						mode: "craft",
						recipe: "widget",
						runs_done: 2,
						runs_remaining: 3,
						storage: "personal",
						venue: "workshop",
					},
				],
			}),
		).not.toThrow();
	});

	test("wires onCombatUpdate for every combat notification type, passing playerId, type, payload, and the account", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const updates: Array<{ playerId: string; type: string; accountId: string | undefined }> = [];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onCombatUpdate: (playerId, type, _payload, account) =>
					updates.push({ playerId, type, accountId: account.id }),
			},
		);
		await mgr.connect();

		const account = accounts.get("Alpha");
		account?.emitNotification("battle_alert", { battle_id: "b1" });
		account?.emitNotification("battle_started", { battle_id: "b1" });
		account?.emitNotification("battle_joined", { player_id: "pid-a" });
		account?.emitNotification("battle_update", { battle_id: "b1" });
		account?.emitNotification("battle_damage", { attacker_id: "pid-a" });
		account?.emitNotification("battle_ended", { battle_id: "b1" });
		account?.emitNotification("battle_left", { player_id: "pid-a" });
		account?.emitNotification("player_died", { clone_cost: 100 });
		account?.emitNotification("player_kill", { victim: "someone" });

		expect(updates.map((u) => u.type)).toEqual([
			"battle_alert",
			"battle_started",
			"battle_joined",
			"battle_update",
			"battle_damage",
			"battle_ended",
			"battle_left",
			"player_died",
			"player_kill",
		]);
		expect(updates.every((u) => u.playerId === "pid-a" && u.accountId === "Alpha")).toBe(true);
	});

	test("a throwing onCombatUpdate handler is caught and logged, not left to escape into the lib", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onCombatUpdate: () => {
					throw new Error("controller already closed");
				},
			},
		);
		await mgr.connect();

		expect(() =>
			accounts.get("Alpha")?.emitNotification("battle_started", { battle_id: "b1" }),
		).not.toThrow();
	});

	test("connect() skips accounts with no player_id", async () => {
		const players = [player("Ghost", "")]; // FakeAccount(playerId="") -> player.id === "" is falsy
		const accounts = new Map<string, FakeAccount>();
		accounts.set("Ghost", new FakeAccount("", "Ghost"));
		const client = new FakeClient(players, accounts);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();
		expect(mgr.size).toBe(0);
		expect(mgr.getByUsername("ghost")).toBeUndefined();
	});

	test("disconnect(playerId) closes and removes the account", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();

		await mgr.disconnect("pid-a");
		expect(mgr.size).toBe(0);
		expect(mgr.getByPlayerId("pid-a")).toBeUndefined();
		expect(mgr.getByUsername("alpha")).toBeUndefined();
		expect(accounts.get("Alpha")?.closed).toBe(true);
	});

	test("disconnect(playerId) evicts from the lib client and clears indexes", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();
		await mgr.disconnect("pid-a");
		expect(mgr.size).toBe(0);
		expect(mgr.getByPlayerId("pid-a")).toBeUndefined();
		expect(mgr.getByUsername("alpha")).toBeUndefined();
		expect(accounts.get("Alpha")?.closed).toBe(true);
		expect(client.account("Alpha")).toBeUndefined(); // removed from the client registry
	});

	test("disconnectAll closes every account", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();

		mgr.disconnectAll();
		expect(mgr.size).toBe(0);
		expect(accounts.get("Alpha")?.closed).toBe(true);
		expect(accounts.get("Beta")?.closed).toBe(true);
	});

	test("a reconnect replaces the indexed account with the new instance", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();

		const original = mgr.getByPlayerId("pid-a");
		expect(original).toBe(accounts.get("Alpha"));

		const reconnected = new FakeAccount("pid-a", "Alpha");
		client.simulateReconnect("Alpha", reconnected);

		expect(mgr.getByPlayerId("pid-a")).toBe(reconnected);
		expect(mgr.getByPlayerId("pid-a")).not.toBe(original);
		expect(mgr.getByUsername("alpha")).toBe(reconnected);
	});

	test("a reconnect re-wires onStateChange on the new instance", async () => {
		const { client } = setup([player("Alpha", "pid-a")]);
		const stateChanges: string[][] = [];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{ onStateChange: (_playerId, changed) => stateChanges.push(changed) },
		);
		await mgr.connect();
		stateChanges.length = 0; // clear the connect-time backfill call

		const reconnected = new FakeAccount("pid-a", "Alpha");
		client.simulateReconnect("Alpha", reconnected);
		stateChanges.length = 0; // clear the reconnect's own backfill call

		reconnected.emitStateChange(["ship"]);
		expect(stateChanges).toEqual([["ship"]]);
	});

	test("onAccountDisconnected is logged and does not throw", async () => {
		const { client } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();

		expect(() => {
			client.simulateDisconnected("Alpha", new ConnectionClosedError("session replaced", 4001));
		}).not.toThrow();
	});

	test("a terminal onAccountDisconnected purges the dead account from both indexes", async () => {
		const { client } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();

		expect(mgr.getByPlayerId("pid-a")).toBeDefined();
		expect(mgr.getByUsername("alpha")).toBeDefined();

		client.simulateDisconnected("Alpha", new ConnectionClosedError("session replaced", 4001));

		// The dead account must resolve as "not found", not as a stale, permanently
		// closed-socket instance — otherwise every later lookup (goal execution,
		// loop start) would keep sending on a socket that will never reconnect.
		expect(mgr.getByPlayerId("pid-a")).toBeUndefined();
		expect(mgr.getByUsername("alpha")).toBeUndefined();
		// Beta, untouched by the disconnect, must still resolve normally.
		expect(mgr.getByPlayerId("pid-b")).toBeDefined();
		expect(mgr.getByUsername("beta")).toBeDefined();
	});

	test("connectOne() indexes the account and backfills the projector", async () => {
		const { client } = setup([player("Alpha", "pid-a")]);
		const events: Array<{ playerId: string; changed: string[] }> = [];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{ onStateChange: (playerId, changed) => events.push({ playerId, changed }) },
		);

		const account = await mgr.connectOne("Alpha");

		expect(account.id).toBe("Alpha");
		expect(mgr.getByPlayerId("pid-a")).toBe(account);
		expect(mgr.getByUsername("alpha")).toBe(account);
		// Backfill: onChange fires once with every section, same as connect().
		expect(events).toHaveLength(1);
		expect(events[0]?.playerId).toBe("pid-a");
		expect(events[0]?.changed.length).toBeGreaterThan(0);
	});

	test("connectOne() throws when the connected account has no player_id", async () => {
		const players = [player("Ghost", "")];
		const accounts = new Map<string, FakeAccount>();
		accounts.set("Ghost", new FakeAccount("", "Ghost"));
		const client = new FakeClient(players, accounts);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });

		await expect(mgr.connectOne("Ghost")).rejects.toThrow("no player_id");
	});

	test("connectOne() tracks isConnecting while the connect is in flight", async () => {
		const { client } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });

		expect(mgr.isConnecting("Alpha")).toBe(false);
		const promise = mgr.connectOne("Alpha");
		expect(mgr.isConnecting("alpha")).toBe(true); // case-insensitive
		await promise;
		expect(mgr.isConnecting("Alpha")).toBe(false);
	});

	test("register() indexes the new account and backfills the projector", async () => {
		const { client } = setup([]);
		const events: Array<{ playerId: string; changed: string[] }> = [];
		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{ onStateChange: (playerId, changed) => events.push({ playerId, changed }) },
		);

		const { account, result } = await mgr.register({
			username: "NewPlayer",
			empire: "solarian",
		});

		expect(account.id).toBe("NewPlayer");
		expect(result.player_id).toBe("pid-NewPlayer");
		expect(mgr.getByPlayerId("pid-NewPlayer")).toBe(account);
		expect(mgr.getByUsername("newplayer")).toBe(account);
		expect(events).toHaveLength(1);
		expect(events[0]?.changed.length).toBeGreaterThan(0);
	});

	test("remove(playerId) clears both indexes (same effect as disconnect)", async () => {
		const { client, accounts } = setup([player("Alpha", "pid-a")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
		await mgr.connect();

		await mgr.remove("pid-a");
		expect(mgr.size).toBe(0);
		expect(mgr.getByPlayerId("pid-a")).toBeUndefined();
		expect(mgr.getByUsername("alpha")).toBeUndefined();
		expect(accounts.get("Alpha")?.closed).toBe(true);
		expect(client.account("Alpha")).toBeUndefined();
	});

	test("listOwned() passes through the client's owned-player list", async () => {
		const { client } = setup([player("Alpha", "pid-a"), player("Beta", "pid-b")]);
		const mgr = new LibAccountManager(client, { clerkApiKey: "k" });

		const owned = await mgr.listOwned();
		expect(owned.map((p) => p.username)).toEqual(["Alpha", "Beta"]);
	});

	describe("listOwned() TTL cache", () => {
		afterEach(() => {
			spyOn(Date, "now").mockRestore();
		});

		test("repeated calls within the TTL hit the client's listOwnedPlayers only once", async () => {
			const { client } = setup([player("Alpha", "pid-a")]);
			const mgr = new LibAccountManager(client, { clerkApiKey: "k" });

			await mgr.listOwned();
			await mgr.listOwned();
			await mgr.listOwned();

			expect(client.listOwnedPlayersCallCount).toBe(1);
		});

		test("a call after the TTL expires refreshes from the client", async () => {
			const { client } = setup([player("Alpha", "pid-a")]);
			const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
			const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);

			await mgr.listOwned();
			expect(client.listOwnedPlayersCallCount).toBe(1);

			nowSpy.mockReturnValue(1_000_000 + 30_000); // still within the 60s TTL
			await mgr.listOwned();
			expect(client.listOwnedPlayersCallCount).toBe(1);

			nowSpy.mockReturnValue(1_000_000 + 60_001); // past the TTL
			await mgr.listOwned();
			expect(client.listOwnedPlayersCallCount).toBe(2);
		});
	});

	describe("state-freshness marking", () => {
		afterEach(() => {
			spyOn(Date, "now").mockRestore();
		});

		test("connect() records a real freshness timestamp (not just an untracked-is-fresh default)", async () => {
			const { client, accounts } = setup([player("Alpha", "pid-a")]);
			const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
			const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);
			await mgr.connect();
			nowSpy.mockRestore();

			const account = accounts.get("Alpha") as object;
			// Fresh immediately after connect...
			expect(isStateStale(account, undefined, 1_000_000 + 1_000)).toBe(false);
			// ...but stale once the TTL has actually elapsed since the recorded mark.
			// An untracked account (no markStateFresh call) would never go stale, so
			// this proves a real timestamp was recorded at connect time.
			expect(isStateStale(account, undefined, 1_000_000 + STATE_FRESHNESS_TTL_MS + 1)).toBe(true);
		});

		test("connectOne() records a real freshness timestamp (not just an untracked-is-fresh default)", async () => {
			const { client, accounts } = setup([player("Alpha", "pid-a")]);
			const mgr = new LibAccountManager(client, { clerkApiKey: "k" });
			const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);
			await mgr.connectOne("Alpha");
			nowSpy.mockRestore();

			const account = accounts.get("Alpha") as object;
			expect(isStateStale(account, undefined, 1_000_000 + 1_000)).toBe(false);
			expect(isStateStale(account, undefined, 1_000_000 + STATE_FRESHNESS_TTL_MS + 1)).toBe(true);
		});

		test("an onStateChange emission re-marks the account fresh", async () => {
			const { client, accounts } = setup([player("Alpha", "pid-a")]);
			const mgr = new LibAccountManager(client, { clerkApiKey: "k" }, { onStateChange: () => {} });
			await mgr.connect();

			const account = accounts.get("Alpha");
			if (!account) throw new Error("expected account");

			// Re-mark at a controlled instant, then prove the mark actually moved to
			// it (not just left at the earlier real-time connect() mark).
			const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);
			account.emitStateChange(["ship"]);
			nowSpy.mockRestore();

			expect(isStateStale(account as object, undefined, 1_000_000 + 1_000)).toBe(false); // within TTL of the re-mark
			expect(isStateStale(account as object, undefined, 1_000_000 + 40_000)).toBe(true); // past TTL of the re-mark
		});
	});
});
