import { describe, expect, test } from "bun:test";
import { SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibAbandonMission } from "../../../src/dispatcher/lib-primitives/abandon-mission.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibAbandonMission", () => {
	test("abandons mission and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				abandon_mission: () => ({
					command: "abandon_mission",
					tick: 0,
					delta: {
						details: { mission_id: "mission-1", title: "Deliver Cargo", message: "Abandoned" },
					},
				}),
			},
		);
		const result = await new LibAbandonMission({ missionId: "mission-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deliver Cargo");
		expect(account.calls[0]).toEqual({ action: "abandon_mission", params: { id: "mission-1" } });
	});

	test("falls back to missionId when response has no title", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				abandon_mission: () => ({ command: "abandon_mission", tick: 0, delta: {} }),
			},
		);
		const result = await new LibAbandonMission({ missionId: "mission-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain("mission-1");
	});

	test("propagates errors from the command", async () => {
		const account = new FakeLibGoalAccount(
			{},
			{
				abandon_mission: () => {
					throw new SpacemoltError("not_found", "Mission not found");
				},
			},
		);
		await expect(
			new LibAbandonMission({ missionId: "mission-1" }).execute(makeLibGoalContext(account)),
		).rejects.toThrow(SpacemoltError);
	});
});
