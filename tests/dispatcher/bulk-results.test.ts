import { describe, expect, test } from "bun:test";
import type { ApiResponse } from "../../src/api/client.js";
import type { BulkOrderResponse, BulkStorageResponse } from "../../src/api/endpoints.js";
import {
	countBulkOrderResults,
	countBulkStorageResults,
} from "../../src/dispatcher/bulk-results.js";
import { createLogger } from "../../src/util/logger.js";

const log = createLogger("test");

function orderResponse(results: BulkOrderResponse["results"]): ApiResponse<BulkOrderResponse> {
	return {
		result: "OK",
		structuredContent: {
			action: "create_sell_order",
			mode: "bulk",
			results,
			summary: { succeeded: 0, failed: 0, total: results.length },
		},
		notifications: [],
		session: {
			id: "s",
			player_id: "p",
			created_at: "2026-01-01T00:00:00Z",
			expires_at: "2026-01-01T00:30:00Z",
		},
	};
}

function storageResponse(
	results: BulkStorageResponse["results"],
): ApiResponse<BulkStorageResponse> {
	return {
		result: "OK",
		structuredContent: {
			action: "deposit",
			requested: results.length,
			succeeded: results.filter((r) => r.success).length,
			failed: results.filter((r) => !r.success).length,
			results,
		},
		notifications: [],
		session: {
			id: "s",
			player_id: "p",
			created_at: "2026-01-01T00:00:00Z",
			expires_at: "2026-01-01T00:30:00Z",
		},
	};
}

describe("countBulkOrderResults", () => {
	test("counts successes with order_id", () => {
		const out = countBulkOrderResults(
			orderResponse([
				{ index: 0, success: true, order_id: "o1" },
				{ index: 1, success: true, order_id: "o2" },
			]),
			"create sell",
			log,
		);
		expect(out).toEqual({ succeeded: 2, failed: 0 });
	});

	test("counts explicit failures", () => {
		const out = countBulkOrderResults(
			orderResponse([
				{ index: 0, success: true, order_id: "o1" },
				{ index: 1, success: false, error_code: "insufficient_funds", error: "broke" },
			]),
			"create sell",
			log,
		);
		expect(out).toEqual({ succeeded: 1, failed: 1 });
	});

	test("treats create success without order_id as a failure (returned to storage)", () => {
		const out = countBulkOrderResults(
			orderResponse([
				{ index: 0, success: true, returned_to_storage: 20, message: "no fee" },
				{ index: 1, success: true, order_id: "o2" },
			]),
			"create sell",
			log,
		);
		expect(out).toEqual({ succeeded: 1, failed: 1 });
	});

	test("does not require order_id for non-create operations", () => {
		const out = countBulkOrderResults(
			orderResponse([
				{ index: 0, success: true },
				{ index: 1, success: true },
			]),
			"cancel",
			log,
		);
		expect(out).toEqual({ succeeded: 2, failed: 0 });
	});

	test("assumes single success when results missing", () => {
		const resp = orderResponse([]);
		// biome-ignore lint/suspicious/noExplicitAny: simulate a single-order (non-bulk) response
		(resp.structuredContent as any).results = undefined;
		expect(countBulkOrderResults(resp, "create sell", log)).toEqual({ succeeded: 1, failed: 0 });
	});
});

describe("countBulkStorageResults", () => {
	test("counts per-item successes and failures", () => {
		const out = countBulkStorageResults(
			storageResponse([
				{ item_id: "ore_iron", quantity: 20, success: true },
				{ item_id: "ore_copper", quantity: 10, success: false, error: "no room" },
			]),
			"deposit",
			log,
		);
		expect(out).toEqual({ succeeded: 1, failed: 1 });
	});

	test("counts all successes", () => {
		const out = countBulkStorageResults(
			storageResponse([
				{ item_id: "ore_iron", quantity: 20, success: true },
				{ item_id: "ore_copper", quantity: 10, success: true },
			]),
			"deposit",
			log,
		);
		expect(out).toEqual({ succeeded: 2, failed: 0 });
	});
});
