import { describe, expect, test } from "bun:test";
import { LibFuelRescue } from "../../../src/dispatcher/lib-compounds/fuel-rescue.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibFuelRescue", () => {
	test("refuels the target when present at the POI", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{
				get_nearby: () => ({
					result: "",
					structuredContent: { nearby: [{ username: "Stranded" }] },
				}),
				refuel: () => fakeMutationResult("refuel"),
			},
		);
		const result = await new LibFuelRescue({
			systemId: "sol",
			poiId: "poi-1",
			targetUsername: "Stranded",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.message).toContain("Refueled Stranded");
		expect(account.calls.some((c) => c.action === "refuel")).toBe(true);
	});

	test("fails when the target player is not at the POI", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{
				get_nearby: () => ({ result: "", structuredContent: { nearby: [] } }),
			},
		);
		const result = await new LibFuelRescue({
			systemId: "sol",
			poiId: "poi-1",
			targetUsername: "Stranded",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("is not at POI");
		expect(account.calls.some((c) => c.action === "refuel")).toBe(false);
	});

	test("fails when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-0" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);
		const result = await new LibFuelRescue({
			systemId: "alpha",
			poiId: "poi-1",
			targetUsername: "Stranded",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("No route found");
	});
});
