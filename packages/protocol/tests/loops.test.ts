import { expect, test } from "bun:test";
import { type LoopOptionsMap, type LoopType, loopPatchSchemas, loopSchemas } from "../src/loops.js";

test("mining loop requires the belt+sell coords", () => {
	expect(() => loopSchemas.mining.parse({})).toThrow();
	const ok = loopSchemas.mining.parse({
		miningSystemId: "sol",
		beltPoiId: "b",
		sellSystemId: "sol",
		sellStationPoiId: "s",
		sellBaseId: "base",
	});
	expect(ok.miningSystemId).toBe("sol");
});

test("mining loop accepts optional fields (depositTarget, cashSource, listPrices)", () => {
	const ok = loopSchemas.mining.parse({
		miningSystemId: "sol",
		beltPoiId: "b",
		sellSystemId: "sol",
		sellStationPoiId: "s",
		sellBaseId: "base",
		repair: true,
		depositTarget: "faction",
		skipMarket: true,
		cashSource: "faction",
		minCredits: 1000,
		listPrice: 5,
		retryOnDepleted: true,
		maxIterations: 10,
	});
	expect(ok.depositTarget).toBe("faction");
	expect(() => loopSchemas.mining.parse({ ...ok, depositTarget: "not-real" })).toThrow();
	expect(() => loopSchemas.mining.parse({ ...ok, cashSource: "personal" })).toThrow();
});

test("mining loop listPrices accepts object or JSON string", () => {
	const withObj = loopSchemas.mining.parse({
		miningSystemId: "sol",
		beltPoiId: "b",
		sellSystemId: "sol",
		sellStationPoiId: "s",
		sellBaseId: "base",
		listPrices: { iron_ore: 5 },
	});
	expect(withObj.listPrices).toEqual({ iron_ore: 5 });
	const withString = loopSchemas.mining.parse({
		miningSystemId: "sol",
		beltPoiId: "b",
		sellSystemId: "sol",
		sellStationPoiId: "s",
		sellBaseId: "base",
		listPrices: '{"iron_ore":5}',
	});
	expect(withString.listPrices).toBe('{"iron_ore":5}');
});

test("enhanced-mining requires junkItemIds string array", () => {
	expect(() =>
		loopSchemas["enhanced-mining"].parse({
			miningSystemId: "sol",
			beltPoiId: "b",
			sellSystemId: "sol",
			sellStationPoiId: "s",
			sellBaseId: "base",
		}),
	).toThrow();
	const ok = loopSchemas["enhanced-mining"].parse({
		miningSystemId: "sol",
		beltPoiId: "b",
		sellSystemId: "sol",
		sellStationPoiId: "s",
		sellBaseId: "base",
		junkItemIds: ["stone", "ice"],
		maxJettisonRounds: 3,
	});
	expect(ok.junkItemIds).toEqual(["stone", "ice"]);
});

test("salvage loop basic shape", () => {
	const ok = loopSchemas.salvage.parse({
		salvageSystemId: "sol",
		salvagePoiId: "wreck-1",
		sellSystemId: "sol",
		sellStationPoiId: "s",
		sellBaseId: "base",
	});
	expect(ok.salvagePoiId).toBe("wreck-1");
});

test("roaming-salvage loop basic shape", () => {
	const ok = loopSchemas["roaming-salvage"].parse({
		homeSystemId: "sol",
		homeStationPoiId: "s",
		homeBaseId: "base",
		allowLawless: true,
		maxLootAttempts: 3,
	});
	expect(ok.maxLootAttempts).toBe(3);
});

test("tow-salvage requires mode 'fixed' and validates disposition/storageTarget enums", () => {
	expect(() =>
		loopSchemas["tow-salvage"].parse({
			yardSystemId: "sol",
			yardPoiId: "yard",
			yardBaseId: "base",
			wreckSystemId: "sol",
			wreckPoiId: "wreck",
		}),
	).toThrow();
	const ok = loopSchemas["tow-salvage"].parse({
		mode: "fixed",
		yardSystemId: "sol",
		yardPoiId: "yard",
		yardBaseId: "base",
		wreckSystemId: "sol",
		wreckPoiId: "wreck",
		disposition: "scrap",
		storageTarget: "personal",
	});
	expect(ok.mode).toBe("fixed");
	expect(() =>
		loopSchemas["tow-salvage"].parse({
			mode: "fixed",
			yardSystemId: "sol",
			yardPoiId: "yard",
			yardBaseId: "base",
			wreckSystemId: "sol",
			wreckPoiId: "wreck",
			disposition: "not-real",
		}),
	).toThrow();
});

test("trading loop nested stations + items", () => {
	const ok = loopSchemas.trading.parse({
		buyStation: { systemId: "a", poiId: "p", baseId: "b" },
		sellStation: { systemId: "c", stationPoiId: "sp", baseId: "sb" },
		items: [{ itemId: "ore", maxBuyPrice: 5, minSellPrice: 9 }],
	});
	expect(ok.items[0]?.minSellPrice).toBe(9);
	expect(() =>
		loopSchemas.trading.parse({
			buyStation: { systemId: "a", poiId: "p", baseId: "b" },
			sellStation: { systemId: "c", stationPoiId: "sp", baseId: "sb" },
			items: [],
		}),
	).toThrow();
});

test("hauling loop nested source/destination + gift requires targetPlayer", () => {
	const ok = loopSchemas.hauling.parse({
		source: {
			systemId: "a",
			poiId: "p",
			baseId: "b",
			type: "personal-storage",
			items: [{ itemId: "ore", quantity: 10 }],
		},
		destination: {
			systemId: "c",
			poiId: "q",
			baseId: "d",
			type: "faction-storage",
		},
	});
	expect(ok.source.type).toBe("personal-storage");

	expect(() =>
		loopSchemas.hauling.parse({
			source: {
				systemId: "a",
				poiId: "p",
				baseId: "b",
				type: "personal-storage",
				items: [{ itemId: "ore" }],
			},
			destination: {
				systemId: "c",
				poiId: "q",
				baseId: "d",
				type: "gift",
			},
		}),
	).toThrow();

	const withGift = loopSchemas.hauling.parse({
		source: {
			systemId: "a",
			poiId: "p",
			baseId: "b",
			type: "market",
			items: [{ itemId: "ore", maxPrice: 5 }],
		},
		destination: {
			systemId: "c",
			poiId: "q",
			baseId: "d",
			type: "gift",
			targetPlayer: "Someone",
		},
	});
	expect(withGift.destination.targetPlayer).toBe("Someone");
});

test("storage-transfer loop basic shape", () => {
	const ok = loopSchemas["storage-transfer"].parse({
		systemId: "sol",
		stationPoiId: "s",
		baseId: "base",
		excludeCredits: true,
	});
	expect(ok.excludeCredits).toBe(true);
});

test("exploration loop basic shape", () => {
	const ok = loopSchemas.exploration.parse({
		systemId: "sol",
		stationPoiId: "s",
		baseId: "base",
		survey: true,
		minSubmittedAtTick: 100,
	});
	expect(ok.survey).toBe(true);
});

test("guard loop basic shape with independent cashSource/minCredits", () => {
	const ok = loopSchemas.guard.parse({
		homeSystemId: "sol",
		homeStationPoiId: "s",
		homeBaseId: "base",
		guardSystemId: "sol",
		guardPoiId: "poi",
		minCredits: 500,
	});
	expect(ok.minCredits).toBe(500);
});

test("LoopType covers all 10", () => {
	expect(Object.keys(loopSchemas).length).toBe(10);
});

test("patch is a flat partial", () => {
	expect(loopPatchSchemas.mining.parse({ fullThreshold: 0.9 })).toEqual({ fullThreshold: 0.9 });
	expect(loopPatchSchemas.trading.parse({ refuel: true })).toEqual({ refuel: true });
});

// Compile-time check: LoopOptionsMap["mining"] has miningSystemId: string.
const _t: LoopOptionsMap["mining"] = {
	miningSystemId: "sol",
	beltPoiId: "b",
	sellSystemId: "sol",
	sellStationPoiId: "s",
	sellBaseId: "base",
};
const _lt: LoopType = "guard";
void _t;
void _lt;
