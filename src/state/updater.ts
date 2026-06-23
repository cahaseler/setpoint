import type { components } from "../generated/api-types.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import type { StateSectionKey, StateStore } from "./store.js";

const log = createLogger("state-updater");

type V2GameState = components["schemas"]["V2GameState"];

/** Remove keys with undefined values from an object. */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

/** Emitted when a state section changes. */
export interface StateChangeEvent {
	accountId: string;
	sections: StateSectionKey[];
	state: V2GameState;
}

/** Listener for state change events. */
export type StateChangeListener = (event: StateChangeEvent) => void;

/**
 * Processes API responses and updates the state store.
 *
 * Every mutation response contains a V2GameState with partial updates.
 * The updater extracts the state, merges it into the store, and emits
 * change events so the dispatcher can react.
 */
export class StateUpdater {
	private readonly store: StateStore;
	private readonly listeners: StateChangeListener[] = [];

	constructor(store: StateStore) {
		this.store = store;
	}

	/** Register a listener for state changes. Returns an unsubscribe function. */
	onStateChange(listener: StateChangeListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	/**
	 * Process a structuredContent response from the API.
	 *
	 * If the content contains game state fields (player, ship, cargo, etc.),
	 * they are merged into the store and a change event is emitted.
	 *
	 * Returns the list of sections that were updated, or an empty array
	 * if the response contained no state data.
	 */
	processResponse(accountId: string, structuredContent: unknown): StateSectionKey[] {
		if (!structuredContent || typeof structuredContent !== "object") {
			return [];
		}

		// Try to extract V2GameState fields from the response.
		// Not all responses contain state data — queries like find_route
		// return action-specific data without state updates.
		const state = structuredContent as V2GameState;
		const updatedSections = this.store.applyUpdate(accountId, state);

		// Travel responses carry location changes outside the V2GameState shape:
		// the destination poi and whether the ship was auto-undocked in transit.
		// Merge them into the stored location so poi_id and docked_at stay
		// accurate between full state refreshes.
		const travelSections = this.applyTravelLocation(
			accountId,
			structuredContent as Record<string, unknown>,
		);
		for (const section of travelSections) {
			if (!updatedSections.includes(section)) {
				updatedSections.push(section);
			}
		}

		if (updatedSections.length > 0) {
			log.debug(`State updated for ${accountId}: ${updatedSections.join(", ")}`);
			this.emit({
				accountId,
				sections: updatedSections,
				state,
			});
		}

		return updatedSections;
	}

	/**
	 * Merge a travel response's location effects into the stored location.
	 *
	 * The store replaces sections wholesale, so the existing location is read
	 * and merged rather than written partially. auto_docked is not mapped —
	 * the response does not say which base the ship docked at, so the next
	 * full state refresh fills that in.
	 */
	private applyTravelLocation(
		accountId: string,
		content: Record<string, unknown>,
	): StateSectionKey[] {
		if (content["action"] !== "travel" || typeof content["poi_id"] !== "string") {
			return [];
		}

		const existing = this.store.getState(accountId)?.location ?? {};
		const location: Record<string, unknown> = {
			...existing,
			poi_id: content["poi_id"],
		};
		if (typeof content["poi"] === "string") {
			location["poi_name"] = content["poi"];
		}
		if (content["auto_undocked"] === true) {
			location["docked_at"] = null;
		}

		return this.store.applyUpdate(accountId, { location } as V2GameState);
	}

	/**
	 * Process a login response, which contains full initial state.
	 *
	 * Login responses have a different structure — player, ship, system, poi
	 * are at the top level rather than nested under V2GameState keys.
	 * This method maps them to the state store format.
	 */
	processLoginResponse(
		accountId: string,
		loginResponse: components["schemas"]["LoginResponse"],
	): StateSectionKey[] {
		// Build state as a plain Record to avoid exactOptionalPropertyTypes
		// issues when assigning to V2GameState's optional properties.
		const state: Record<string, unknown> = {};

		if (loginResponse.player) {
			state["player"] = stripUndefined({
				id: loginResponse.player.id,
				username: loginResponse.player.username,
				empire: loginResponse.player.empire,
				credits: loginResponse.player.credits,
				faction_id: loginResponse.player.faction_id,
				faction_rank: loginResponse.player.faction_rank,
				home_base: loginResponse.player.home_base,
				is_cloaked: loginResponse.player.is_cloaked,
				primary_color: loginResponse.player.primary_color,
				secondary_color: loginResponse.player.secondary_color,
				status_message: loginResponse.player.status_message,
				clan_tag: loginResponse.player.clan_tag,
			});
		}

		if (loginResponse.ship) {
			state["ship"] = stripUndefined({
				id: loginResponse.ship.id,
				class_id: loginResponse.ship.class_id,
				name: loginResponse.ship.name,
				hull: loginResponse.ship.hull,
				max_hull: loginResponse.ship.max_hull,
				fuel: loginResponse.ship.fuel,
				max_fuel: loginResponse.ship.max_fuel,
				shield: loginResponse.ship.shield,
				max_shield: loginResponse.ship.max_shield,
				shield_recharge: loginResponse.ship.shield_recharge,
				armor: loginResponse.ship.armor,
				cargo_capacity: loginResponse.ship.cargo_capacity,
				cargo_used: loginResponse.ship.cargo_used,
				speed: loginResponse.ship.speed,
				weapon_slots: loginResponse.ship.weapon_slots,
				defense_slots: loginResponse.ship.defense_slots,
				utility_slots: loginResponse.ship.utility_slots,
				cpu_capacity: loginResponse.ship.cpu_capacity,
				cpu_used: loginResponse.ship.cpu_used,
				power_capacity: loginResponse.ship.power_capacity,
				power_used: loginResponse.ship.power_used,
			});

			// Ship.CargoItem only has item_id + quantity; V2GameState cargo
			// adds item_name + size. Provide defaults for the missing fields.
			if (loginResponse.ship.cargo) {
				state["cargo"] = loginResponse.ship.cargo.map((item) => ({
					item_id: item.item_id,
					item_name: item.item_id,
					quantity: item.quantity,
					size: 1,
				}));
			}
		}

		if (loginResponse.system) {
			const loc: Record<string, unknown> = {
				system_id: loginResponse.system.id,
				system_name: loginResponse.system.name,
			};
			if (loginResponse.system.empire !== undefined) {
				loc["empire"] = loginResponse.system.empire;
			}
			if (loginResponse.poi) {
				loc["poi_id"] = loginResponse.poi.id;
				loc["poi_name"] = loginResponse.poi.name;
				loc["poi_type"] = loginResponse.poi.type;
			}
			// Map docked status from player data
			if (loginResponse.player?.docked_at_base) {
				loc["docked_at"] = loginResponse.player.docked_at_base;
			}
			state["location"] = loc;
		}

		return this.store.applyUpdate(accountId, state as V2GameState);
	}

	private emit(event: StateChangeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				log.error(`State change listener error: ${errorMessage(err)}`);
			}
		}
	}
}
