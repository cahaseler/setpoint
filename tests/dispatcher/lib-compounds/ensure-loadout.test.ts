import { describe, expect, test } from "bun:test";
import { LibEnsureLoadout } from "../../../src/dispatcher/lib-compounds/ensure-loadout.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

function baseState() {
	return {
		location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
		ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50, cargo_capacity: 100, cargo_used: 0 },
		cargo: [] as Array<{ item_id: string; quantity: number }>,
	};
}

describe("LibEnsureLoadout", () => {
	test("already satisfied when the installed loadout matches the desired one", async () => {
		const account = new FakeLibGoalAccount({
			...baseState(),
			modules: [{ module_id: "m1", type_id: "type_a" }],
		});

		const result = await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["type_a"],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("uninstalls an unwanted module and sources + installs the desired one", async () => {
		const account = new FakeLibGoalAccount(
			{ ...baseState(), modules: [{ module_id: "m1", type_id: "old_type" }] },
			{
				uninstall_mod: () => {
					account.setState({ modules: [], cargo: [{ item_id: "old_type", quantity: 1 }] });
					return {
						command: "uninstall_mod",
						tick: 0,
						delta: { details: { module_id: "m1", cpu_used: 1, power_used: 1, damaged: false } },
					};
				},
				deposit: () => {
					account.setState({ cargo: [] });
					return fakeMutationResult("deposit");
				},
				view: () => ({
					result: "",
					structuredContent: {
						base_id: "sol_base",
						hint: "",
						items: [{ item_id: "new_type", name: "New Module", quantity: 1, size: 1 }],
					},
				}),
				withdraw: () => {
					account.setState({ cargo: [{ item_id: "new_type", quantity: 1 }] });
					return fakeMutationResult("withdraw");
				},
				install_mod: () => {
					account.setState({ cargo: [], modules: [{ module_id: "m2", type_id: "new_type" }] });
					return {
						command: "install_mod",
						tick: 0,
						delta: { details: { module_id: "m2", cpu_used: 1, power_used: 1 } },
					};
				},
			},
		);

		const result = await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["new_type"],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.message).toContain("1 removed, 1 installed, 0 ammo loaded");
		expect(account.calls.some((c) => c.action === "uninstall_mod")).toBe(true);
		expect(account.calls.some((c) => c.action === "install_mod")).toBe(true);
		expect(
			account.calls.some(
				(c) => c.action === "deposit" && (c.params as { target?: string })?.target === "self",
			),
		).toBe(true);
	});

	test("fails when a desired module cannot be sourced from storage or market", async () => {
		const account = new FakeLibGoalAccount({ ...baseState(), modules: [] });

		const result = await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["missing_type"],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.message).toContain("Failed at install");
		expect(result.steps.map((s) => s.goalName)).toContain("source-and-install");
	});
});
