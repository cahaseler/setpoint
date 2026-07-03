import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibCompleteMission } from "../../../src/dispatcher/lib-primitives/complete-mission.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibCompleteMission", () => {
	test("completes mission and reports credits earned", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				complete_mission: () => ({
					command: "complete_mission",
					tick: 0,
					delta: {
						details: {
							mission_id: "mission-1",
							title: "Deliver Cargo",
							message: "Completed",
							credits_earned: 500,
						},
					},
				}),
			},
		);
		const result = await new LibCompleteMission({ missionId: "mission-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deliver Cargo");
		expect(result.message).toContain("+500 credits");
		expect(account.calls[0]).toEqual({ action: "complete_mission", params: { id: "mission-1" } });
	});

	test("defaults credits earned to 0 when absent", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				complete_mission: () => ({
					command: "complete_mission",
					tick: 0,
					delta: {
						details: { mission_id: "mission-1", title: "Deliver Cargo", message: "Completed" },
					},
				}),
			},
		);
		const result = await new LibCompleteMission({ missionId: "mission-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.message).toContain("+0 credits");
	});

	test("propagates errors from the command", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				complete_mission: () => {
					throw new SpacemoltError("objectives_not_met", "Objectives not met");
				},
			},
		);
		await expect(
			new LibCompleteMission({ missionId: "mission-1" }).execute(makeLibGoalContext(account)),
		).rejects.toThrow(SpacemoltError);
	});
});
