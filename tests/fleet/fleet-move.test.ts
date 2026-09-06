import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import type { FleetAccess } from "../../src/fleet/fleet-access.js";
import { fleetMove } from "../../src/fleet/fleet-move.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../dispatcher/lib-fakes.js";

const DEST = { system_id: "keelbreak", poi_id: "arena", in_transit: false };
const opts = { systemId: "keelbreak", poiId: "arena", maxWaitMs: 20 };

const fleetOf = (memberIds: string[]) => () => ({
	result: "",
	structuredContent: {
		action: "status",
		in_fleet: true,
		is_leader: true,
		fleet_id: "f-1",
		members: [
			{ player_id: "leader", username: "L", is_leader: true },
			...memberIds.map((id) => ({ player_id: id, username: id, is_leader: false })),
		],
	},
});

function leaderAt(location: Record<string, unknown>, memberIds: string[]): FakeLibGoalAccount {
	return new FakeLibGoalAccount(
		{ location, ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 } },
		{
			status: fleetOf(memberIds),
			travel: () => fakeMutationResult("travel"),
			jump: () => fakeMutationResult("jump"),
		},
	);
}

const memberAt = (location: Record<string, unknown>) =>
	new FakeLibGoalAccount({ location, ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 } });

const access = (members: Record<string, FakeLibGoalAccount>): FleetAccess => ({
	resolve: (id) => id,
	contextFor: (id) => {
		const account = members[id];
		return account === undefined ? undefined : makeLibGoalContext(account);
	},
	busyReason: () => undefined,
});

describe("fleetMove", () => {
	test("reports every member that arrived with the leader", async () => {
		const leader = leaderAt(DEST, ["alpha", "beta"]);
		const alpha = memberAt(DEST);
		const beta = memberAt(DEST);

		const result = await fleetMove(makeLibGoalContext(leader), access({ alpha, beta }), opts);

		expect(result.success).toBe(true);
		expect(result.summary.total).toBe(3);
		expect(result.accounts["alpha"]?.success).toBe(true);
		expect(result.accounts["beta"]?.success).toBe(true);
	});

	test("a member that never arrives is reported with where it actually is", async () => {
		const leader = leaderAt(DEST, ["stray"]);
		const stray = memberAt({ system_id: "sol", poi_id: "sol_station", in_transit: false });

		const result = await fleetMove(makeLibGoalContext(leader), access({ stray }), opts);

		expect(result.success).toBe(false);
		expect(result.accounts["stray"]?.message).toContain("did_not_arrive");
		expect(result.accounts["stray"]?.message).toContain("sol");
	});

	test("waits for a mid-transit leader instead of classifying members against a phantom", async () => {
		// Mid-jump the leader reports no POI, so every member looks like a stray.
		const leader = leaderAt({ system_id: "keelbreak", poi_id: undefined, in_transit: true }, [
			"alpha",
		]);
		leader.refreshReturns = { location: DEST };
		const alpha = memberAt(DEST);

		const result = await fleetMove(makeLibGoalContext(leader), access({ alpha }), opts);

		expect(leader.refreshCalls).toBeGreaterThan(0);
		expect(result.message).toContain("waited for the leader");
	});

	test("members are not asked to arrive somewhere the leader never reached", async () => {
		const leader = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station", in_transit: false },
				ship: { fuel: 0, max_fuel: 100 },
			},
			{
				status: fleetOf(["alpha"]),
				travel: () => {
					throw new Error("unknown_destination");
				},
			},
		);
		const alpha = memberAt({ system_id: "sol", poi_id: "sol_station", in_transit: false });

		const result = await fleetMove(makeLibGoalContext(leader), access({ alpha }), opts);

		expect(result.success).toBe(false);
		expect(result.accounts["alpha"]?.message).toContain("leader_did_not_arrive");
	});

	test("an unreachable member is reported not_connected", async () => {
		const leader = leaderAt(DEST, ["ghost"]);
		const result = await fleetMove(makeLibGoalContext(leader), access({}), opts);
		expect(result.accounts["ghost"]?.message).toBe("not_connected");
	});
});
