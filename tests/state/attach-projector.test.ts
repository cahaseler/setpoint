import { describe, expect, test } from "bun:test";
import type { ClerkPlayer, GameState } from "@spacemolt/lib";
import { LibAccountManager } from "../../src/accounts/lib-manager.js";
import { makeProjectingOnStateChange } from "../../src/state/attach-projector.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import { StateProjector } from "../../src/state/projector.js";
import { StateStore } from "../../src/state/store.js";
import { FakeAccount, FakeClient } from "../accounts/fakes.js";

const player = (username: string, id: string): ClerkPlayer => ({
	id,
	username,
	empire: "solarian",
	hidden: false,
});

describe("makeProjectingOnStateChange (integration)", () => {
	test("an account state change lands in the SQLite store", async () => {
		const store = new StateStore(createMemoryDatabase());
		const projector = new StateProjector(store);

		const accounts = new Map<string, FakeAccount>();
		accounts.set("Alpha", new FakeAccount("pid-a", "Alpha"));
		const client = new FakeClient([player("Alpha", "pid-a")], accounts);

		const mgr = new LibAccountManager(
			client,
			{ clerkApiKey: "k" },
			{
				onStateChange: makeProjectingOnStateChange(projector),
			},
		);
		await mgr.connect();

		const next = { location: { system_id: "sol", poi_id: "belt-1" } } as unknown as GameState;
		accounts.get("Alpha")?.emitStateChange(["location"], next);

		expect(store.getSection("pid-a", "location")).toEqual({ system_id: "sol", poi_id: "belt-1" });
	});
});
