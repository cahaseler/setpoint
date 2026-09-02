import { describe, expect, test } from "bun:test";
import type { GetBattleStatusResponse } from "@spacemolt/lib";
import { FleeCombatStrategy } from "../../src/combat/combat-response.js";
import { FakeLibGoalAccount } from "../dispatcher/lib-fakes.js";
import type { DeepPartial } from "../helpers/deep-partial.js";

function statusResult(content: DeepPartial<GetBattleStatusResponse>) {
	return {
		result: "",
		structuredContent: { battle_id: "b1", is_participant: true, ...content },
	};
}

describe("FleeCombatStrategy", () => {
	test("succeeds once status reports no longer a participant", async () => {
		let statusCalls = 0;
		const account = new FakeLibGoalAccount(
			{},
			{
				stance: () => ({ result: "", structuredContent: {} }),
				status: () => {
					statusCalls++;
					return statusCalls < 3
						? statusResult({ is_participant: true })
						: statusResult({ is_participant: false });
				},
			},
		);
		const strategy = new FleeCombatStrategy({ attemptIntervalMs: 1 });

		const result = await strategy.respond({ account, battleId: "b1" });

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(3);
		expect(statusCalls).toBe(3);
		const stanceCalls = account.calls.filter((c) => c.action === "stance");
		expect(stanceCalls).toHaveLength(3);
		expect(stanceCalls[0]?.params).toEqual({ id: "flee" });
	});

	test("succeeds once the flee counter satisfies flee_required", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				stance: () => ({ result: "", structuredContent: {} }),
				status: () =>
					statusResult({
						is_participant: true,
						combat_state: {
							can_escape: true,
							effective_speed: 10,
							em_disrupted: false,
							flee_counter: 3,
							flee_required: 3,
							max_weapon_reach: 1,
							warp_disrupted: false,
							webbed: false,
						},
					}),
			},
		);
		const strategy = new FleeCombatStrategy({ attemptIntervalMs: 1 });

		const result = await strategy.respond({ account, battleId: "b1" });

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
	});

	test("gives up after maxAttempts if still in combat — bounded, not infinite retry", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				stance: () => ({ result: "", structuredContent: {} }),
				status: () => statusResult({ is_participant: true }),
			},
		);
		const strategy = new FleeCombatStrategy({ maxAttempts: 3, attemptIntervalMs: 1 });

		const result = await strategy.respond({ account, battleId: "b1" });

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(3);
		const statusCalls = account.calls.filter((c) => c.action === "status");
		expect(statusCalls).toHaveLength(3);
	});

	test("warp-disrupted (can_escape: false) still retries within budget rather than giving up immediately", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				stance: () => ({ result: "", structuredContent: {} }),
				status: () =>
					statusResult({
						is_participant: true,
						combat_state: {
							can_escape: false,
							effective_speed: 5,
							em_disrupted: false,
							flee_counter: 0,
							max_weapon_reach: 1,
							warp_disrupted: true,
							webbed: false,
						},
					}),
			},
		);
		const strategy = new FleeCombatStrategy({ maxAttempts: 3, attemptIntervalMs: 1 });

		const result = await strategy.respond({ account, battleId: "b1" });

		expect(result.success).toBe(false);
		const stanceCalls = account.calls.filter((c) => c.action === "stance");
		expect(stanceCalls).toHaveLength(3);
	});

	test("respects an already-aborted signal without making any calls", async () => {
		const account = new FakeLibGoalAccount({}, {});
		const controller = new AbortController();
		controller.abort();
		const strategy = new FleeCombatStrategy({ attemptIntervalMs: 1 });

		const result = await strategy.respond({ account, battleId: "b1", signal: controller.signal });

		expect(result.success).toBe(false);
		expect(account.calls).toHaveLength(0);
	});
});
