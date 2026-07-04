import { describe, expect, test } from "bun:test";
import type { GameState } from "@spacemolt/lib";
import { diffGameState } from "../../src/state/state-diff.js";

describe("diffGameState", () => {
	test("returns nothing when nothing changed", () => {
		const state = { player: { credits: 100 } } as unknown as GameState;
		expect(diffGameState(state, state)).toEqual([]);
	});

	test("flags a scalar field that changed within a section", () => {
		const before = { player: { credits: 100 } } as unknown as GameState;
		const after = { player: { credits: 150 } } as unknown as GameState;

		const drifts = diffGameState(before, after);

		expect(drifts).toEqual([{ section: "player", path: "credits", before: 100, after: 150 }]);
	});

	test("flags a nested field, building a dotted path", () => {
		const before = { location: { poi: { id: "a" } } } as unknown as GameState;
		const after = { location: { poi: { id: "b" } } } as unknown as GameState;

		const drifts = diffGameState(before, after);

		expect(drifts).toEqual([{ section: "location", path: "poi.id", before: "a", after: "b" }]);
	});

	test("flags an added field (before undefined)", () => {
		const before = { cargo: {} } as unknown as GameState;
		const after = { cargo: { used: 10 } } as unknown as GameState;

		const drifts = diffGameState(before, after);

		expect(drifts).toEqual([{ section: "cargo", path: "used", before: undefined, after: 10 }]);
	});

	test("flags a section that is a whole array changing, without a path", () => {
		const before = { missions: [{ id: "m1", status: "active" }] } as unknown as GameState;
		const after = { missions: [{ id: "m1", status: "completed" }] } as unknown as GameState;

		const drifts = diffGameState(before, after);

		expect(drifts).toEqual([
			{
				section: "missions",
				path: "",
				before: [{ id: "m1", status: "active" }],
				after: [{ id: "m1", status: "completed" }],
			},
		]);
	});

	test("does not flag a section present in both with identical content", () => {
		const state1 = { ship: { hull: 40, max_hull: 40 } } as unknown as GameState;
		const state2 = { ship: { hull: 40, max_hull: 40 } } as unknown as GameState;

		expect(diffGameState(state1, state2)).toEqual([]);
	});

	test("only reports the sections that actually differ", () => {
		const before = {
			player: { credits: 100 },
			ship: { hull: 40 },
		} as unknown as GameState;
		const after = {
			player: { credits: 100 },
			ship: { hull: 35 },
		} as unknown as GameState;

		const drifts = diffGameState(before, after);

		expect(drifts).toEqual([{ section: "ship", path: "hull", before: 40, after: 35 }]);
	});
});
