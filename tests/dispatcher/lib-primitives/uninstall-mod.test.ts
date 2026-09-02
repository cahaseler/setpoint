import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibUninstallMod } from "../../../src/dispatcher/lib-primitives/uninstall-mod.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibUninstallMod", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibUninstallMod({ moduleId: "mining_laser" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
		expect(account.calls).toHaveLength(0);
	});

	test("already satisfied when module not installed", async () => {
		const account = new FakeLibGoalAccount({
			location: { docked_at: "station-1" },
			modules: [],
		});
		const result = await new LibUninstallMod({ moduleId: "mining_laser" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("uninstalls module and reports which one", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, modules: [{ module_id: "mining_laser" }] },
			{
				uninstall_mod: () => ({
					command: "uninstall_mod",
					tick: 0,
					delta: {
						details: {
							module_id: "mining_laser",
							message: "Uninstalled",
							cpu_used: 5,
							power_used: 10,
						},
					},
				}),
			},
		);
		const result = await new LibUninstallMod({ moduleId: "mining_laser" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("mining_laser");
		expect(account.calls[0]).toEqual({ action: "uninstall_mod", params: { id: "mining_laser" } });
	});
});
