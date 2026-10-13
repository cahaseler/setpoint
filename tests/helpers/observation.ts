import type { ObservationUpdateEvent } from "@setpoint/protocol";

/**
 * A minimal `observation_update` frame. Defaults carry a pirate arrival — the
 * contact class the lib's merged `ObservationView` drops and the raw stream
 * exists to deliver.
 */
export function makeObservationUpdateEvent(
	overrides: Partial<ObservationUpdateEvent> = {},
): ObservationUpdateEvent {
	return {
		poi_id: "sol_asteroid_belt",
		system_id: "sol",
		tick: 1,
		unknown_signature: false,
		pirates_changed: [
			{
				pirate_id: "pirate_1",
				name: "Raider",
				is_boss: false,
				status: "hostile",
				tier: "raider",
				hull: 100,
				max_hull: 100,
				shield: 50,
				max_shield: 50,
			},
		],
		...overrides,
	} as ObservationUpdateEvent;
}
