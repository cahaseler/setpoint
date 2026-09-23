import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import {
	LibReloadWeapon,
	MAX_BATCH_RELOAD,
	reloadWeapon,
	reloadWeapons,
} from "../../../src/dispatcher/lib-primitives/reload-weapon.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

const reloadResult = (over: Record<string, unknown> = {}) => ({
	command: "reload",
	tick: 0,
	delta: {
		details: {
			action: "reload",
			weapon_id: "mod-1",
			weapon_name: "Railgun II",
			ammo_id: "tungsten_slug_case",
			ammo_name: "Tungsten Slug Case",
			current_ammo: 7,
			magazine_size: 7,
			...over,
		},
	},
});

const gun = (over: Record<string, unknown> = {}) => ({
	module_id: "mod-1",
	type_id: "railgun_ii",
	name: "Railgun II",
	type: "weapon",
	slot: "weapon",
	size: 1,
	cpu_usage: 4,
	power_usage: 6,
	magazine_size: 7,
	current_ammo: 0,
	...over,
});

/** A weapon that consumes no ammo — `magazine_size` is absent entirely. */
const energyWeapon = (id: string) => {
	const { magazine_size, current_ammo, ...rest } = gun({ module_id: id });
	void magazine_size;
	void current_ammo;
	return rest;
};

describe("reloadWeapon", () => {
	test("addresses the weapon by module_id and reports what the game did", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{ reload: () => reloadResult({ rounds_discarded: 3 }) },
		);
		const outcome = await reloadWeapon(makeLibGoalContext(account), {
			moduleId: "mod-1",
			ammoItemId: "tungsten_slug_case",
		});

		expect(account.calls[0]).toEqual({
			action: "reload",
			params: { id: "mod-1", target: "tungsten_slug_case" },
		});
		expect(outcome.currentAmmo).toBe(7);
		expect(outcome.magazineSize).toBe(7);
		// The discard is the reason a caller may choose NOT to reload.
		expect(outcome.roundsDiscarded).toBe(3);
	});

	test("omits target when no ammo is specified, keeping the loaded family", async () => {
		const account = new FakeLibGoalAccount({}, { reload: () => reloadResult() });
		await reloadWeapon(makeLibGoalContext(account), { moduleId: "mod-2" });
		expect(account.calls[0]).toEqual({ action: "reload", params: { id: "mod-2" } });
	});
});

describe("LibReloadWeapon", () => {
	test("reloads an empty gun", async () => {
		const account = new FakeLibGoalAccount({ modules: [gun()] }, { reload: () => reloadResult() });
		const result = await new LibReloadWeapon({ moduleId: "mod-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
	});

	test("a full magazine is already satisfied and costs no tick", async () => {
		const account = new FakeLibGoalAccount({ modules: [gun({ current_ammo: 7 })] }, {});
		const result = await new LibReloadWeapon({ moduleId: "mod-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(account.calls).toHaveLength(0);
	});

	test("fails when the module is not installed", async () => {
		const account = new FakeLibGoalAccount({ modules: [gun()] }, {});
		const result = await new LibReloadWeapon({ moduleId: "missing" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("not installed");
	});

	test("fails on a module that does not take ammo", async () => {
		const account = new FakeLibGoalAccount(
			// An energy weapon: no magazine_size at all, not a magazine_size of undefined.
			{ modules: [energyWeapon("laser-1")] },
			{},
		);
		const result = await new LibReloadWeapon({ moduleId: "laser-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("does not take ammo");
	});
});

describe("reloadWeapons", () => {
	interface Entry {
		weapon_instance_id: string;
		ammo_item_id: string;
	}

	/** A game that loads every entry and reports each by its request index. */
	const loadEverything = (params?: unknown) => {
		const { weapons } = params as { weapons: Entry[] };
		return {
			command: "reload",
			tick: 0,
			delta: {
				details: {
					action: "reload",
					mode: "bulk",
					summary: {},
					results: weapons.map((w, index) => ({
						index,
						weapon_id: w.weapon_instance_id,
						success: true,
						result: {
							action: "reload",
							weapon_id: w.weapon_instance_id,
							weapon_name: "Railgun II",
							ammo_id: w.ammo_item_id,
							ammo_name: "Slug",
							current_ammo: 7,
							magazine_size: 7,
						},
					})),
				},
			},
		};
	};

	test("sends every gun in one call with the game's entry shape", async () => {
		const account = new FakeLibGoalAccount({}, { reload: loadEverything });

		const { outcomes, ticksUsed } = await reloadWeapons(makeLibGoalContext(account), [
			{ moduleId: "mod-1", ammoItemId: "slug" },
			{ moduleId: "mod-2", ammoItemId: "slug" },
		]);

		expect(ticksUsed).toBe(1);
		expect(account.calls).toEqual([
			{
				action: "reload",
				params: {
					weapons: [
						{ weapon_instance_id: "mod-1", ammo_item_id: "slug" },
						{ weapon_instance_id: "mod-2", ammo_item_id: "slug" },
					],
				},
			},
		]);
		expect(outcomes.map((o) => o.success)).toEqual([true, true]);
	});

	test("splits more than the game's maximum into consecutive batches", async () => {
		const account = new FakeLibGoalAccount({}, { reload: loadEverything });
		const entries = Array.from({ length: MAX_BATCH_RELOAD + 3 }, (_, i) => ({
			moduleId: `mod-${i}`,
			ammoItemId: "slug",
		}));

		const { outcomes, ticksUsed } = await reloadWeapons(makeLibGoalContext(account), entries);

		expect(ticksUsed).toBe(2);
		expect(account.calls.map((c) => (c.params as { weapons: Entry[] }).weapons.length)).toEqual([
			MAX_BATCH_RELOAD,
			3,
		]);
		expect(outcomes.map((o) => o.moduleId)).toEqual(entries.map((e) => e.moduleId));
	});

	test("matches results by index, not by position in the response", async () => {
		// A response listing results out of order must not swap two guns' verdicts.
		const account = new FakeLibGoalAccount(
			{},
			{
				reload: () => ({
					command: "reload",
					tick: 0,
					delta: {
						details: {
							action: "reload",
							mode: "bulk",
							summary: {},
							results: [
								{
									index: 1,
									weapon_id: "mod-2",
									success: false,
									error_code: "no_ammo",
									error: "none",
								},
								{ index: 0, weapon_id: "mod-1", success: true },
							],
						},
					},
				}),
			},
		);

		const { outcomes } = await reloadWeapons(makeLibGoalContext(account), [
			{ moduleId: "mod-1", ammoItemId: "slug" },
			{ moduleId: "mod-2", ammoItemId: "slug" },
		]);

		expect(outcomes[0]).toMatchObject({ moduleId: "mod-1", success: true });
		expect(outcomes[1]).toMatchObject({ moduleId: "mod-2", success: false, errorCode: "no_ammo" });
	});

	test("reports roundsDiscarded as undefined when the game omits it", async () => {
		const account = new FakeLibGoalAccount({}, { reload: loadEverything });

		const { outcomes } = await reloadWeapons(makeLibGoalContext(account), [
			{ moduleId: "mod-1", ammoItemId: "slug" },
		]);

		expect(outcomes[0]).toMatchObject({ success: true, roundsDiscarded: undefined });
	});
});
