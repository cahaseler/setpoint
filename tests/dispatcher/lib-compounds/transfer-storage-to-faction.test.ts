import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { LibTransferStorageToFaction } from "../../../src/dispatcher/lib-compounds/transfer-storage-to-faction.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibTransferStorageToFaction", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibTransferStorageToFaction().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when personal storage is empty", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{ view: () => ({ result: "", structuredContent: { items: [], credits: 0 } }) },
		);
		const result = await new LibTransferStorageToFaction().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("empty");
	});

	test("transfers items and credits to faction storage", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: { items: [{ item_id: "iron_ore", quantity: 10 }], credits: 500 },
				}),
				deposit: () => ({ command: "deposit", tick: 0, delta: {} }),
			},
		);
		const result = await new LibTransferStorageToFaction().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.steps).toHaveLength(2);
		expect(account.calls.filter((c) => c.action === "deposit")).toHaveLength(2);
	});

	test("skips an item at faction storage cap without failing the others", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				view: () => ({
					result: "",
					structuredContent: { items: [{ item_id: "iron_ore", quantity: 10 }], credits: 0 },
				}),
				deposit: () => {
					throw new SpacemoltError(
						"faction_storage_cap",
						"Faction storage already has 100 of iron_ore (cap: 100)",
					);
				},
			},
		);
		const result = await new LibTransferStorageToFaction().execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("at faction storage cap");
	});
});
