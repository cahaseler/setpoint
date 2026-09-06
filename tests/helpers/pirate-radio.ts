import type { PirateRadioEvent } from "@setpoint/protocol";

/**
 * A complete `PirateRadioEvent` for tests.
 *
 * The server's transmission payload carries a large set of required editorial
 * and faction fields that no test cares about individually. Building them here
 * once keeps each test's fixture down to the fields it is actually asserting
 * on, and means a future field addition is a one-line change rather than a
 * hunt through every pirate-radio test.
 */
export function makePirateRadioEvent(over: Partial<PirateRadioEvent> = {}): PirateRadioEvent {
	return {
		category: "ambient",
		discord_policy: "never",
		editorial_class: "ambient",
		event_key: "ambient_chatter",
		faction_key: "blackvane",
		faction_name: "Blackvane Reavers",
		flagship_ship_class: "raider",
		message: "we ride at dawn",
		pirate_name: "Blackvane",
		primary_color: "#000000",
		secondary_color: "#ffffff",
		source_poi: "sol_belt",
		source_system: "sol",
		speaker_category: "captain",
		speaker_id: "blackvane-01",
		...over,
	};
}
