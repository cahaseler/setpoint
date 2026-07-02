import { describe, expect, test } from "bun:test";
import type { GameState } from "@spacemolt/lib";
import { createMemoryDatabase } from "../../src/state/database.js";
import { StateProjector } from "../../src/state/projector.js";
import { StateStore } from "../../src/state/store.js";

function makeStore(): StateStore {
	return new StateStore(createMemoryDatabase());
}

describe("StateProjector", () => {
	test("writes only the changed sections into the store", () => {
		const store = makeStore();
		const projector = new StateProjector(store);
		const state = {
			location: { system_id: "sol", poi_id: "sol-belt" },
			ship: { hull: 100 },
		} as unknown as GameState;

		projector.project("pid-a", state, ["location"]);

		expect(store.getSection("pid-a", "location")).toEqual({ system_id: "sol", poi_id: "sol-belt" });
		// ship was NOT in `changed`, so it must not have been written
		expect(store.getSection("pid-a", "ship")).toBeUndefined();
	});

	test("projects multiple changed sections", () => {
		const store = makeStore();
		const projector = new StateProjector(store);
		const state = {
			location: { system_id: "sol" },
			cargo: [],
		} as unknown as GameState;

		projector.project("pid-b", state, ["location", "cargo"]);

		expect(store.getSection("pid-b", "location")).toEqual({ system_id: "sol" });
		expect(store.getSection("pid-b", "cargo")).toEqual([]);
	});

	test("no changed sections writes nothing", () => {
		const store = makeStore();
		const projector = new StateProjector(store);
		projector.project("pid-c", {} as GameState, []);
		expect(store.getState("pid-c")).toBeUndefined();
	});
});
