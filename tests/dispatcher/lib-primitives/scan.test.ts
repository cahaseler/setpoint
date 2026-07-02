import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibScan } from "../../../src/dispatcher/lib-primitives/scan.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("LibScan", () => {
	test("fails when docked", async () => {
		const account = new FakeLibGoalAccount({ location: { docked_at: "station-1" } });
		const result = await new LibScan().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be undocked");
		expect(account.calls).toHaveLength(0);
	});

	test("scans and succeeds", async () => {
		const account = new FakeLibGoalAccount(
			{ location: {} },
			{
				scan: () => ({
					command: "scan",
					tick: 0,
					delta: {
						details: {
							success: true,
							revealed_info: ["cloaked ship detected"],
							target_id: "self",
						},
					},
				}),
			},
		);
		const result = await new LibScan().execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("1 info revealed");
	});

	test("fails when scan reports no success", async () => {
		const account = new FakeLibGoalAccount(
			{ location: {} },
			{
				scan: () => ({
					command: "scan",
					tick: 0,
					delta: { details: { success: false, revealed_info: [], target_id: "self" } },
				}),
			},
		);
		const result = await new LibScan().execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Scan failed");
	});
});
