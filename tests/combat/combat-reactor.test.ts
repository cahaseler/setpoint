import { describe, expect, test } from "bun:test";
import type { CombatEnvelope, CombatMode } from "@setpoint/protocol";
import type { LibAccountManager } from "../../src/accounts/lib-manager.js";
import { CombatHeartbeatStore } from "../../src/combat/combat-heartbeat.js";
import type { CombatModeStore } from "../../src/combat/combat-mode-store.js";
import { CombatReactor } from "../../src/combat/combat-reactor.js";
import type {
	CombatResponseResult,
	CombatResponseStrategy,
} from "../../src/combat/combat-response.js";
import type { ExecutingGoalEntry } from "../../src/server/account-release.js";
import type { JobManager } from "../../src/server/job-manager.js";
import type { LoopManager } from "../../src/server/loop-manager.js";
import { createEventBuffer } from "../../src/state/event-buffer.js";
import { FakeAccount } from "../accounts/fakes.js";

function battleStarted(playerId: string, battleId = "b1") {
	return {
		battle_id: battleId,
		system_id: "sol",
		participants: [{ player_id: playerId, side_id: 1, username: playerId, zone: "outer" }],
		sides: [{ side_id: 1, player_count: 1 }],
	};
}

function battleEnded(battleId = "b1") {
	return {
		battle_id: battleId,
		duration: 10,
		reason: "victory",
		ships_destroyed: 0,
		total_damage: 0,
		winning_side: 1,
	};
}

/** Never actually attempts to flee — resolves immediately so tests don't wait on retry timing. */
class StubStrategy implements CombatResponseStrategy {
	readonly name = "stub";
	calls: string[] = [];
	result: CombatResponseResult = { success: true, message: "stub success", ticksUsed: 1 };

	async respond(): Promise<CombatResponseResult> {
		this.calls.push("respond");
		return this.result;
	}
}

function makeHarness(options: {
	loopStatus?: { type: string; running: boolean; options: Record<string, unknown> } | undefined;
	account?: FakeAccount | undefined;
	combatMode?: CombatMode | undefined;
	heartbeats?: CombatHeartbeatStore | undefined;
	externalHeartbeatTimeoutMs?: number | undefined;
}) {
	const forceRemoveCalls: string[] = [];
	const deleteConfigCalls: string[] = [];
	const loopManager = {
		getStatus: () => options.loopStatus,
		forceRemove: (id: string) => {
			forceRemoveCalls.push(id);
			return true;
		},
		deleteLoopConfig: (id: string) => {
			deleteConfigCalls.push(id);
			return Promise.resolve();
		},
	};
	const jobManager = {
		getRunningJob: () => undefined,
		getExecutionForAccount: () => undefined,
		failAllRunning: () => 0,
	};
	const executingGoals = new Map<string, ExecutingGoalEntry>();
	const combatEventsStore = createEventBuffer<CombatEnvelope>();
	const combatModeStore = { get: () => options.combatMode ?? "flee" } as unknown as CombatModeStore;
	const account = options.account;
	const manager = {
		getByPlayerId: (id: string) => (id === "p1" ? account : undefined),
	};
	const strategy = new StubStrategy();

	const reactor = new CombatReactor({
		manager: manager as unknown as LibAccountManager,
		loopManager: loopManager as unknown as LoopManager,
		jobManager: jobManager as unknown as JobManager,
		executingGoals,
		configDir: "/tmp/config",
		combatEventsStore,
		combatModeStore,
		strategy,
		...(options.heartbeats !== undefined ? { heartbeats: options.heartbeats } : {}),
		...(options.externalHeartbeatTimeoutMs !== undefined
			? { externalHeartbeatTimeoutMs: options.externalHeartbeatTimeoutMs }
			: {}),
	});

	return {
		reactor,
		combatEventsStore,
		forceRemoveCalls,
		deleteConfigCalls,
		strategy,
		combatModeStore,
	};
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("CombatReactor", () => {
	test("bystander battle_started does not interrupt or record anything", () => {
		const { reactor, combatEventsStore, forceRemoveCalls } = makeHarness({
			loopStatus: { type: "mining", running: true, options: {} },
		});
		reactor.handle("p1", "battle_started", battleStarted("other-player"));
		expect(forceRemoveCalls).toHaveLength(0);
		expect(combatEventsStore.recent("p1")).toHaveLength(0);
	});

	test("self-relevant battle_started force-releases the running loop and records combat_interrupted", async () => {
		const account = new FakeAccount("p1", "acc-1");
		const { reactor, combatEventsStore, forceRemoveCalls, deleteConfigCalls, strategy } =
			makeHarness({
				loopStatus: {
					type: "mining",
					running: true,
					options: { sellSystemId: "sol", sellStationPoiId: "sol-poi", sellBaseId: "sol-base" },
				},
				account,
			});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		await flush();

		expect(forceRemoveCalls).toEqual(["p1"]);
		expect(deleteConfigCalls).toEqual(["p1"]);
		expect(strategy.calls).toEqual(["respond"]);

		const events = combatEventsStore.recent("p1");
		expect(events.map((e) => e.type)).toEqual(["battle_started", "combat_interrupted"]);
		const interrupted = events[1] as Extract<CombatEnvelope, { type: "combat_interrupted" }>;
		expect(interrupted.payload).toEqual({
			battleId: "b1",
			previousLoopType: "mining",
			previousGoalType: undefined,
		});
	});

	test('combat mode "external" force-releases the account but skips the automatic flee response', async () => {
		const account = new FakeAccount("p1", "acc-1");
		const { reactor, combatEventsStore, forceRemoveCalls, strategy } = makeHarness({
			loopStatus: { type: "mining", running: true, options: {} },
			account,
			combatMode: "external",
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		await flush();

		// Still released from the setpoint-managed loop...
		expect(forceRemoveCalls).toEqual(["p1"]);
		// ...but the built-in flee strategy never ran, leaving the ship free for
		// hand-written combat logic outside setpoint.
		expect(strategy.calls).toEqual([]);

		const types = combatEventsStore.recent("p1").map((e) => e.type);
		expect(types).toEqual(["battle_started", "combat_interrupted"]);
	});

	test("battle_ended after entering combat runs recovery to the mining loop's sell station", async () => {
		const account = new FakeAccount("p1", "acc-1", {
			location: { system_id: "sol", poi_id: "sol-poi", docked_at: "sol-base" },
			ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
		});
		const { reactor, combatEventsStore } = makeHarness({
			loopStatus: {
				type: "mining",
				running: true,
				options: { sellSystemId: "sol", sellStationPoiId: "sol-poi", sellBaseId: "sol-base" },
			},
			account,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		await flush();
		reactor.handle("p1", "battle_ended", battleEnded());
		await flush();

		const types = combatEventsStore.recent("p1").map((e) => e.type);
		expect(types).toContain("combat_recovery_started");
		expect(types).toContain("combat_recovery_completed");
	});

	test("combatRecovery: external skips recovery entirely", async () => {
		const account = new FakeAccount("p1", "acc-1", {
			location: { system_id: "sol", poi_id: "sol-poi", docked_at: "sol-base" },
			ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
		});
		const { reactor, combatEventsStore } = makeHarness({
			loopStatus: {
				type: "mining",
				running: true,
				options: {
					sellSystemId: "sol",
					sellStationPoiId: "sol-poi",
					sellBaseId: "sol-base",
					combatRecovery: "external",
				},
			},
			account,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		await flush();
		reactor.handle("p1", "battle_ended", battleEnded());
		await flush();

		const types = combatEventsStore.recent("p1").map((e) => e.type);
		expect(types).not.toContain("combat_recovery_started");
	});

	test("battle_ended for an unrelated battle_id does not clear state or trigger recovery", async () => {
		const account = new FakeAccount("p1", "acc-1");
		const { reactor, combatEventsStore } = makeHarness({
			loopStatus: { type: "mining", running: true, options: {} },
			account,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1", "b1"));
		await flush();
		reactor.handle("p1", "battle_ended", battleEnded("b2"));
		await flush();

		const types = combatEventsStore.recent("p1").map((e) => e.type);
		expect(types).not.toContain("combat_recovery_started");
	});

	test("player_died force-releases work but records no recovery events", async () => {
		const account = new FakeAccount("p1", "acc-1");
		const { reactor, combatEventsStore, forceRemoveCalls } = makeHarness({
			loopStatus: { type: "mining", running: true, options: {} },
			account,
		});

		reactor.handle("p1", "player_died", {
			clone_cost: 100,
			insurance_payout: 0,
			respawn_base: "home_base",
			ship_lost: "frigate",
		});
		await flush();

		expect(forceRemoveCalls).toEqual(["p1"]);
		const types = combatEventsStore.recent("p1").map((e) => e.type);
		expect(types).toEqual(["player_died"]);
		expect(types).not.toContain("combat_recovery_started");
	});
});

describe("external combat driver watchdog", () => {
	test("takes the fight when the driver stops checking in mid-battle", async () => {
		// The state that has cost real hulls: "external" with no live driver
		// neither fights nor flees.
		const account = new FakeAccount("p1", "acc-1");
		const heartbeats = new CombatHeartbeatStore();
		const { reactor, strategy } = makeHarness({
			account,
			combatMode: "external",
			heartbeats,
			externalHeartbeatTimeoutMs: 15,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		expect(strategy.calls).toHaveLength(0);

		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(strategy.calls.length).toBeGreaterThan(0);
		reactor.stop();
	});

	test("a driver that keeps breathing is left alone", async () => {
		const account = new FakeAccount("p1", "acc-1");
		const heartbeats = new CombatHeartbeatStore();
		const { reactor, strategy } = makeHarness({
			account,
			combatMode: "external",
			heartbeats,
			externalHeartbeatTimeoutMs: 30,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));

		// Ping faster than the timeout, the way a live driver would each tick.
		const pinger = setInterval(() => heartbeats.beat("p1"), 5);
		await new Promise((resolve) => setTimeout(resolve, 90));
		clearInterval(pinger);

		expect(strategy.calls).toHaveLength(0);
		reactor.stop();
	});

	test("the account's configured mode is never rewritten by the watchdog", async () => {
		// A setting the daemon silently changed on a timer becomes a mystery to
		// whoever debugs it later. Re-arming is the driver's business.
		const account = new FakeAccount("p1", "acc-1");
		const heartbeats = new CombatHeartbeatStore();
		const { reactor, combatModeStore } = makeHarness({
			account,
			combatMode: "external",
			heartbeats,
			externalHeartbeatTimeoutMs: 15,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(combatModeStore.get("p1")).toBe("external");
		reactor.stop();
	});

	test("no watchdog is armed without a heartbeat store", async () => {
		const account = new FakeAccount("p1", "acc-1");
		const { reactor, strategy } = makeHarness({
			account,
			combatMode: "external",
			externalHeartbeatTimeoutMs: 15,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(strategy.calls).toHaveLength(0);
		reactor.stop();
	});
});

describe("reactor shutdown", () => {
	test("stop() clears an armed watchdog so it cannot fire after shutdown", async () => {
		const account = new FakeAccount("p1", "acc-1");
		const heartbeats = new CombatHeartbeatStore();
		const { reactor, strategy } = makeHarness({
			account,
			combatMode: "external",
			heartbeats,
			externalHeartbeatTimeoutMs: 15,
		});

		reactor.handle("p1", "battle_started", battleStarted("p1"));
		reactor.stop();

		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(strategy.calls).toHaveLength(0);
	});
});
