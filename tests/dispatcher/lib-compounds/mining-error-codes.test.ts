import { describe, expect, test } from "bun:test";
import {
	MINING_DEPLETION_CODES,
	formatDepletionMessage,
	isDepletionMessage,
} from "../../../src/dispatcher/lib-compounds/mining-error-codes.js";

describe("mining-error-codes", () => {
	test("MINING_DEPLETION_CODES covers the known depletion-family error codes", () => {
		expect(MINING_DEPLETION_CODES.has("depleted")).toBe(true);
		expect(MINING_DEPLETION_CODES.has("deposit_too_sparse")).toBe(true);
		expect(MINING_DEPLETION_CODES.has("no_common_ores")).toBe(true);
		expect(MINING_DEPLETION_CODES.has("no_resources")).toBe(true);
		expect(MINING_DEPLETION_CODES.has("cargo_full")).toBe(false);
	});

	test("formatDepletionMessage produces a message isDepletionMessage recognizes", () => {
		const message = formatDepletionMessage("deposit_too_sparse", "Deposits here are too sparse");
		expect(isDepletionMessage(message)).toBe(true);
	});

	test("formatDepletionMessage's marker survives being wrapped in an outer message", () => {
		// Compounds/sequences compose failure messages via string concatenation
		// (e.g. "Mining run failed during mining: <this>") rather than
		// preserving a structured error code — the marker must still be found
		// after that wrapping.
		const inner = formatDepletionMessage("depleted", "Resources depleted");
		const wrapped = `Mining run failed during mining: ${inner}`;
		expect(isDepletionMessage(wrapped)).toBe(true);
	});

	test("isDepletionMessage is false for an unrelated failure message", () => {
		expect(isDepletionMessage("Mine rejected: Not at a mining site")).toBe(false);
	});
});
