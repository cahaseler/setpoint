import type { ApiResponse } from "../../src/api/client.js";
import type { GameEndpoints } from "../../src/api/endpoints.js";

type MockResponse<T> = ApiResponse<T>;

/**
 * Build a minimal ApiResponse wrapper for test data.
 */
function mockApiResponse<T>(structuredContent: T): MockResponse<T> {
	return {
		result: "OK",
		structuredContent,
		notifications: [],
		session: {
			id: "test-session",
			player_id: "test-player",
			created_at: "2026-01-01T00:00:00Z",
			expires_at: "2026-01-01T00:30:00Z",
		},
	};
}

type EndpointMethod = keyof GameEndpoints;

/**
 * Creates a mock GameEndpoints where each method can be configured
 * with a return value or left to throw "not mocked".
 */
export function createMockEndpoints(
	overrides: Partial<Record<EndpointMethod, (...args: unknown[]) => Promise<unknown>>> = {},
): GameEndpoints {
	const handler: ProxyHandler<Record<string, unknown>> = {
		get(_target, prop: string) {
			if (prop in overrides) {
				return overrides[prop as EndpointMethod];
			}
			return () => {
				throw new Error(`Endpoint ${prop} not mocked`);
			};
		},
	};

	return new Proxy({}, handler) as unknown as GameEndpoints;
}

export { mockApiResponse };
