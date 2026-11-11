import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HazardModeStore, parseHazardSetting } from "../../src/combat/hazard-mode-store.js";

describe("parseHazardSetting", () => {
	test("accepts retreat and external without a threshold", () => {
		expect(parseHazardSetting({ mode: "retreat" })).toEqual({ mode: "retreat" });
		expect(parseHazardSetting({ mode: "external" })).toEqual({ mode: "external" });
	});

	test("accepts tolerate with a hull floor from 0 to 100", () => {
		expect(parseHazardSetting({ mode: "tolerate", minHullPct: 40 })).toEqual({
			mode: "tolerate",
			minHullPct: 40,
		});
	});

	test("rejects tolerate without a usable threshold", () => {
		for (const minHullPct of [undefined, -1, 101, "40", Number.NaN]) {
			expect(typeof parseHazardSetting({ mode: "tolerate", minHullPct })).toBe("string");
		}
	});

	test("rejects a threshold on a mode it does not apply to, and unknown modes", () => {
		expect(typeof parseHazardSetting({ mode: "retreat", minHullPct: 40 })).toBe("string");
		expect(typeof parseHazardSetting({ mode: "flee" })).toBe("string");
		expect(typeof parseHazardSetting(null)).toBe("string");
	});
});

describe("HazardModeStore", () => {
	let dir: string | undefined;
	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("defaults every account to retreat", async () => {
		dir = await mkdtemp(join(tmpdir(), "hazard-"));
		const store = await HazardModeStore.load(dir);
		expect(store.get("p1")).toEqual({ mode: "retreat" });
	});

	test("a setting survives a reload, as it would a daemon restart", async () => {
		dir = await mkdtemp(join(tmpdir(), "hazard-"));
		const info = spyOn(console, "info").mockImplementation(() => {});
		const store = await HazardModeStore.load(dir);
		await store.set("p1", { mode: "tolerate", minHullPct: 35 });
		const reloaded = await HazardModeStore.load(dir);
		info.mockRestore();

		expect(reloaded.get("p1")).toEqual({ mode: "tolerate", minHullPct: 35 });
		expect(reloaded.get("p2")).toEqual({ mode: "retreat" });
	});
});
