import { describe, expect, test } from "bun:test";
import { fleetOperation, reconciled } from "../../src/dispatcher/goals.js";
import type {
	GoalResult,
	ReconcileSubjectFailed,
	ReconcileSubjectOk,
} from "../../src/dispatcher/goals.js";

const subject = (over: Partial<ReconcileSubjectOk> = {}): ReconcileSubjectOk => ({
	id: "mod-1",
	kind: "weapon",
	ok: true,
	action: "updated",
	...over,
});

/**
 * A failed subject must carry both a reason and the state actually observed —
 * the type enforces it, so this helper cannot omit `before`.
 */
const failedSubject = (
	over: Partial<ReconcileSubjectFailed> & { message: string; before: Record<string, unknown> },
): ReconcileSubjectFailed => ({
	id: "mod-1",
	kind: "weapon",
	action: "none",
	...over,
	ok: false,
});

describe("reconciled", () => {
	test("succeeds only when every subject is ok", () => {
		const result = reconciled([subject(), subject({ id: "mod-2" })], 2);
		expect(result.success).toBe(true);
		expect(result.summary).toEqual({ total: 2, changed: 2, unchanged: 0, failed: 0 });
	});

	test("a single failed subject fails the whole result", () => {
		// The W1 case: four guns reloaded, one left empty. The goal must not
		// report success just because it did most of the work.
		const subjects = [
			subject({ id: "gun-1" }),
			subject({ id: "gun-2" }),
			subject({ id: "gun-3" }),
			subject({ id: "gun-4" }),
			failedSubject({
				id: "gun-5",
				message: "insufficient_cargo: slug_case",
				before: { ammo: 0, capacity: 7, ammoType: "tungsten_slug_case" },
			}),
		];
		const result = reconciled(subjects, 4);
		expect(result.success).toBe(false);
		expect(result.summary.failed).toBe(1);
		expect(result.message).toContain("gun-5");
		expect(result.message).toContain("insufficient_cargo");
	});

	test("is alreadySatisfied only when nothing changed and nothing failed", () => {
		const result = reconciled(
			[subject({ action: "none" }), subject({ id: "m2", action: "none" })],
			0,
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.success).toBe(true);
		expect(result.message).toBe("All 2 already correct");
	});

	test("is not alreadySatisfied when a subject failed without changing anything", () => {
		const result = reconciled(
			[failedSubject({ message: "in_combat", before: { inCombat: true, battleId: "b-1" } })],
			0,
		);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.success).toBe(false);
	});

	test("no subjects is a satisfied no-op", () => {
		const result = reconciled([], 0);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.summary.total).toBe(0);
	});

	test("a failed subject reports the state actually observed, not just a reason", () => {
		// Craig's rule: the likeliest cause of a failure is that the caller's
		// model of the ship is wrong, so the result must surface reality and
		// force a reconcile rather than let the caller assume it was intentional.
		const result = reconciled(
			[
				failedSubject({
					id: "ILC-Tephra",
					kind: "member",
					message: "not_at_poi",
					desired: { poiId: "arena" },
					before: { systemId: "keelbreak", poiId: null, inTransit: true, arrivalTick: 84212 },
				}),
			],
			0,
		);
		const [only] = result.subjects;
		expect(only?.ok).toBe(false);
		expect(only?.before).toEqual({
			systemId: "keelbreak",
			poiId: null,
			inTransit: true,
			arrivalTick: 84212,
		});
		expect(only?.desired).toEqual({ poiId: "arena" });
	});

	test("carries ship-level facts in context, not in a subject", () => {
		const result = reconciled([subject()], 1, {
			context: { hold: { capacity: 55, usedBefore: 10, usedAfter: 20 } },
		});
		expect(result.context).toEqual({ hold: { capacity: 55, usedBefore: 10, usedAfter: 20 } });
	});

	test("an explicit message overrides the derived one but not the verdict", () => {
		const result = reconciled(
			[
				failedSubject({
					message: "not_at_poi",
					before: { systemId: "sol", poiId: undefined, inTransit: true },
				}),
			],
			0,
			{ message: "custom" },
		);
		expect(result.message).toBe("custom");
		expect(result.success).toBe(false);
	});
});

describe("fleetOperation", () => {
	const ok = (message = "done"): GoalResult => ({
		success: true,
		message,
		alreadySatisfied: false,
		ticksUsed: 1,
	});
	const bad = (message: string): GoalResult => ({
		success: false,
		message,
		alreadySatisfied: false,
		ticksUsed: 0,
	});

	test("succeeds only when every account succeeded", () => {
		const result = fleetOperation({ "player-1": ok(), "player-2": ok() }, 2);
		expect(result.success).toBe(true);
		expect(result.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
	});

	test("names the failing accounts in the message", () => {
		const result = fleetOperation({ "player-1": ok(), "player-2": bad("busy:mining-loop") }, 1);
		expect(result.success).toBe(false);
		expect(result.summary.failed).toBe(1);
		expect(result.message).toContain("player-2");
		expect(result.message).toContain("busy:mining-loop");
	});

	test("is alreadySatisfied only when every account was", () => {
		const satisfied: GoalResult = {
			success: true,
			message: "",
			alreadySatisfied: true,
			ticksUsed: 0,
		};
		expect(fleetOperation({ a: satisfied, b: satisfied }, 0).alreadySatisfied).toBe(true);
		expect(fleetOperation({ a: satisfied, b: ok() }, 0).alreadySatisfied).toBe(false);
	});

	test("no accounts is a satisfied no-op", () => {
		const result = fleetOperation({}, 0);
		expect(result.success).toBe(true);
		expect(result.summary.total).toBe(0);
	});
});
