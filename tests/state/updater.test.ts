import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { components } from "../../src/generated/api-types.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import { StateStore } from "../../src/state/store.js";
import { StateUpdater } from "../../src/state/updater.js";
import type { StateChangeEvent } from "../../src/state/updater.js";
import { makeGameStateContent, makeLoginStructuredContent } from "../fixtures/api-responses.js";

type V2GameState = components["schemas"]["V2GameState"];

let db: Database;
let store: StateStore;
let updater: StateUpdater;

beforeEach(() => {
	db = createMemoryDatabase();
	store = new StateStore(db);
	updater = new StateUpdater(store);
});

describe("StateUpdater.processResponse", () => {
	test("returns empty array for null input", () => {
		const updated = updater.processResponse("account-1", null);
		expect(updated).toEqual([]);
	});

	test("returns empty array for non-object input", () => {
		expect(updater.processResponse("account-1", "string")).toEqual([]);
		expect(updater.processResponse("account-1", 42)).toEqual([]);
		expect(updater.processResponse("account-1", true)).toEqual([]);
	});

	test("returns empty array for empty object", () => {
		const updated = updater.processResponse("account-1", {});
		expect(updated).toEqual([]);
	});

	test("processes game state content and stores it", () => {
		const gameState = makeGameStateContent();
		const updated = updater.processResponse("account-1", gameState);

		expect(updated.length).toBeGreaterThan(0);
		expect(updated).toContain("player");
		expect(updated).toContain("ship");
		expect(updated).toContain("location");

		const storedState = store.getState("account-1");
		expect(storedState?.player?.id).toBe("test-player-id");
		expect(storedState?.ship?.id).toBe("test-ship-id");
		expect(storedState?.location?.system_id).toBe("sol");
	});

	test("travel response updates poi and clears docked_at when auto-undocked", () => {
		// Seed: docked at a base in sol.
		updater.processResponse("account-1", makeGameStateContent());
		const seeded = store.getState("account-1");
		expect(seeded?.location?.docked_at).toBeTruthy();

		const updated = updater.processResponse("account-1", {
			action: "travel",
			poi: "Sol Belt",
			poi_id: "sol_belt",
			auto_undocked: true,
			online_players: [],
			online_players_count: 0,
			online_players_truncated: false,
			offline_collapsed: 0,
		});

		expect(updated).toContain("location");
		const state = store.getState("account-1");
		expect(state?.location?.poi_id).toBe("sol_belt");
		expect(state?.location?.poi_name).toBe("Sol Belt");
		expect(state?.location?.docked_at).toBeFalsy();
		// Other location fields survive the merge.
		expect(state?.location?.system_id).toBe("sol");
	});

	test("travel response without auto_undocked preserves docked_at", () => {
		updater.processResponse("account-1", makeGameStateContent());

		updater.processResponse("account-1", {
			action: "travel",
			poi: "Sol Belt",
			poi_id: "sol_belt",
			online_players: [],
			online_players_count: 0,
			online_players_truncated: false,
			offline_collapsed: 0,
		});

		const state = store.getState("account-1");
		expect(state?.location?.poi_id).toBe("sol_belt");
		expect(state?.location?.docked_at).toBe(makeGameStateContent().location?.docked_at as string);
	});

	test("only updates sections present in response", () => {
		const partialState: V2GameState = {
			player: {
				id: "p1",
				username: "Test",
				credits: 500,
				empire: "solarian",
			},
		};

		const updated = updater.processResponse("account-1", partialState);
		expect(updated).toEqual(["player"]);

		const state = store.getState("account-1");
		expect(state?.player).toBeDefined();
		expect(state?.ship).toBeUndefined();
	});

	test("ignores responses without state fields", () => {
		// e.g. find_route returns route data, not game state
		const routeResponse = {
			route: [{ system_id: "sol" }, { system_id: "alpha-centauri" }],
			distance: 5,
		};

		const updated = updater.processResponse("account-1", routeResponse);
		expect(updated).toEqual([]);
	});

	test("accumulates state across multiple responses", () => {
		// First response: player info
		updater.processResponse("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
		});

		// Second response: ship info
		updater.processResponse("account-1", {
			ship: { id: "s1", class_id: "scout", hull: 80, max_hull: 100 },
		});

		const state = store.getState("account-1");
		expect(state?.player?.id).toBe("p1");
		expect(state?.ship?.id).toBe("s1");
	});
});

describe("StateUpdater.processLoginResponse", () => {
	test("maps player fields from login response", () => {
		const login = makeLoginStructuredContent();
		const updated = updater.processLoginResponse("account-1", login);

		expect(updated).toContain("player");

		const state = store.getState("account-1");
		expect(state?.player?.id).toBe("test-player-id");
		expect(state?.player?.username).toBe("TestPlayer");
		expect(state?.player?.credits).toBe(1000);
		expect(state?.player?.empire).toBe("solarian");
	});

	test("maps ship fields from login response", () => {
		const login = makeLoginStructuredContent();
		updater.processLoginResponse("account-1", login);

		const state = store.getState("account-1");
		expect(state?.ship?.id).toBe("test-ship-id");
		expect(state?.ship?.class_id).toBe("scout");
		expect((state?.ship as Record<string, unknown> | undefined)?.["name"]).toBe("Test Scout");
		expect(state?.ship?.hull).toBe(100);
		expect(state?.ship?.max_hull).toBe(100);
		expect(state?.ship?.fuel).toBe(50);
		expect(state?.ship?.max_fuel).toBe(50);
	});

	test("maps location from system and poi", () => {
		const login = makeLoginStructuredContent();
		updater.processLoginResponse("account-1", login);

		const state = store.getState("account-1");
		expect(state?.location?.system_id).toBe("sol");
		expect(state?.location?.system_name).toBe("Sol");
		expect(state?.location?.poi_id).toBe("sol-station");
		expect(state?.location?.poi_name).toBe("Sol Station");
		expect(state?.location?.poi_type).toBe("station");
	});

	test("maps cargo from ship cargo items", () => {
		const login = makeLoginStructuredContent();
		login.ship = {
			...login.ship,
			cargo: [
				{ item_id: "iron", quantity: 10 },
				{ item_id: "copper", quantity: 5 },
			],
		};

		updater.processLoginResponse("account-1", login);

		const state = store.getState("account-1");
		expect(state?.cargo).toBeDefined();
		expect(state?.cargo).toHaveLength(2);

		const iron = (state?.cargo as Array<{ item_id: string; quantity: number }>)?.find(
			(c) => c.item_id === "iron",
		);
		expect(iron?.quantity).toBe(10);
	});

	test("handles login without ship", () => {
		const login = makeLoginStructuredContent();
		login.ship = undefined as unknown as typeof login.ship;

		const updated = updater.processLoginResponse("account-1", login);

		expect(updated).toContain("player");
		expect(updated).not.toContain("ship");
		expect(updated).not.toContain("cargo");
	});

	test("handles login without system", () => {
		const login = makeLoginStructuredContent();
		login.system = undefined as unknown as typeof login.system;

		const updated = updater.processLoginResponse("account-1", login);

		expect(updated).not.toContain("location");
	});

	test("handles login without poi", () => {
		const login = makeLoginStructuredContent();
		login.poi = undefined as unknown as typeof login.poi;

		updater.processLoginResponse("account-1", login);

		const state = store.getState("account-1");
		expect(state?.location?.system_id).toBe("sol");
		// poi fields should not be set
		expect(state?.location?.poi_id).toBeUndefined();
	});

	test("includes empire in location when present", () => {
		const login = makeLoginStructuredContent();
		updater.processLoginResponse("account-1", login);

		const state = store.getState("account-1");
		const location = state?.location as Record<string, unknown> | undefined;
		expect(location?.["empire"]).toBe("solarian");
	});
});

describe("StateUpdater.onStateChange", () => {
	test("emits event when state is updated", () => {
		const events: StateChangeEvent[] = [];
		updater.onStateChange((event) => {
			events.push(event);
		});

		updater.processResponse("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.accountId).toBe("account-1");
		expect(events[0]?.sections).toContain("player");
	});

	test("does not emit event when no state sections present", () => {
		const events: StateChangeEvent[] = [];
		updater.onStateChange((event) => {
			events.push(event);
		});

		updater.processResponse("account-1", { route: [] });

		expect(events).toHaveLength(0);
	});

	test("unsubscribe stops events", () => {
		const events: StateChangeEvent[] = [];
		const unsubscribe = updater.onStateChange((event) => {
			events.push(event);
		});

		updater.processResponse("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		expect(events).toHaveLength(1);

		unsubscribe();

		updater.processResponse("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
		});

		// Should still be 1 — no new events after unsubscribe
		expect(events).toHaveLength(1);
	});

	test("multiple listeners receive events", () => {
		const events1: StateChangeEvent[] = [];
		const events2: StateChangeEvent[] = [];

		updater.onStateChange((event) => events1.push(event));
		updater.onStateChange((event) => events2.push(event));

		updater.processResponse("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		expect(events1).toHaveLength(1);
		expect(events2).toHaveLength(1);
	});

	test("listener error does not break other listeners", () => {
		const events: StateChangeEvent[] = [];

		updater.onStateChange(() => {
			throw new Error("Listener error");
		});
		updater.onStateChange((event) => events.push(event));

		updater.processResponse("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		// Second listener should still receive the event
		expect(events).toHaveLength(1);
	});

	test("event includes the state data", () => {
		const events: StateChangeEvent[] = [];
		updater.onStateChange((event) => events.push(event));

		const gameState = makeGameStateContent();
		updater.processResponse("account-1", gameState);

		expect(events[0]?.state).toBeDefined();
		expect(events[0]?.state.player?.id).toBe("test-player-id");
	});

	test("processLoginResponse does not emit events", () => {
		// processLoginResponse calls store.applyUpdate directly, not processResponse
		// so it does NOT emit change events through the listener system
		const events: StateChangeEvent[] = [];
		updater.onStateChange((event) => events.push(event));

		const login = makeLoginStructuredContent();
		updater.processLoginResponse("account-1", login);

		// Login response goes directly to store, no event emission
		expect(events).toHaveLength(0);
	});
});
