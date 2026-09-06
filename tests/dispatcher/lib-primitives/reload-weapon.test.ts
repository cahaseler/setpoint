import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import {
	LibReloadWeapon,
	reloadWeapon,
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
