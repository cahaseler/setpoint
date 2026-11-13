import { describe, expect, spyOn, test } from "bun:test";
import type { CombatEnvelope } from "@setpoint/protocol";
import type { LibAccountManager } from "../../src/accounts/lib-manager.js";
import type { RecoveryTarget } from "../../src/combat/combat-recovery.js";
import type { HazardModeStore, HazardSetting } from "../../src/combat/hazard-mode-store.js";
import { HazardReactor, type HazardWarning } from "../../src/combat/hazard-reactor.js";
import type { GoalResult } from "../../src/dispatcher/goals.js";
import type { ExecutingGoalEntry } from "../../src/server/account-release.js";
import type { JobManager } from "../../src/server/job-manager.js";
import type { LoopManager } from "../../src/server/loop-manager.js";
import { createEventBuffer } from "../../src/state/event-buffer.js";
import { FakeLibManagedAccount } from "../dispatcher/lib-fakes.js";

const MINING = {
	type: "mining",
	running: true,
	options: {
		sellSystemId: "sol",
		sellStationPoiId: "sol_station",
		sellBaseId: "sol_base",
	},
};

const warning = (hull: number, maxHull = 400): HazardWarning =>
	({
		dose_pct: 8,
		hazard: { type: "radiation", severity: 3 },
		hull,
		max_hull: maxHull,
		message: "Radiation is burning through your hull.",
	}) as HazardWarning;

function makeHarness(options: {
	setting?: HazardSetting;
	loopStatus?: typeof MINING | undefined;
	executingGoal?: string;
	runningJob?: string;
	inCombat?: boolean;
	retreatResult?: GoalResult;
	systemPois?: unknown[];
}) {
	const released: string[] = [];
	const loopManager = {
		getStatus: () => options.loopStatus,
		forceRemove: (id: string) => {
			released.push(id);
			return true;
		},
		deleteLoopConfig: () => Promise.resolve(),
	};
	const jobManager = {
		getRunningJob: () => (options.runningJob ? { goalType: options.runningJob } : undefined),
		getExecutionForAccount: () => undefined,
		failAllRunning: () => 0,
	};
	const executingGoals = new Map<string, ExecutingGoalEntry>();
	if (options.executingGoal) {
		executingGoals.set("p1", {
			goalType: options.executingGoal,
			startedAt: "",
			controller: new AbortController(),
			progress: { goalType: options.executingGoal, completedSteps: [], remainingSteps: [] },
			promise: Promise.resolve(),
		});
	}
	const combatEventsStore = createEventBuffer<CombatEnvelope>();
	const account = new FakeLibManagedAccount({
		playerId: "p1",
		username: "ILC Anneal",
		state: { location: { system_id: "sol", poi_id: "sol_belt" } } as never,
		handlers: {
			get_system: () => ({ structuredContent: { system: { pois: options.systemPois ?? [] } } }),
		},
	});
	const retreats: RecoveryTarget[] = [];
	let executingDuringRetreat: string | undefined;
	const reactor = new HazardReactor({
		manager: {
			getByPlayerId: (id: string) => (id === "p1" ? account : undefined),
		} as unknown as LibAccountManager,
		loopManager: loopManager as unknown as LoopManager,
		jobManager: jobManager as unknown as JobManager,
		executingGoals,
		configDir: "/nonexistent",
		combatEventsStore,
		hazardModeStore: {
			get: () => options.setting ?? { mode: "retreat" },
		} as unknown as HazardModeStore,
		isInCombat: () => options.inCombat === true,
		retreat: async (_ctx, target) => {
			retreats.push(target);
			executingDuringRetreat = executingGoals.get("p1")?.goalType;
			return (
				options.retreatResult ?? {
					success: true,
					message: "Docked",
					alreadySatisfied: false,
					ticksUsed: 2,
				}
			);
		},
	});
	const events = (): string[] => combatEventsStore.recent("p1").map((e) => e.type);
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	};
	return {
		reactor,
		released,
		retreats,
		events,
		settle,
		executingGoals,
		executingDuringRetreat: () => executingDuringRetreat,
	};
}

/** Silence the reactor's warn/info lines; the assertions are on behaviour. */
function quietly<T>(fn: () => Promise<T>): Promise<T> {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const info = spyOn(console, "info").mockImplementation(() => {});
	return fn().finally(() => {
		warn.mockRestore();
		info.mockRestore();
	});
}

describe("HazardReactor", () => {
	test("retreat (default): stops the loop and docks at its sell station", async () => {
		const h = makeHarness({ loopStatus: MINING });

		await quietly(async () => {
			h.reactor.handle("p1", warning(380));
			await h.settle();
		});

		expect(h.released).toEqual(["p1"]);
		expect(h.retreats).toEqual([{ systemId: "sol", poiId: "sol_station", baseId: "sol_base" }]);
		expect(h.events()).toEqual(["hazard_retreat_started", "hazard_retreat_completed"]);
	});

	test("the retreat holds the account as busy while it runs, then frees it", async () => {
		const h = makeHarness({ loopStatus: MINING });

		await quietly(async () => {
			h.reactor.handle("p1", warning(380));
			await h.settle();
		});

		expect(h.executingDuringRetreat()).toBe("hazard-retreat");
		expect(h.executingGoals.has("p1")).toBe(false);
	});

	test("external: never intervenes", async () => {
		const h = makeHarness({ setting: { mode: "external" }, loopStatus: MINING });

		await quietly(async () => {
			h.reactor.handle("p1", warning(10));
			await h.settle();
		});

		expect(h.released).toEqual([]);
		expect(h.events()).toEqual([]);
	});

	test("tolerate: keeps working while hull is at or above the floor", async () => {
		const h = makeHarness({ setting: { mode: "tolerate", minHullPct: 40 }, loopStatus: MINING });

		await quietly(async () => {
			h.reactor.handle("p1", warning(160)); // exactly 40%
			await h.settle();
		});

		expect(h.released).toEqual([]);
	});

	test("tolerate: retreats once hull falls below the floor", async () => {
		const h = makeHarness({ setting: { mode: "tolerate", minHullPct: 40 }, loopStatus: MINING });

		await quietly(async () => {
			h.reactor.handle("p1", warning(156));
			await h.settle();
		});

		expect(h.released).toEqual(["p1"]);
		expect(h.retreats).toHaveLength(1);
	});

	test("leaves a ship alone when setpoint is running nothing on it", async () => {
		// Someone else is driving it; moving it would be a second driver.
		const h = makeHarness({ loopStatus: undefined });

		await quietly(async () => {
			h.reactor.handle("p1", warning(10));
			await h.settle();
		});

		expect(h.released).toEqual([]);
		expect(h.events()).toEqual([]);
	});

	test("leaves a ship in combat to the combat response", async () => {
		const h = makeHarness({ loopStatus: MINING, inCombat: true });

		await quietly(async () => {
			h.reactor.handle("p1", warning(10));
			await h.settle();
		});

		expect(h.released).toEqual([]);
	});

	test("a second warning during a retreat does not start another", async () => {
		const h = makeHarness({ loopStatus: MINING });

		await quietly(async () => {
			h.reactor.handle("p1", warning(380));
			h.reactor.handle("p1", warning(350));
			await h.settle();
		});

		expect(h.retreats).toHaveLength(1);
	});

	test("a goal with no station of its own docks at the nearest hazard-free station", async () => {
		const h = makeHarness({
			executingGoal: "go-to-poi",
			systemPois: [
				{ id: "sol_belt", position: { x: 0, y: 0 } },
				{
					id: "far_station",
					base_id: "far_base",
					base_type: "station",
					position: { x: 100, y: 0 },
				},
				{
					id: "hot_station",
					base_id: "hot_base",
					base_type: "station",
					hazard: { type: "radiation", severity: 2 },
					position: { x: 1, y: 0 },
				},
				{
					id: "near_station",
					base_id: "near_base",
					base_type: "station",
					position: { x: 10, y: 0 },
				},
				{ id: "outpost", base_id: "outpost_base", base_type: "outpost", position: { x: 2, y: 0 } },
			],
		});

		await quietly(async () => {
			h.reactor.handle("p1", warning(380));
			await h.settle();
		});

		expect(h.retreats).toEqual([{ systemId: "sol", poiId: "near_station", baseId: "near_base" }]);
	});

	test("reports failure when no safe station exists, rather than going nowhere silently", async () => {
		const h = makeHarness({ runningJob: "navigate-to-system", systemPois: [{ id: "sol_belt" }] });

		await quietly(async () => {
			h.reactor.handle("p1", warning(380));
			await h.settle();
		});

		expect(h.events()).toEqual(["hazard_retreat_started", "hazard_retreat_failed"]);
		expect(h.retreats).toEqual([]);
	});

	test("a retreat that fails to dock is reported as failed", async () => {
		const h = makeHarness({
			loopStatus: MINING,
			retreatResult: {
				success: false,
				message: "route blocked",
				alreadySatisfied: false,
				ticksUsed: 1,
			},
		});

		await quietly(async () => {
			h.reactor.handle("p1", warning(380));
			await h.settle();
		});

		expect(h.events()).toEqual(["hazard_retreat_started", "hazard_retreat_failed"]);
	});
});
