import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { GiftToPlayer } from "../../../src/dispatcher/primitives/index.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

const DEFAULT_CARGO = [{ item_id: "ore", name: "Iron Ore", quantity: 10, size: 1 }];

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: {
			id: "s1",
			hull: 100,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
			cargo_capacity: 100,
			cargo_used: 10,
		},
		cargo: DEFAULT_CARGO,
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "sol_station",
			poi_name: "Sol Central",
			docked_at: "sol_base",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("GiftToPlayer", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new GiftToPlayer({ targetName: "FriendPlayer", itemId: "ore", quantity: 5 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("fails when item not in cargo", async () => {
		const state = makeState({ cargo: [] });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new GiftToPlayer({ targetName: "FriendPlayer", itemId: "ore", quantity: 5 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("ore");
	});

	test("succeeds when ctx.state is stale but getCargo shows cargo", async () => {
		const staleState = makeState({ cargo: [] }); // stale — no cargo

		let giftedQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore_crystal", item_name: "Ore Crystal", quantity: 450, size: 1 }],
				}),
			giftToPlayer: async (_target: unknown, _itemId: unknown, quantity: unknown) => {
				giftedQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state: staleState,
		};

		const goal = new GiftToPlayer({
			targetName: "AlliedPilot",
			itemId: "ore_crystal",
			quantity: 450,
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(giftedQuantity).toBe(450);
	});

	test("gifts items to target player", async () => {
		const state = makeState();

		let giftedTarget = "";
		let giftedItemId = "";
		let giftedQuantity = 0;
		let giftedMessage: string | undefined;
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: DEFAULT_CARGO }),
			giftToPlayer: async (
				targetName: unknown,
				itemId: unknown,
				quantity: unknown,
				message: unknown,
			) => {
				giftedTarget = targetName as string;
				giftedItemId = itemId as string;
				giftedQuantity = quantity as number;
				giftedMessage = message as string | undefined;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new GiftToPlayer({
			targetName: "FriendPlayer",
			itemId: "ore",
			quantity: 5,
			message: "Here you go!",
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(giftedTarget).toBe("FriendPlayer");
		expect(giftedItemId).toBe("ore");
		expect(giftedQuantity).toBe(5);
		expect(giftedMessage).toBe("Here you go!");
	});

	test("gifts credits to target player", async () => {
		const state = makeState(); // player has 1000 credits

		let giftedTarget = "";
		let giftedItemId = "";
		let giftedQuantity = 0;
		const endpoints = createMockEndpoints({
			getState: async () =>
				mockApiResponse({ player: { id: "p1", username: "Test", credits: 1000 } }),
			giftToPlayer: async (targetName: unknown, itemId: unknown, quantity: unknown) => {
				giftedTarget = targetName as string;
				giftedItemId = itemId as string;
				giftedQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new GiftToPlayer({ targetName: "FriendPlayer", itemId: "credits", quantity: 200 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(giftedTarget).toBe("FriendPlayer");
		expect(giftedItemId).toBe("credits");
		expect(giftedQuantity).toBe(200);
	});

	test("fails when insufficient credits", async () => {
		const state = makeState({ player: { id: "p1", username: "Test", credits: 50 } });
		const endpoints = createMockEndpoints({
			getState: async () =>
				mockApiResponse({ player: { id: "p1", username: "Test", credits: 50 } }),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new GiftToPlayer({ targetName: "FriendPlayer", itemId: "credits", quantity: 200 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("Insufficient credits");
	});

	test("caps gift quantity to available cargo quantity", async () => {
		// Cargo has 10 ore, want to gift 50 — should only gift 10
		const state = makeState();

		let giftedQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: DEFAULT_CARGO }),
			giftToPlayer: async (_target: unknown, _itemId: unknown, quantity: unknown) => {
				giftedQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new GiftToPlayer({
			targetName: "FriendPlayer",
			itemId: "ore",
			quantity: 50,
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(giftedQuantity).toBe(10);
	});
});
