import type { ApiResponse } from "../api/client.js";
import type { BulkOrderResponse, BulkStorageResponse } from "../api/endpoints.js";
import type { Logger } from "../util/logger.js";

/** Tally of real successes and failures from a bulk operation. */
export interface BulkOutcome {
	succeeded: number;
	failed: number;
}

/**
 * Count real successes and failures in a bulk order response.
 *
 * For create operations, a result reporting `success: true` but no `order_id`
 * is a real failure: the game server escrows then returns the items when the
 * player can't afford the listing fee, so the order never actually exists.
 */
export function countBulkOrderResults(
	response: ApiResponse<BulkOrderResponse>,
	operation: string,
	log: Logger,
): BulkOutcome {
	const bulk = response.structuredContent;
	if (!bulk.results) {
		// Non-bulk response (single order) — assume success
		return { succeeded: 1, failed: 0 };
	}
	const isCreate = operation.startsWith("create");
	let succeeded = 0;
	let failed = 0;
	for (const result of bulk.results) {
		if (!result.success) {
			log.warn(
				`Bulk ${operation} order #${result.index} failed: ${result.error_code ?? "unknown"} — ${result.error ?? "no details"}`,
			);
			failed++;
		} else if (isCreate && !result.order_id) {
			log.warn(
				`Bulk ${operation} order #${result.index} reported success but no order_id — order was not actually created (${result.message ?? "no details"})`,
			);
			failed++;
		} else {
			succeeded++;
		}
	}
	if (failed > 0) {
		log.warn(
			`Bulk ${operation}: ${succeeded} succeeded, ${failed} failed out of ${bulk.results.length}`,
		);
	}
	return { succeeded, failed };
}

/** Count real successes and failures in a bulk storage deposit/withdraw response. */
export function countBulkStorageResults(
	response: ApiResponse<BulkStorageResponse>,
	operation: string,
	log: Logger,
): BulkOutcome {
	const bulk = response.structuredContent;
	if (!bulk.results) {
		// Non-bulk response (single item) — assume success
		return { succeeded: 1, failed: 0 };
	}
	let succeeded = 0;
	let failed = 0;
	for (const result of bulk.results) {
		if (result.success) {
			succeeded++;
		} else {
			log.warn(
				`Bulk ${operation} ${result.item_id} failed: ${result.error ?? result.message ?? "no details"}`,
			);
			failed++;
		}
	}
	if (failed > 0) {
		log.warn(
			`Bulk ${operation}: ${succeeded} succeeded, ${failed} failed out of ${bulk.results.length}`,
		);
	}
	return { succeeded, failed };
}
