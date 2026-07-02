import type { components } from "../../src/generated/api-types.js";

type V2Response = components["schemas"]["V2Response"];

/**
 * Helper to build a V2Response envelope.
 * Uses type assertion since test fixtures intentionally provide partial data.
 */
export function makeV2Response(overrides: Partial<V2Response> = {}): V2Response {
	const response: Record<string, unknown> = {
		result: overrides.result ?? "OK",
		structuredContent: overrides.structuredContent ?? {},
		notifications: overrides.notifications ?? [],
		session: overrides.session ?? {
			id: "test-session-id",
			player_id: "test-player-id",
			created_at: "2026-02-19T00:00:00Z",
			expires_at: "2026-02-19T00:30:00Z",
		},
	};

	if (overrides.error) {
		response["error"] = overrides.error;
	}

	return response as V2Response;
}

/** Minimal session creation response (no player_id yet). */
export function makeSessionResponse(sessionId = "test-session-id"): V2Response {
	return makeV2Response({
		session: {
			id: sessionId,
			created_at: "2026-02-19T00:00:00Z",
			expires_at: "2026-02-19T00:30:00Z",
		},
	});
}

/** Minimal login response structuredContent. */
export function makeLoginStructuredContent(): components["schemas"]["LoginResponse"] {
	return {
		message: "Welcome back, TestPlayer!",
		player: {
			id: "test-player-id",
			username: "TestPlayer",
			empire: "solarian",
			credits: 1000,
			clan_tag: "",
			created_at: "2026-01-01T00:00:00Z",
			current_poi: "sol-station",
			current_ship_id: "test-ship-id",
			current_system: "sol",
			experience: 0,
			home_base: "sol-station",
			is_cloaked: false,
			last_active_at: "2026-01-01T00:00:00Z",
			last_chat_check: "2026-01-01T00:00:00Z",
			last_command_at: "2026-01-01T00:00:00Z",
			last_login_at: "2026-01-01T00:00:00Z",
			primary_color: "#ffffff",
			secondary_color: "#000000",
			skill_xp: {},
			skills: {},
			stats: {
				bases_destroyed: 0,
				battles_fled: 0,
				battles_started: 0,
				captains_log_entries: 0,
				chat_messages_sent: 0,
				cloak_activations: 0,
				consumables_used: 0,
				contraband_sold: 0,
				credits_earned: 0,
				credits_earned_taxable: 0,
				credits_earned_taxable_snapshot: 0,
				credits_gifted: 0,
				credits_spent: 0,
				customs_evaded: 0,
				damage_dealt: 0,
				damage_taken: 0,
				deaths_by_pirate: 0,
				deaths_by_player: 0,
				deaths_by_self_destruct: 0,
				deep_core_pois_discovered: 0,
				distance_traveled: 0,
				exchange_credits_earned: 0,
				exchange_items_bought: 0,
				exchange_items_sold: 0,
				facilities_built: 0,
				facility_items_produced: 0,
				forum_posts_created: 0,
				gifts_received: 0,
				gifts_sent: 0,
				insurance_claims_made: 0,
				insurance_payouts_received: 0,
				insurance_policies_bought: 0,
				items_crafted: 0,
				items_jettisoned: 0,
				jumps_completed: 0,
				missions_abandoned: 0,
				missions_accepted: 0,
				missions_completed: 0,
				modules_installed: 0,
				npcs_destroyed: 0,
				ore_mined: 0,
				pirates_destroyed: 0,
				prayer_distance_traveled: 0,
				refuels_given: 0,
				repairs_given: 0,
				scans_performed: 0,
				self_destructs: 0,
				ships_commissioned: 0,
				ships_destroyed: 0,
				ships_lost: 0,
				ships_purchased: 0,
				systems_explored: 0,
				time_played: 0,
				times_docked: 0,
				trades_completed: 0,
				void_drifts: 0,
				wormholes_traversed: 0,
				wreck_items_looted: 0,
				wrecks_scrapped: 0,
				wrecks_sold: 0,
			},
			status_message: "",
		},
		ship: {
			id: "test-ship-id",
			class_id: "scout",
			name: "Test Scout",
			armor: 0,
			cargo: [],
			cargo_capacity: 20,
			cargo_used: 0,
			cpu_capacity: 0,
			cpu_used: 0,
			created_at: "2026-01-01T00:00:00Z",
			defense_slots: 0,
			fuel: 50,
			gas_cargo_efficiency: 1,
			hull: 100,
			ice_cargo_efficiency: 1,
			ore_cargo_efficiency: 1,
			max_fuel: 50,
			max_hull: 100,
			max_shield: 0,
			modules: [],
			owner_id: "test-player-id",
			power_capacity: 0,
			power_used: 0,
			shield: 0,
			shield_recharge: 0,
			speed: 0,
			utility_slots: 0,
			weapon_slots: 0,
		},
		system: {
			id: "sol",
			name: "Sol",
			empire: "solarian",
			police_level: 5,
			connections: [{ system_id: "alpha-centauri", name: "Alpha Centauri" }],
			pois: [],
		},
		poi: {
			id: "sol-station",
			name: "Sol Station",
			type: "station",
			fuel_reserve: 0,
			has_base: false,
			online: 0,
			position: { x: 0, y: 0 },
		},
		pending_trades: [],
	};
}

/** Minimal login V2Response. */
export function makeLoginResponse(
	playerId = "test-player-id",
	sessionId = "test-session-id",
): V2Response {
	return makeV2Response({
		structuredContent: makeLoginStructuredContent() as unknown as Record<string, never>,
		session: {
			id: sessionId,
			player_id: playerId,
			created_at: "2026-02-19T00:00:00Z",
			expires_at: "2026-02-19T00:30:00Z",
		},
	});
}

/** V2GameState for get_state response. */
export function makeGameStateContent(): components["schemas"]["V2GameState"] {
	return {
		player: {
			id: "test-player-id",
			username: "TestPlayer",
			credits: 1000,
			empire: "solarian",
		},
		ship: {
			id: "test-ship-id",
			class_id: "scout",
			class_name: "Scout",
			hull: 100,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
			cargo_capacity: 20,
			cargo_used: 0,
		},
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "sol-station",
			poi_name: "Sol Station",
			poi_type: "station",
			docked_at: "sol-station",
		},
		cargo: [],
	};
}

/** Error V2Response. */
export function makeErrorResponse(code: string, message: string): V2Response {
	return { error: { code, message } } as V2Response;
}

/** Rate limit response body (not a V2Response — returned on 429). */
export function makeRateLimitBody(
	message = "Too many requests",
	retryAfter = 30,
): { error: string; message: string; retry_after: number } {
	return {
		error: "rate_limited",
		message,
		retry_after: retryAfter,
	};
}

interface MockFetchCall {
	url: string;
	init: RequestInit | undefined;
}

/**
 * Creates a mock fetch function that responds with a sequence of responses.
 * Each call consumes the next response in the array.
 */
export function createMockFetch(
	responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): typeof globalThis.fetch & { calls: MockFetchCall[] } {
	const calls: MockFetchCall[] = [];
	let callIndex = 0;

	const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, init });

		const responseConfig = responses[callIndex];
		if (!responseConfig) {
			throw new Error(`Mock fetch: unexpected call #${callIndex + 1} to ${url}`);
		}
		callIndex++;

		const responseHeaders = new Headers(responseConfig.headers);
		if (responseConfig.body && !responseHeaders.has("Content-Type")) {
			responseHeaders.set("Content-Type", "application/json");
		}

		return new Response(
			responseConfig.body !== undefined ? JSON.stringify(responseConfig.body) : null,
			{
				status: responseConfig.status,
				headers: responseHeaders,
			},
		);
	}) as typeof globalThis.fetch & { calls: MockFetchCall[] };

	mockFetch.calls = calls;
	return mockFetch;
}
