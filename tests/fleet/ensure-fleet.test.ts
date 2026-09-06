import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../src/dispatcher/lib-goal-context.js";
import { ensureFleet } from "../../src/fleet/ensure-fleet.js";
import type { FleetAccess } from "../../src/fleet/fleet-access.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../dispatcher/lib-fakes.js";

const AT_ARENA = { system_id: "keelbreak", poi_id: "arena", in_transit: false };

const fleetStatus = (over: Record<string, unknown> = {}) => ({
	result: "",
	structuredContent: { action: "status", in_fleet: false, ...over },
});

function leaderAccount(status: Record<string, unknown> = {}): FakeLibGoalAccount {
	return new FakeLibGoalAccount(
		{ location: AT_ARENA, player: { id: "leader" } },
		{
			status: () => fleetStatus(status),
			create: () => ({
				command: "create",
				tick: 0,
				delta: { details: { action: "create", fleet_id: "fleet-1", max_size: 6, message: "" } },
			}),
			invite: () => fakeMutationResult("invite"),
			kick: () => fakeMutationResult("kick"),
			disband: () => fakeMutationResult("disband"),
		},
	);
}

function memberAccount(location: Record<string, unknown> = AT_ARENA): FakeLibGoalAccount {
	return new FakeLibGoalAccount({ location }, { accept: () => fakeMutationResult("accept") });
}

/** A FleetAccess over a fixed map of connected, idle accounts. */
function access(
	members: Record<string, FakeLibGoalAccount>,
	busy: Record<string, string> = {},
): FleetAccess {
	return {
		resolve: (id) => (id in members ? id : id),
		contextFor: (id) => {
			const account = members[id];
			return account === undefined ? undefined : makeLibGoalContext(account);
		},
		busyReason: (id) => busy[id],
	};
}

describe("ensureFleet", () => {
	test("creates a fleet and admits each member by invite then accept", async () => {
		const leader = leaderAccount();
		const alpha = memberAccount();
		const beta = memberAccount();

		const result = await ensureFleet(makeLibGoalContext(leader), access({ alpha, beta }), {
			members: ["alpha", "beta"],
		});

		expect(result.success).toBe(true);
		expect(result.summary).toEqual({ total: 2, changed: 2, unchanged: 0, failed: 0 });
		expect(leader.calls.some((c) => c.action === "create")).toBe(true);
		// The accept has to happen on the INVITEE's own account.
		expect(alpha.calls.some((c) => c.action === "accept")).toBe(true);
		expect(beta.calls.some((c) => c.action === "accept")).toBe(true);
		expect((result.context?.["fleet"] as { created: boolean }).created).toBe(true);
	});

	test("a member mid-loop is reported, never preempted", async () => {
		const leader = leaderAccount();
		const miner = memberAccount();

		const result = await ensureFleet(
			makeLibGoalContext(leader),
			access({ miner }, { miner: "busy:mining-loop" }),
			{ members: ["miner"] },
		);

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toBe("busy:mining-loop");
		// Nothing was done to the miner at all — no invite, no release.
		expect(miner.calls).toHaveLength(0);
		expect(leader.calls.some((c) => c.action === "invite")).toBe(false);
	});

	test("a member elsewhere fails not_at_poi and reports where it actually is", async () => {
		const leader = leaderAccount();
		const inbound = memberAccount({ system_id: "sol", poi_id: null, in_transit: true });

		const result = await ensureFleet(makeLibGoalContext(leader), access({ inbound }), {
			members: ["inbound"],
		});

		expect(result.success).toBe(false);
		const subject = result.subjects[0];
		expect(subject?.message).toBe("not_at_poi");
		// Enough to tell "inbound, wait" from "stray, re-plan".
		expect(subject?.before).toMatchObject({ systemId: "sol", inTransit: true });
		expect(subject?.desired).toMatchObject({ systemId: "keelbreak", poiId: "arena" });
	});

	test("kicks a member that is not in the desired set", async () => {
		const leader = leaderAccount({
			in_fleet: true,
			is_leader: true,
			fleet_id: "fleet-1",
			members: [
				{ player_id: "leader", username: "L", is_leader: true },
				{ player_id: "stale", username: "S", is_leader: false },
			],
		});
		const alpha = memberAccount();

		const result = await ensureFleet(makeLibGoalContext(leader), access({ alpha }), {
			members: ["alpha"],
		});

		expect(result.success).toBe(true);
		expect(leader.calls.some((c) => c.action === "kick")).toBe(true);
		expect(result.subjects.find((s) => s.id === "stale")?.action).toBe("removed");
	});

	test("an empty member list disbands, because a leader cannot leave", async () => {
		const leader = leaderAccount({
			in_fleet: true,
			is_leader: true,
			fleet_id: "fleet-1",
			members: [
				{ player_id: "leader", username: "L", is_leader: true },
				{ player_id: "alpha", username: "A", is_leader: false },
			],
		});

		const result = await ensureFleet(makeLibGoalContext(leader), access({}), { members: [] });

		expect(result.success).toBe(true);
		expect(leader.calls.some((c) => c.action === "disband")).toBe(true);
		expect(leader.calls.some((c) => c.action === "leave")).toBe(false);
		expect((result.context?.["fleet"] as { disbanded: boolean }).disbanded).toBe(true);
	});

	test("a fleet that already matches is a satisfied no-op", async () => {
		const leader = leaderAccount({
			in_fleet: true,
			is_leader: true,
			fleet_id: "fleet-1",
			members: [
				{ player_id: "leader", username: "L", is_leader: true },
				{ player_id: "alpha", username: "A", is_leader: false },
			],
		});

		const result = await ensureFleet(makeLibGoalContext(leader), access({}), {
			members: ["alpha"],
		});

		expect(result.alreadySatisfied).toBe(true);
		expect(leader.calls.filter((c) => c.action !== "status")).toHaveLength(0);
	});

	test("members beyond the leader's fleet capacity fail fleet_full", async () => {
		const leader = leaderAccount({ max_size: 2 });
		const alpha = memberAccount();
		const beta = memberAccount();

		const result = await ensureFleet(makeLibGoalContext(leader), access({ alpha, beta }), {
			members: ["alpha", "beta"],
		});

		expect(result.success).toBe(false);
		// max_size counts the leader, so a size-2 fleet admits exactly one other.
		expect(result.subjects.filter((s) => s.ok)).toHaveLength(1);
		expect(result.subjects.find((s) => !s.ok)?.message).toBe("fleet_full");
	});

	test("an account setpoint is not connected to fails not_connected", async () => {
		const leader = leaderAccount();
		const result = await ensureFleet(makeLibGoalContext(leader), access({}), {
			members: ["ghost"],
		});
		expect(result.subjects[0]?.message).toBe("not_connected");
	});

	test("distinguishes an invite failure from an accept failure", async () => {
		const leader = new FakeLibGoalAccount(
			{ location: AT_ARENA, player: { id: "leader" } },
			{
				status: () => fleetStatus(),
				create: () => ({
					command: "create",
					tick: 0,
					delta: { details: { action: "create", fleet_id: "f", max_size: 6, message: "" } },
				}),
				invite: () => fakeMutationResult("invite"),
			},
		);
		const refuser = new FakeLibGoalAccount(
			{ location: AT_ARENA },
			{
				accept: () => {
					throw new Error("already_in_fleet");
				},
			},
		);

		const result = await ensureFleet(makeLibGoalContext(leader), access({ refuser }), {
			members: ["refuser"],
		});

		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toContain("accept_failed");
		expect(result.subjects[0]?.before).toMatchObject({ invited: true });
	});

	test("refuses to act on a fleet this account does not lead", async () => {
		const leader = leaderAccount({ in_fleet: true, is_leader: false, leader: "someone-else" });
		const alpha = memberAccount();

		const result = await ensureFleet(makeLibGoalContext(leader), access({ alpha }), {
			members: ["alpha"],
		});

		expect(result.message).toContain("not_leader");
		expect(leader.calls.some((c) => c.action === "invite")).toBe(false);
	});
});

describe("ensureFleet correctness guards", () => {
	test("refusing someone else's fleet is a FAILURE, not an empty success", async () => {
		// An empty subject list would derive success:true — a caller would read
		// "fleet reconciled" for an account that is somebody else's follower.
		const leader = leaderAccount({
			in_fleet: true,
			is_leader: false,
			leader: "someone-else",
			fleet_id: "f-9",
		});
		const alpha = memberAccount();

		const result = await ensureFleet(makeLibGoalContext(leader), access({ alpha }), {
			members: ["alpha"],
		});

		expect(result.success).toBe(false);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.subjects[0]?.message).toBe("not_leader");
	});

	test("refusing to disband someone else's fleet is also a failure", async () => {
		const leader = leaderAccount({ in_fleet: true, is_leader: false, leader: "someone-else" });
		const result = await ensureFleet(makeLibGoalContext(leader), access({}), { members: [] });
		expect(result.success).toBe(false);
		expect(result.subjects[0]?.message).toBe("not_leader");
	});

	test("kicks run before admits, so a full fleet still admits the replacements", async () => {
		// max_size 3 holds the leader plus 2. Two unwanted members occupy both
		// slots; admitting first would report fleet_full for both replacements.
		const leader = leaderAccount({
			in_fleet: true,
			is_leader: true,
			fleet_id: "f-1",
			max_size: 3,
			members: [
				{ player_id: "leader", username: "L", is_leader: true },
				{ player_id: "old-1", username: "O1", is_leader: false },
				{ player_id: "old-2", username: "O2", is_leader: false },
			],
		});
		const newA = memberAccount();
		const newB = memberAccount();

		const result = await ensureFleet(makeLibGoalContext(leader), access({ newA, newB }), {
			members: ["newA", "newB"],
		});

		expect(result.success).toBe(true);
		expect(result.subjects.filter((s) => s.action === "removed")).toHaveLength(2);
		expect(result.subjects.filter((s) => s.action === "created")).toHaveLength(2);
	});

	test("sizeAfter accounts for kicked members", async () => {
		const leader = leaderAccount({
			in_fleet: true,
			is_leader: true,
			fleet_id: "f-1",
			members: [
				{ player_id: "leader", username: "L", is_leader: true },
				{ player_id: "keep", username: "K", is_leader: false },
				{ player_id: "drop-1", username: "D1", is_leader: false },
				{ player_id: "drop-2", username: "D2", is_leader: false },
			],
		});

		const result = await ensureFleet(makeLibGoalContext(leader), access({}), {
			members: ["keep"],
		});

		// Leader + the one kept member.
		expect((result.context?.["fleet"] as { sizeAfter: number }).sizeAfter).toBe(2);
	});
});
