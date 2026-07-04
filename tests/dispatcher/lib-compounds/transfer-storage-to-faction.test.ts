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

	test("transfers items (from storage) and wallet credits (from cargo) to faction storage", async () => {
		const account = new FakeLibGoalAccount(
			// Credits come from the wallet (player.credits), not the storage view.
			{ location: { docked_at: "station-1" }, player: { credits: 500 } },
			{
				view: () => ({
					result: "",
					structuredContent: { items: [{ item_id: "iron_ore", quantity: 10 }] },
				}),
				deposit: () => ({ command: "deposit", tick: 0, delta: {} }),
			},
		);
		const result = await new LibTransferStorageToFaction().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.steps).toHaveLength(2);
		const deposits = account.calls
			.filter((c) => c.action === "deposit")
			.map((c) => c.params as Record<string, unknown>);
		expect(deposits).toHaveLength(2);
		// The item is pulled from personal storage; credits from the wallet ("cargo").
		const itemDeposit = deposits.find((p) => p["item_id"] === "iron_ore");
		const creditDeposit = deposits.find((p) => p["item_id"] === "credits");
		expect(itemDeposit?.["source"]).toBe("storage");
		expect(creditDeposit).toMatchObject({
			item_id: "credits",
			quantity: 500,
			target: "faction",
			source: "cargo",
		});
	});

	test("does not transfer credits when the wallet is empty", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" }, player: { credits: 0 } },
			{
				view: () => ({
					result: "",
					structuredContent: { items: [{ item_id: "iron_ore", quantity: 10 }] },
				}),
				deposit: () => ({ command: "deposit", tick: 0, delta: {} }),
			},
		);
		const result = await new LibTransferStorageToFaction().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		const deposits = account.calls.filter((c) => c.action === "deposit");
		expect(deposits).toHaveLength(1);
		expect((deposits[0]?.params as Record<string, unknown>)?.["item_id"]).toBe("iron_ore");
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
