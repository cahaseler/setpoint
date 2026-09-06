import { describe, expect, test } from "bun:test";
import { LibEnsureLoadout } from "../../../src/dispatcher/lib-compounds/ensure-loadout.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

function baseState() {
	return {
		location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
		ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50, cargo_capacity: 100, cargo_used: 0 },
		cargo: [] as Array<{ item_id: string; quantity: number }>,
		// Faction-affiliated by default, which is what makes "faction" the
		// default destination for uninstalled modules.
		player: { id: "p1", faction_id: "ilc" },
	};
}

/**
 * An account carrying one unwanted module, whose handlers simulate a refit:
 * uninstall drops the module into cargo, deposit clears it, storage offers the
 * desired module, withdraw + install fit it.
 */
function makeRefitAccount(): FakeLibGoalAccount {
	// Handlers mutate the account they belong to, so they resolve it through a
	// ref filled in immediately after construction.
	const ref: { current?: FakeLibGoalAccount } = {};
	const acct = (): FakeLibGoalAccount => {
		const target = ref.current;
		if (target === undefined) throw new Error("account not constructed yet");
		return target;
	};
	const account = new FakeLibGoalAccount(
		{ ...baseState(), modules: [{ module_id: "m1", type_id: "old_type" }] },
		{
			uninstall_mod: () => {
				acct().setState({ modules: [], cargo: [{ item_id: "old_type", quantity: 1 }] });
				return {
					command: "uninstall_mod",
					tick: 0,
					delta: { details: { module_id: "m1", cpu_used: 1, power_used: 1, damaged: false } },
				};
			},
			deposit: () => {
				acct().setState({ cargo: [] });
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
				acct().setState({ cargo: [{ item_id: "new_type", quantity: 1 }] });
				return fakeMutationResult("withdraw");
			},
			install_mod: () => {
				acct().setState({ cargo: [], modules: [{ module_id: "m2", type_id: "new_type" }] });
				return {
					command: "install_mod",
					tick: 0,
					delta: { details: { module_id: "m2", cpu_used: 1, power_used: 1 } },
				};
			},
		},
	);
	ref.current = account;
	return account;
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
		const account = makeRefitAccount();

		const result = await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["new_type"],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.message).toContain("1 removed, 1 installed");
		expect(account.calls.some((c) => c.action === "uninstall_mod")).toBe(true);
		expect(account.calls.some((c) => c.action === "install_mod")).toBe(true);
		// Uninstalled modules default to FACTION storage: a module parked in
		// personal storage is invisible to the next pilot's refit, so faction is
		// the only default under which a squad can pass hardware between hulls.
		expect(
			account.calls.some(
				(c) => c.action === "deposit" && (c.params as { target?: string })?.target === "faction",
			),
		).toBe(true);
	});

	test("an account with no faction falls back to personal storage", async () => {
		// The faction default is right for squad refits, but an unaffiliated
		// account has nowhere to deposit and would fail where it used to succeed.
		const account = makeRefitAccount();
		account.setState({ player: { id: "p1" } } as never);

		await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: [],
		}).execute(makeLibGoalContext(account));

		expect(
			account.calls.some(
				(c) => c.action === "deposit" && (c.params as { target?: string })?.target === "self",
			),
		).toBe(true);
	});

	test("an explicit faction request is still honoured for an account with no faction", async () => {
		const account = makeRefitAccount();
		account.setState({ player: { id: "p1" } } as never);

		await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: [],
			uninstalledStorage: "faction",
		}).execute(makeLibGoalContext(account));

		expect(
			account.calls.some(
				(c) => c.action === "deposit" && (c.params as { target?: string })?.target === "faction",
			),
		).toBe(true);
	});

	test("uninstalledStorage: personal still deposits removed modules to self", async () => {
		const account = makeRefitAccount();

		await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: [],
			uninstalledStorage: "personal",
		}).execute(makeLibGoalContext(account));

		expect(
			account.calls.some(
				(c) => c.action === "deposit" && (c.params as { target?: string })?.target === "self",
			),
		).toBe(true);
	});

	test("phase strip removes modules without installing anything", async () => {
		const account = makeRefitAccount();

		const result = await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["new_type"],
			phase: "strip",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "uninstall_mod")).toBe(true);
		expect(account.calls.some((c) => c.action === "install_mod")).toBe(false);
	});

	test("phase fit installs without stripping the module it would have removed", async () => {
		const account = makeRefitAccount();

		const result = await new LibEnsureLoadout({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			modules: ["new_type"],
			phase: "fit",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(account.calls.some((c) => c.action === "uninstall_mod")).toBe(false);
		expect(account.calls.some((c) => c.action === "install_mod")).toBe(true);
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
