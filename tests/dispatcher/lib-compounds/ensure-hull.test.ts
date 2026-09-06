import { describe, expect, test } from "bun:test";
import { LibEnsureHull } from "../../../src/dispatcher/lib-compounds/ensure-hull.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

const AT_STATION = {
	system_id: "sol",
	poi_id: "sol_station",
	docked_at: "sol_base",
	in_transit: false,
};

const baseState = (over: Record<string, unknown> = {}) => ({
	location: AT_STATION,
	ship: { id: "hauler-1", class_id: "hauler", fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
	modules: [{ module_id: "m1", type_id: "autocannon_i" }],
	...over,
});

const listShips = (body: Record<string, unknown>) => () => ({
	result: "",
	structuredContent: { count: 1, ships: [], ...body },
});

const switchShip = (details: Record<string, unknown>) => () => ({
	command: "switch_ship",
	tick: 0,
	delta: { details: { action: "switch_ship", message: "", ...details } },
});

describe("LibEnsureHull", () => {
	const opts = { systemId: "sol", poiId: "sol_station", baseId: "sol_base" };

	test("switches into a stored hull of the requested class", async () => {
		const account = new FakeLibGoalAccount(baseState(), {
			list_ships: listShips({
				active_ship_id: "hauler-1",
				active_ship_class: "hauler",
				ships: [
					{
						ship_id: "raider-9",
						class_id: "raider",
						is_active: false,
						location_base_id: "sol_base",
						modules: 3,
					},
				],
			}),
			switch_ship: switchShip({
				active_ship_id: "raider-9",
				active_ship_class: "raider",
				stored_ship_id: "hauler-1",
				stored_ship_class: "hauler",
				cargo_to_storage: [{ item_id: "ore", quantity: 4 }],
			}),
		});

		const result = await new LibEnsureHull({ ...opts, shipClass: "raider" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "switch_ship")).toBe(true);
		expect(result.subjects[0]?.after).toMatchObject({ shipId: "raider-9", class: "raider" });
	});

	test("reports the hull left behind, with its modules and relocated cargo", async () => {
		// The parked hull keeps its modules — the next pilot's refit depends on
		// knowing that, and the server moves cargo off for us.
		const account = new FakeLibGoalAccount(baseState(), {
			list_ships: listShips({
				active_ship_id: "hauler-1",
				active_ship_class: "hauler",
				ships: [{ ship_id: "raider-9", class_id: "raider", is_active: false, modules: 3 }],
			}),
			switch_ship: switchShip({
				active_ship_id: "raider-9",
				active_ship_class: "raider",
				stored_ship_id: "hauler-1",
				stored_ship_class: "hauler",
				cargo_to_storage: [{ item_id: "ore", quantity: 4 }],
				cargo_note: "moved to storage",
			}),
		});

		const result = await new LibEnsureHull({ ...opts, shipClass: "raider" }).execute(
			makeLibGoalContext(account),
		);

		const parked = result.context?.["parked"] as Record<string, unknown>;
		expect(parked).toMatchObject({ shipId: "hauler-1", class: "hauler", where: "personal" });
		expect(parked["cargoToStorage"]).toEqual([{ item_id: "ore", quantity: 4 }]);
	});

	test("already flying the requested class is a satisfied no-op", async () => {
		const account = new FakeLibGoalAccount(baseState(), {
			list_ships: listShips({ active_ship_id: "hauler-1", active_ship_class: "hauler" }),
		});

		const result = await new LibEnsureHull({ ...opts, shipClass: "hauler" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls.some((c) => c.action === "switch_ship")).toBe(false);
	});

	test("a specific shipId takes precedence over class", async () => {
		const account = new FakeLibGoalAccount(baseState(), {
			list_ships: listShips({
				active_ship_id: "hauler-1",
				active_ship_class: "hauler",
				ships: [
					{ ship_id: "raider-1", class_id: "raider", is_active: false },
					{ ship_id: "raider-2", class_id: "raider", is_active: false },
				],
			}),
			switch_ship: switchShip({ active_ship_id: "raider-2", active_ship_class: "raider" }),
		});

		await new LibEnsureHull({ ...opts, shipId: "raider-2" }).execute(makeLibGoalContext(account));

		const call = account.calls.find((c) => c.action === "switch_ship");
		expect((call?.params as { id: string }).id).toBe("raider-2");
	});

	test("falls back to the faction garage when personal storage has none", async () => {
		const account = new FakeLibGoalAccount(baseState(), {
			list_ships: listShips({
				active_ship_id: "hauler-1",
				active_ship_class: "hauler",
				ships: [],
				faction_garage: [
					{ ship_id: "garaged-1", class_id: "raider", deposited_tick: 1, depositor_id: "x" },
				],
			}),
			switch_ship: switchShip({
				active_ship_id: "garaged-1",
				active_ship_class: "raider",
				claimed_from_faction_garage: true,
			}),
		});

		const result = await new LibEnsureHull({ ...opts, shipClass: "raider" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.subjects[0]?.after).toMatchObject({ claimedFromFactionGarage: true });
	});

	test("no matching hull fails hull_not_available rather than flying the wrong ship", async () => {
		const account = new FakeLibGoalAccount(baseState(), {
			list_ships: listShips({ active_ship_id: "hauler-1", active_ship_class: "hauler", ships: [] }),
		});

		const result = await new LibEnsureHull({ ...opts, shipClass: "dreadnought" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toBe("hull_not_available");
		expect(result.subjects[0]?.before).toMatchObject({ shipId: "hauler-1" });
	});

	test("requires one of shipId or shipClass", async () => {
		const account = new FakeLibGoalAccount(baseState(), {});
		const result = await new LibEnsureHull(opts).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toContain("invalid_request");
		expect(account.calls).toHaveLength(0);
	});

	test("ignores a hull stored at a different station", async () => {
		const account = new FakeLibGoalAccount(baseState(), {
			list_ships: listShips({
				active_ship_id: "hauler-1",
				active_ship_class: "hauler",
				ships: [
					{
						ship_id: "raider-far",
						class_id: "raider",
						is_active: false,
						location_base_id: "other_base",
					},
				],
			}),
		});

		const result = await new LibEnsureHull({ ...opts, shipClass: "raider" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toBe("hull_not_available");
	});
});
