import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibAcceptMission } from "../../../src/dispatcher/lib-primitives/accept-mission.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibAcceptMission", () => {
	test("fails when not docked", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		const result = await new LibAcceptMission({ missionId: "mission-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
		expect(account.calls).toHaveLength(0);
	});

	test("accepts mission and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { docked_at: "station-1" } },
			{
				accept_mission: () => ({
					command: "accept_mission",
					tick: 0,
					delta: {
						details: {
							mission_id: "mission-1",
							title: "Deliver Cargo",
							message: "Accepted",
							expires_at: "2026-01-01T00:00:00Z",
							type: "delivery",
						},
					},
				}),
			},
		);
		const result = await new LibAcceptMission({ missionId: "mission-1" }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deliver Cargo");
		expect(account.calls[0]).toEqual({ action: "accept_mission", params: { id: "mission-1" } });
	});
});
