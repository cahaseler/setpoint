import { describe, expect, test } from "bun:test";
import { LibEnsureMagazines } from "../../../src/dispatcher/lib-compounds/ensure-magazines.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

const gun = (id: string, over: Record<string, unknown> = {}) => ({
	module_id: id,
	type_id: "railgun_ii",
	name: "Railgun II",
	type: "weapon",
	slot: "weapon",
	size: 1,
	cpu_usage: 4,
	power_usage: 6,
	magazine_size: 7,
	current_ammo: 0,
	loaded_ammo_id: "tungsten_slug_case",
	...over,
});

const cargo = (quantity: number) => [
	{ item_id: "tungsten_slug_case", item_name: "Tungsten Slug Case", quantity, size: 1 },
];

/**
 * An account whose `reload` handler simulates the game: the magazine fills and
 * one case leaves cargo, so a run that outlasts the ammo supply behaves the way
 * it would in flight.
 */
const makeAccount = (state: Record<string, unknown>): FakeLibGoalAccount => {
	// The reload handler has to read and mutate the account it belongs to, so it
	// resolves it through a ref filled in immediately after construction.
	const ref: { current?: FakeLibGoalAccount } = {};
	const account = new FakeLibGoalAccount(state as never, {
		reload: (params?: unknown) => {
			const target = ref.current;
			if (target === undefined) throw new Error("account not constructed yet");
			return reloadHandler(target)(params);
		},
	});
	ref.current = account;
	return account;
};

const reloadHandler = (account: FakeLibGoalAccount) => (params?: unknown) => {
	const { id } = params as { id: string };
	const state = account.state as {
		modules?: Array<Record<string, unknown>>;
		cargo?: Array<Record<string, unknown>>;
	};
	// Simulate the game: the magazine fills, one case leaves cargo.
	account.setState({
		modules: (state.modules ?? []).map((m) =>
			m["module_id"] === id ? { ...m, current_ammo: 7 } : m,
		),
		cargo: (state.cargo ?? []).map((c) => ({ ...c, quantity: (c["quantity"] as number) - 1 })),
	} as never);
	return {
		command: "reload",
		tick: 0,
		delta: {
			details: {
				action: "reload",
				weapon_id: id,
				weapon_name: "Railgun II",
				ammo_id: "tungsten_slug_case",
				ammo_name: "Tungsten Slug Case",
				current_ammo: 7,
				magazine_size: 7,
			},
		},
	};
};

describe("LibEnsureMagazines", () => {
	test("reloads EVERY instance of a repeated weapon type, not just the first", async () => {
		// The W1 regression: five identical railguns must produce five reloads
		// and five subjects. Keying ammo by type_id previously filled one.
		const account = makeAccount({
			modules: [gun("mod-1"), gun("mod-2"), gun("mod-3"), gun("mod-4"), gun("mod-5")],
			cargo: cargo(10),
		});

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.summary).toEqual({ total: 5, changed: 5, unchanged: 0, failed: 0 });
		expect(result.ticksUsed).toBe(5);
		expect(account.calls.filter((c) => c.action === "reload")).toHaveLength(5);
		expect(new Set(result.subjects.map((s) => s.id))).toEqual(
			new Set(["mod-1", "mod-2", "mod-3", "mod-4", "mod-5"]),
		);
	});

	test("a partial fill cannot report success", async () => {
		// Three guns, two cases. The old code reported success here.
		const account = makeAccount({
			modules: [gun("mod-1"), gun("mod-2"), gun("mod-3")],
			cargo: cargo(2),
		});

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.summary.failed).toBe(1);
		const starved = result.subjects.find((s) => !s.ok);
		expect(starved?.message).toBe("insufficient_cargo: tungsten_slug_case");
		expect(starved?.before).toMatchObject({ ammo: 0, capacity: 7 });
	});

	test("fills emptiest first when cases are short", async () => {
		const account = makeAccount({
			modules: [
				gun("full-ish", { current_ammo: 5 }),
				gun("empty", { current_ammo: 0 }),
				gun("half", { current_ammo: 3 }),
			],
			cargo: cargo(1),
		});

		await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		const reloads = account.calls.filter((c) => c.action === "reload");
		expect(reloads).toHaveLength(1);
		expect((reloads[0]?.params as { id: string }).id).toBe("empty");
	});

	test("omits energy weapons entirely rather than padding the result", async () => {
		const account = makeAccount({
			modules: [
				gun("mod-1"),
				{ ...gun("laser-1"), magazine_size: undefined, current_ammo: undefined },
			],
			cargo: cargo(5),
		});

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.summary.total).toBe(1);
		expect(result.subjects.map((s) => s.id)).toEqual(["mod-1"]);
	});

	test("half policy skips a gun above half and says what it would have discarded", async () => {
		const account = makeAccount({
			modules: [gun("mod-1", { current_ammo: 5 })],
			cargo: cargo(5),
		});

		const result = await new LibEnsureMagazines({ policy: "half" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls.filter((c) => c.action === "reload")).toHaveLength(0);
		expect(result.subjects[0]?.message).toContain("would discard 2");
	});

	test("half policy still reloads a gun at exactly half", async () => {
		// Threshold is on rounds: reload when ammo <= floor(magazine/2).
		const account = makeAccount({
			modules: [gun("mod-1", { current_ammo: 3 })],
			cargo: cargo(5),
		});

		const result = await new LibEnsureMagazines({ policy: "half" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.summary.changed).toBe(1);
	});

	test("an empty gun with no hint fails ambiguous_ammo rather than guessing", async () => {
		const account = makeAccount({
			modules: [gun("mod-1", { loaded_ammo_id: undefined, type_id: "orphan_gun" })],
			cargo: cargo(5),
		});

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toBe("ambiguous_ammo");
		expect(account.calls.filter((c) => c.action === "reload")).toHaveLength(0);
	});

	test("an empty gun takes its cue from a loaded sibling of the same type", async () => {
		const account = makeAccount({
			modules: [
				gun("mod-1", { loaded_ammo_id: undefined }),
				gun("mod-2", { current_ammo: 7, loaded_ammo_id: "tungsten_slug_case" }),
			],
			cargo: cargo(5),
		});

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		const reloads = account.calls.filter((c) => c.action === "reload");
		expect(reloads).toHaveLength(1);
		expect((reloads[0]?.params as { target: string }).target).toBe("tungsten_slug_case");
	});

	test("explicit ammo can address one specific gun by module_id", async () => {
		const account = makeAccount({
			modules: [gun("mod-1"), gun("mod-2")],
			cargo: [
				...cargo(5),
				{ item_id: "depleted_slug_case", item_name: "Depleted Slug Case", quantity: 5, size: 1 },
			],
		});

		await new LibEnsureMagazines({ ammo: { "mod-2": "depleted_slug_case" } }).execute(
			makeLibGoalContext(account),
		);

		const targets = account.calls
			.filter((c) => c.action === "reload")
			.map((c) => c.params as { id: string; target: string });
		expect(targets.find((t) => t.id === "mod-2")?.target).toBe("depleted_slug_case");
		expect(targets.find((t) => t.id === "mod-1")?.target).toBe("tungsten_slug_case");
	});

	test("full magazines are a satisfied no-op", async () => {
		const account = new FakeLibGoalAccount({
			modules: [gun("mod-1", { current_ammo: 7 }), gun("mod-2", { current_ammo: 7 })],
			cargo: cargo(5),
		});
		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.alreadySatisfied).toBe(true);
		expect(result.success).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("a ship with no ammo-fed weapons is a no-op, not a failure", async () => {
		const account = new FakeLibGoalAccount({ modules: [], cargo: cargo(5) });
		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.summary.total).toBe(0);
	});
});
