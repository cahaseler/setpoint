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

interface BatchEntry {
	weapon_instance_id: string;
	ammo_item_id: string;
}

/**
 * How the fake game answers one batch entry. Defaults to loading the gun;
 * a test can instead make the game refuse it with a given error code.
 */
type EntryVerdict = { refuse: string } | undefined;

/**
 * An account whose `reload` handler simulates the game's batch reload: each
 * entry fills its magazine and takes one case from cargo, and the per-gun
 * results come back under `details`, indexed by position in the request.
 */
const makeAccount = (
	state: Record<string, unknown>,
	verdict: (entry: BatchEntry) => EntryVerdict = () => undefined,
): FakeLibGoalAccount => {
	// The reload handler has to read and mutate the account it belongs to, so it
	// resolves it through a ref filled in immediately after construction.
	const ref: { current?: FakeLibGoalAccount } = {};
	const account = new FakeLibGoalAccount(state as never, {
		reload: (params?: unknown) => {
			const target = ref.current;
			if (target === undefined) throw new Error("account not constructed yet");
			return batchReloadHandler(target, verdict)(params);
		},
	});
	ref.current = account;
	return account;
};

const batchReloadHandler =
	(account: FakeLibGoalAccount, verdict: (entry: BatchEntry) => EntryVerdict) =>
	(params?: unknown) => {
		const { weapons } = params as { weapons: BatchEntry[] };
		const results = weapons.map((entry, index) => {
			const refusal = verdict(entry);
			if (refusal !== undefined) {
				return {
					index,
					weapon_id: entry.weapon_instance_id,
					success: false,
					error_code: refusal.refuse,
					error: `refused: ${refusal.refuse}`,
				};
			}
			const state = account.state as {
				modules?: Array<Record<string, unknown>>;
				cargo?: Array<Record<string, unknown>>;
			};
			// Simulate the game: the magazine fills, one case leaves cargo.
			account.setState({
				modules: (state.modules ?? []).map((m) =>
					m["module_id"] === entry.weapon_instance_id ? { ...m, current_ammo: 7 } : m,
				),
				cargo: (state.cargo ?? []).map((c) =>
					c["item_id"] === entry.ammo_item_id
						? { ...c, quantity: (c["quantity"] as number) - 1 }
						: c,
				),
			} as never);
			return {
				index,
				weapon_id: entry.weapon_instance_id,
				success: true,
				// Batch results omit rounds_discarded, as the live game does.
				result: {
					action: "reload",
					weapon_id: entry.weapon_instance_id,
					weapon_name: "Railgun II",
					ammo_id: entry.ammo_item_id,
					ammo_name: "Tungsten Slug Case",
					current_ammo: 7,
					magazine_size: 7,
				},
			};
		});
		return {
			command: "reload",
			tick: 0,
			delta: { details: { action: "reload", mode: "bulk", results, summary: {} } },
		};
	};

/** Every batch entry sent across all reload calls, in order. */
const sentEntries = (account: FakeLibGoalAccount): BatchEntry[] =>
	account.calls
		.filter((c) => c.action === "reload")
		.flatMap((c) => (c.params as { weapons: BatchEntry[] }).weapons);

const reloadCalls = (account: FakeLibGoalAccount) =>
	account.calls.filter((c) => c.action === "reload");

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
		// One batch, one tick — not one per gun.
		expect(result.ticksUsed).toBe(1);
		expect(reloadCalls(account)).toHaveLength(1);
		expect(sentEntries(account)).toHaveLength(5);
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

		expect(sentEntries(account).map((e) => e.weapon_instance_id)).toEqual(["empty"]);
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
		expect(reloadCalls(account)).toHaveLength(0);
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
		expect(reloadCalls(account)).toHaveLength(0);
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
		expect(sentEntries(account)).toEqual([
			{ weapon_instance_id: "mod-1", ammo_item_id: "tungsten_slug_case" },
		]);
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

		const targets = sentEntries(account);
		expect(targets.find((t) => t.weapon_instance_id === "mod-2")?.ammo_item_id).toBe(
			"depleted_slug_case",
		);
		expect(targets.find((t) => t.weapon_instance_id === "mod-1")?.ammo_item_id).toBe(
			"tungsten_slug_case",
		);
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

	test("never promises more cases than the hold carries", async () => {
		// Every gun is planned before the batch is sent, so the planner has to
		// spend cases as it assigns them. Three guns, two cases: two entries.
		const account = makeAccount({
			modules: [gun("mod-1"), gun("mod-2"), gun("mod-3")],
			cargo: cargo(2),
		});

		await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(sentEntries(account)).toHaveLength(2);
	});

	test("a gun the game refuses fails with the game's own reason", async () => {
		const account = makeAccount(
			{ modules: [gun("mod-1"), gun("mod-2")], cargo: cargo(5) },
			(entry) => (entry.weapon_instance_id === "mod-2" ? { refuse: "wrong_ammo_type" } : undefined),
		);

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.summary).toEqual({ total: 2, changed: 1, unchanged: 1, failed: 1 });
		const refused = result.subjects.find((s) => s.id === "mod-2");
		expect(refused?.message).toBe("wrong_ammo_type: refused: wrong_ammo_type");
		expect(refused?.before).toMatchObject({ ammo: 0, capacity: 7 });
	});

	test("magazine_full from the game is a satisfied gun, not a failure", async () => {
		// The gun filled between our read and the reload; the game spends nothing.
		const account = makeAccount({ modules: [gun("mod-1")], cargo: cargo(5) }, () => ({
			refuse: "magazine_full",
		}));

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(result.subjects[0]).toMatchObject({ ok: true, action: "none", message: "already full" });
	});

	test("a gun the batch response omits is failed, never assumed loaded", async () => {
		const account = new FakeLibGoalAccount({ modules: [gun("mod-1")], cargo: cargo(5) } as never, {
			reload: () => ({
				command: "reload",
				tick: 0,
				delta: { details: { action: "reload", mode: "bulk", results: [], summary: {} } },
			}),
		});

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toContain("missing_result");
	});

	test("a whole-batch failure fails every pending gun with its observed state", async () => {
		const account = new FakeLibGoalAccount(
			{ modules: [gun("mod-1"), gun("mod-2", { current_ammo: 2 })], cargo: cargo(5) } as never,
			{
				reload: () => {
					throw new Error("in_battle: cannot perform this action while in combat");
				},
			},
		);

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.summary.failed).toBe(2);
		for (const subject of result.subjects) {
			expect(subject.message).toContain("reload_failed: in_battle");
			expect(subject.before).toBeDefined();
		}
	});

	test("omits roundsDiscarded when the game did not report it, rather than claiming zero", async () => {
		const account = makeAccount({ modules: [gun("mod-1")], cargo: cargo(5) });

		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));

		const after = result.subjects[0]?.after as Record<string, unknown> | undefined;
		expect(after).toMatchObject({ ammo: 7, capacity: 7, ammoType: "tungsten_slug_case" });
		expect(after && "roundsDiscarded" in after).toBe(false);
	});

	test("an abort before the batch is sent fails the pending guns and sends nothing", async () => {
		const account = makeAccount({ modules: [gun("mod-1")], cargo: cargo(5) });
		const controller = new AbortController();
		controller.abort();

		const result = await new LibEnsureMagazines().execute(
			makeLibGoalContext(account, controller.signal),
		);

		expect(reloadCalls(account)).toHaveLength(0);
		expect(result.subjects[0]?.message).toBe("aborted");
	});

	test("a ship with no ammo-fed weapons is a no-op, not a failure", async () => {
		const account = new FakeLibGoalAccount({ modules: [], cargo: cargo(5) });
		const result = await new LibEnsureMagazines().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.summary.total).toBe(0);
	});
});
