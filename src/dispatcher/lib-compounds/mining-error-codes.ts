/**
 * Server error codes from a rejected `mine()` that mean "this belt/POI can no
 * longer be mined productively right now" — the mining loop should stop
 * attempting to mine here and move to sell/relocate, the same as a fully
 * exhausted deposit.
 *
 * Includes the original fully-depleted case (`depleted`) alongside
 * gameserver v0.463.0's vein-density precision limit (`deposit_too_sparse`,
 * shipped 2026-07-02) — a high-power mining array can't get a lock on a
 * sparse deposit's remaining stock, which is functionally the same "move on"
 * signal even though the deposit isn't literally empty — plus the
 * pre-existing `no_common_ores`/`no_resources` cases (a strip miner with no
 * common ore here / a POI with no resources at all).
 */
export const MINING_DEPLETION_CODES: ReadonlySet<string> = new Set([
	"depleted",
	"deposit_too_sparse",
	"no_common_ores",
	"no_resources",
]);

const DEPLETION_MARKER = "[mining-depleted]";

/**
 * Build a GoalResult message for a depletion-family `mine()` rejection. Uses
 * a marker setpoint itself controls, not the server's free-text message, so
 * `isDepletionMessage` matches on the error CODE (checked once, here, where
 * the SpacemoltError is caught) rather than on wording the server can — and
 * has — changed without notice. The server's original message is still
 * appended for logging/debugging, just not relied on for detection.
 */
export function formatDepletionMessage(code: string, serverMessage: string): string {
	return `${DEPLETION_MARKER} (${code}): ${serverMessage}`;
}

/** Whether a composed GoalResult.message indicates a depletion-family mine() rejection (see formatDepletionMessage). */
export function isDepletionMessage(message: string): boolean {
	return message.includes(DEPLETION_MARKER);
}
