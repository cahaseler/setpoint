import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { LibEnsureCargo } from "../../../src/dispatcher/lib-compounds/ensure-cargo.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

const AT_STATION = {
	system_id: "sol",
	poi_id: "sol_station",
	docked_at: "sol_base",
	in_transit: false,
};
const opts = { systemId: "sol", poiId: "sol_station", baseId: "sol_base" };

interface HoldSpec {
	cargo: Array<{ item_id: string; quantity: number }>;
	used: number;
	capacity: number;
}

/**
 * An account whose withdraw/deposit handlers move quantities in and out of the
 * hold the way the game would, so capacity actually binds.
 */
function makeAccount(spec: HoldSpec, opts?: { storageEmpty?: boolean }): FakeLibGoalAccount {
	const ref: { current?: FakeLibGoalAccount } = {};
	const apply = (itemId: string, delta: number) => {
		const account = ref.current;
		if (account === undefined) return;
		const state = account.state as unknown as {
			cargo: Array<{ item_id: string; quantity: number }>;
			ship: { cargo_used: number; cargo_capacity: number };
		};
		const cargo = state.cargo.map((c) => ({ ...c }));
		const existing = cargo.find((c) => c.item_id === itemId);
		if (existing) existing.quantity += delta;
		else if (delta > 0) cargo.push({ item_id: itemId, quantity: delta });
		account.setState({
			cargo: cargo.filter((c) => c.quantity > 0),
			ship: { ...state.ship, cargo_used: state.ship.cargo_used + delta },
		} as never);
	};

	const account = new FakeLibGoalAccount(
		{
			location: AT_STATION,
			ship: { fuel: 100, max_fuel: 100, cargo_used: spec.used, cargo_capacity: spec.capacity },
			cargo: spec.cargo,
		} as never,
		{
			withdraw: (params?: unknown) => {
				if (opts?.storageEmpty === true) {
					throw new SpacemoltError("insufficient_items", "Not enough in storage");
				}
				const { item_id, quantity } = params as { item_id: string; quantity: number };
				apply(item_id, quantity);
				return fakeMutationResult("withdraw");
			},
			deposit: (params?: unknown) => {
				const { item_id, quantity } = params as { item_id: string; quantity: number };
				apply(item_id, -quantity);
				return fakeMutationResult("deposit");
			},
		},
	);
	ref.current = account;
	return account;
}

describe("LibEnsureCargo", () => {
	test("draws a shortfall from faction storage", async () => {
		const account = makeAccount({
			cargo: [{ item_id: "slug", quantity: 2 }],
			used: 2,
			capacity: 50,
		});

		const result = await new LibEnsureCargo({
			...opts,
			items: [{ itemId: "slug", quantity: 10 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		const call = account.calls.find((c) => c.action === "withdraw");
		expect(call?.params).toMatchObject({ item_id: "slug", quantity: 8, target: "faction" });
		expect(result.subjects[0]?.after).toMatchObject({ inHold: 10, drawn: { faction: 8 } });
	});

	test("deposits surplus over the bill", async () => {
		const account = makeAccount({
			cargo: [{ item_id: "slug", quantity: 15 }],
			used: 15,
			capacity: 50,
		});

		const result = await new LibEnsureCargo({
			...opts,
			items: [{ itemId: "slug", quantity: 10 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		expect(account.calls.find((c) => c.action === "deposit")?.params).toMatchObject({
			quantity: 5,
		});
	});

	test("clears an item that is not on the bill at all", async () => {
		// load-at-station is additive and cannot express "and nothing else".
		const account = makeAccount({
			cargo: [
				{ item_id: "slug", quantity: 10 },
				{ item_id: "ore", quantity: 7 },
			],
			used: 17,
			capacity: 50,
		});

		const result = await new LibEnsureCargo({
			...opts,
			items: [{ itemId: "slug", quantity: 10 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(true);
		const ore = result.subjects.find((s) => s.id === "ore");
		expect(ore?.action).toBe("removed");
		expect(ore?.after).toMatchObject({ inHold: 0, deposited: 7 });
	});

	test("unlisted: keep leaves an off-bill item alone", async () => {
		const account = makeAccount({
			cargo: [{ item_id: "ore", quantity: 7 }],
			used: 7,
			capacity: 50,
		});

		const result = await new LibEnsureCargo({
			...opts,
			items: [],
			unlisted: "keep",
		}).execute(makeLibGoalContext(account));

		expect(account.calls.some((c) => c.action === "deposit")).toBe(false);
		expect(result.subjects).toHaveLength(0);
	});

	test("a full hold fails cargo_full, distinctly from an empty armoury", async () => {
		const account = makeAccount({
			cargo: [{ item_id: "slug", quantity: 50 }],
			used: 50,
			capacity: 50,
		});

		const result = await new LibEnsureCargo({
			...opts,
			items: [
				{ itemId: "slug", quantity: 50 },
				{ itemId: "plate", quantity: 5 },
			],
			unlisted: "keep",
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		const plate = result.subjects.find((s) => s.id === "plate");
		expect(plate?.message).toBe("cargo_full");
		expect(plate?.before).toMatchObject({ capacity: 50 });
	});

	test("storage without the item fails insufficient_storage, not cargo_full", async () => {
		const account = makeAccount({ cargo: [], used: 0, capacity: 50 }, { storageEmpty: true });

		const result = await new LibEnsureCargo({
			...opts,
			items: [{ itemId: "plate", quantity: 5 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toContain("insufficient_storage");
	});

	test("bill order is priority when capacity binds", async () => {
		// Two lines, room for one. The earlier line wins.
		const account = makeAccount({ cargo: [], used: 49, capacity: 50 });

		const result = await new LibEnsureCargo({
			...opts,
			items: [
				{ itemId: "first", quantity: 1 },
				{ itemId: "second", quantity: 1 },
			],
		}).execute(makeLibGoalContext(account));

		expect(result.subjects.find((s) => s.id === "first")?.ok).toBe(true);
		expect(result.subjects.find((s) => s.id === "second")?.message).toBe("cargo_full");
	});

	test("a hold that already matches the bill is a satisfied no-op", async () => {
		const account = makeAccount({
			cargo: [{ item_id: "slug", quantity: 10 }],
			used: 10,
			capacity: 50,
		});

		const result = await new LibEnsureCargo({
			...opts,
			items: [{ itemId: "slug", quantity: 10 }],
		}).execute(makeLibGoalContext(account));

		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls.some((c) => c.action === "withdraw" || c.action === "deposit")).toBe(
			false,
		);
	});

	test("reports hold capacity as ship context, not per item", async () => {
		const account = makeAccount({
			cargo: [{ item_id: "slug", quantity: 10 }],
			used: 10,
			capacity: 55,
		});

		const result = await new LibEnsureCargo({
			...opts,
			items: [{ itemId: "slug", quantity: 10 }],
		}).execute(makeLibGoalContext(account));

		expect(result.context?.["hold"]).toMatchObject({ capacity: 55, usedBefore: 10 });
	});
});

describe("LibEnsureCargo unknown capacity", () => {
	test("missing ship state reports capacity_unknown, not cargo_full", async () => {
		// Both capacity() and cargoUsed() fall back to 0, so 0 >= 0 would read as
		// a full hold and send the caller off to trim a bill that is fine.
		const account = new FakeLibGoalAccount({ location: AT_STATION, cargo: [] } as never, {
			withdraw: () => fakeMutationResult("withdraw"),
		});

		const result = await new LibEnsureCargo({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "slug", quantity: 5 }],
		}).execute(makeLibGoalContext(account));

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toBe("capacity_unknown");
		expect(account.calls.some((c) => c.action === "withdraw")).toBe(false);
	});
});
