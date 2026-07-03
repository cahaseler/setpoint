import { describe, expect, test } from "bun:test";
import type { Account, ClerkPlayer } from "@spacemolt/lib";
import { LibAccountManager } from "../../src/accounts/lib-manager.js";
import type { LibManagedAccount } from "../../src/accounts/lib-types.js";
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
});
