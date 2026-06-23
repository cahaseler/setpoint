import { afterEach, describe, expect, test } from "bun:test";
import { SpaceMoltClient } from "../../src/api/client.js";
import { GameEndpoints } from "../../src/api/endpoints.js";
import { Session } from "../../src/api/session.js";
import {
	createMockFetch,
	makeGameStateContent,
	makeLoginResponse,
	makeSessionResponse,
	makeV2Response,
} from "../fixtures/api-responses.js";

describe("GameEndpoints", () => {
	const credentials = { username: "TestPlayer", password: "secret123" };
	const activeSessions: Session[] = [];

	afterEach(() => {
		for (const session of activeSessions) {
			session.disconnect();
		}
		activeSessions.length = 0;
	});

	/**
	 * Creates a connected session with additional mock responses queued
	 * after the initial connect (session create + login).
	 */
	async function createConnectedEndpoints(
		gameResponses: Parameters<typeof createMockFetch>[0],
	): Promise<{ endpoints: GameEndpoints; mockFetch: ReturnType<typeof createMockFetch> }> {
		const allResponses = [
			{ status: 200, body: makeSessionResponse() },
			{ status: 200, body: makeLoginResponse() },
			...gameResponses,
		];
		const mockFetch = createMockFetch(allResponses);
		const client = new SpaceMoltClient({
			baseUrl: "https://test.spacemolt.com",
			fetch: mockFetch,
		});
		const session = new Session(client, credentials, { keepaliveIntervalMs: 60_000 });
		activeSessions.push(session);

		await session.connect();

		const endpoints = new GameEndpoints(session);
		return { endpoints, mockFetch };
	}

	describe("navigation", () => {
		test("getState sends correct request", async () => {
			const stateContent = makeGameStateContent();
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{
					status: 200,
					body: makeV2Response({
						structuredContent: stateContent as unknown as Record<string, never>,
					}),
				},
			]);

			const result = await endpoints.getState();

			expect(result.structuredContent.player?.username).toBe("TestPlayer");
			expect(result.structuredContent.ship?.fuel).toBe(50);
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/get_state");
		});

		test("travel sends system ID", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{
					status: 200,
					body: makeV2Response({
						structuredContent: {
							action: "arrived",
							poi: "Alpha Station",
							poi_id: "alpha-station",
						} as unknown as Record<string, never>,
					}),
				},
			]);

			const result = await endpoints.travel("alpha-centauri");

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["id"]).toBe("alpha-centauri");
			expect(result.structuredContent.action).toBe("arrived");
		});

		test("dock sends base ID", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.dock("sol-station");

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["id"]).toBe("sol-station");
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/dock");
		});

		test("undock sends no params", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.undock();

			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/undock");
		});

		test("findRoute sends target system ID", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.findRoute("alpha-centauri");

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["id"]).toBe("alpha-centauri");
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/find_route");
		});
	});

	describe("commerce", () => {
		test("refuel sends quantity when provided", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.refuel(10);

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["quantity"]).toBe(10);
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/refuel");
		});
	});

	describe("ship management", () => {
		test("mine sends correct endpoint", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.mine();

			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/mine");
		});

		test("repair sends correct endpoint", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.repair();

			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/repair");
		});
	});

	describe("information", () => {
		test("searchSystems sends text parameter", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.searchSystems("Sol");

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["text"]).toBe("Sol");
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/search_systems");
		});

		test("getNearby sends correct endpoint", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.getNearby();

			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/get_nearby");
		});
	});

	describe("missions", () => {
		test("acceptMission sends mission ID", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: makeV2Response() },
			]);

			await endpoints.acceptMission("mission-42");

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["id"]).toBe("mission-42");
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/accept_mission");
		});
	});

	describe("combat", () => {
		test("reload sends weapon ID and ammo ID", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{
					status: 200,
					body: makeV2Response({
						structuredContent: {
							action: "reload",
							weapon_id: "weapon-1",
							weapon_name: "Plasma Cannon",
							ammo_id: "plasma_round",
							ammo_name: "Plasma Round",
							current_ammo: 10,
							magazine_size: 10,
						} as unknown as Record<string, never>,
					}),
				},
			]);

			const result = await endpoints.reload("weapon-1", "plasma_round");

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["id"]).toBe("weapon-1");
			expect(body["target"]).toBe("plasma_round");
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt_battle/reload");
			expect(result.structuredContent.weapon_id).toBe("weapon-1");
			expect(result.structuredContent.ammo_id).toBe("plasma_round");
		});
	});

	describe("bulk storage", () => {
		function bulkBody() {
			return makeV2Response({
				structuredContent: {
					action: "deposit",
					requested: 2,
					succeeded: 2,
					failed: 0,
					results: [
						{ item_id: "ore_iron", quantity: 20, success: true },
						{ item_id: "ore_copper", quantity: 10, success: true },
					],
				} as unknown as Record<string, never>,
			});
		}

		test("depositToStorageBulk sends items array to self storage", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: bulkBody() },
			]);

			const result = await endpoints.depositToStorageBulk([
				{ itemId: "ore_iron", quantity: 20 },
				{ itemId: "ore_copper", quantity: 10 },
			]);

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt_storage/deposit");
			expect(body["target"]).toBe("self");
			expect(body["items"]).toEqual([
				{ item_id: "ore_iron", quantity: 20 },
				{ item_id: "ore_copper", quantity: 10 },
			]);
			expect(body["item_id"]).toBeUndefined();
			expect(result.structuredContent.succeeded).toBe(2);
		});

		test("depositToStorageBulk forwards source when provided", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: bulkBody() },
			]);

			await endpoints.depositToStorageBulk([{ itemId: "ore_iron", quantity: 20 }], "faction");

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(body["source"]).toBe("faction");
		});

		test("depositToFactionStorageBulk targets faction storage", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: bulkBody() },
			]);

			await endpoints.depositToFactionStorageBulk([{ itemId: "ore_iron", quantity: 20 }]);

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt_storage/deposit");
			expect(body["target"]).toBe("faction");
			expect(body["items"]).toEqual([{ item_id: "ore_iron", quantity: 20 }]);
		});

		test("withdrawFromStorageBulk sends items array to self storage", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: bulkBody() },
			]);

			await endpoints.withdrawFromStorageBulk([
				{ itemId: "ore_iron", quantity: 20 },
				{ itemId: "ore_copper", quantity: 10 },
			]);

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt_storage/withdraw");
			expect(body["target"]).toBe("self");
			expect(body["items"]).toEqual([
				{ item_id: "ore_iron", quantity: 20 },
				{ item_id: "ore_copper", quantity: 10 },
			]);
		});

		test("withdrawFromFactionStorageBulk targets faction storage", async () => {
			const { endpoints, mockFetch } = await createConnectedEndpoints([
				{ status: 200, body: bulkBody() },
			]);

			await endpoints.withdrawFromFactionStorageBulk([{ itemId: "ore_iron", quantity: 20 }]);

			const body = JSON.parse(mockFetch.calls[2]?.init?.body as string) as Record<string, unknown>;
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt_storage/withdraw");
			expect(body["target"]).toBe("faction");
		});
	});
});
