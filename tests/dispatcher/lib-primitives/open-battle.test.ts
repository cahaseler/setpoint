import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibOpenBattle } from "../../../src/dispatcher/lib-primitives/open-battle.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

const battleStatus = (battleId: string) => ({
	result: "",
	structuredContent: { battle_id: battleId, is_participant: true },
});

describe("LibOpenBattle", () => {
	test("attack opens on a target and reports the battle id read back from status", async () => {
		// attack does not return a battle id of its own.
		const account = new FakeLibGoalAccount(
			{},
			{ attack: () => fakeMutationResult("attack"), status: () => battleStatus("b-42") },
		);

		const result = await new LibOpenBattle({ mode: "attack", targetId: "pirate-1" }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("b-42");
		expect(account.calls[0]).toEqual({ action: "attack", params: { id: "pirate-1" } });
	});

	test("attack without a targetId fails before calling the game", async () => {
		const account = new FakeLibGoalAccount({}, {});
		const result = await new LibOpenBattle({ mode: "attack" }).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("targetId is required");
		expect(account.calls).toHaveLength(0);
	});

	test("a rejected attack fails with the game's own code", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				attack: () => {
					throw new SpacemoltError("challenge_locked", "Challenge is locked");
				},
			},
		);
		const result = await new LibOpenBattle({ mode: "attack", targetId: "x" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("challenge_locked");
	});

	test("engage joins a side and takes the battle id from the response", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				engage: () => ({
					result: "",
					structuredContent: { action: "engage", battle_id: "b-7", message: "ok" },
				}),
			},
		);

		const result = await new LibOpenBattle({ mode: "engage", sideId: 2 }).execute(
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("b-7");
		expect(account.calls[0]).toEqual({ action: "engage", params: { side_id: 2 } });
	});

	test("engage without a side sends no side_id", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				engage: () => ({
					result: "",
					structuredContent: { action: "engage", battle_id: "b-1", message: "ok" },
				}),
			},
		);
		await new LibOpenBattle({ mode: "engage" }).execute(makeLibGoalContext(account));
		expect(account.calls[0]).toEqual({ action: "engage", params: {} });
	});

	test("a battle-status lookup that throws does not fail an attack that succeeded", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				attack: () => fakeMutationResult("attack"),
				status: () => {
					throw new SpacemoltError("not_in_battle", "Not in a battle");
				},
			},
		);
		const result = await new LibOpenBattle({ mode: "attack", targetId: "t" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain("battle id not yet reported");
	});
});
