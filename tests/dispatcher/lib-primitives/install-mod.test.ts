import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibInstallMod } from "../../../src/dispatcher/lib-primitives/install-mod.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibInstallMod", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibInstallMod({ moduleId: "mining_laser" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
		expect(account.calls).toHaveLength(0);
	});

	test("already satisfied when module already installed", async () => {
		const account = new FakeLibGoalAccount({
			location: { docked_at: "station-1" },
			modules: [{ module_id: "mining_laser" }],
		});
		const result = await new LibInstallMod({ moduleId: "mining_laser" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("installs module and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, modules: [] },
			{
				install_mod: () => ({
					command: "install_mod",
					tick: 0,
					delta: {
						details: {
							module_id: "mining_laser",
							message: "Installed",
							cpu_used: 5,
							power_used: 10,
						},
					},
				}),
			},
		);
		const result = await new LibInstallMod({ moduleId: "mining_laser" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("mining_laser");
		expect(account.calls[0]).toEqual({ action: "install_mod", params: { id: "mining_laser" } });
	});
});
