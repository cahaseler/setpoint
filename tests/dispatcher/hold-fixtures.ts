import type { NotificationHoldUpdate } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";

/**
 * A customs refusal in the live wording. The game documents no code for it,
 * so code under test must not depend on this one.
 */
export function customsRefusal(action = "dock"): SpacemoltError {
	return new SpacemoltError(
		"hold_refused",
		`[CUSTOMS] Pact Border I - The Rampart Checkpoint holds you with a warp scrambler for a customs inspection, so you cannot ${action}. The hold ends when the inspection ends.`,
	);
}

/** A `hold_update` push in which pid-a is the held pilot. */
export function holdUpdate(
	event: "started" | "ended",
	source: NotificationHoldUpdate["source"] = "customs",
): NotificationHoldUpdate {
	return {
		event,
		holder_id: "npc-customs",
		holder_name: "Pact Border I",
		message: "Customs inspection",
		source,
		start_tick: 100,
		target_id: "pid-a",
		target_name: "Alpha",
		...(event === "ended" ? { reason: "scan_over" as const } : {}),
	};
}
