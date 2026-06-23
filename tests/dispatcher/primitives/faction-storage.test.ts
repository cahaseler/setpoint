import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import {
	DepositToFactionStorage,
	LoadFromFactionStorage,
	WithdrawFromFactionStorage,
} from "../../../src/dispatcher/primitives/index.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

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
		cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
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

const factionStorageResponse = mockApiResponse({
	items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100 }],
});

describe("DepositToFactionStorage", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new DepositToFactionStorage({ itemId: "ore", quantity: 5 });
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

		const goal = new DepositToFactionStorage({ itemId: "ore", quantity: 5 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("ore");
	});

	test("succeeds when ctx.state is stale but getCargo shows cargo", async () => {
		const staleState = makeState({ cargo: [] });

		let depositedQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore_crystal", item_name: "Ore Crystal", quantity: 450, size: 1 }],
				}),
			depositToFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				depositedQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state: staleState,
		};

		const goal = new DepositToFactionStorage({ itemId: "ore_crystal", quantity: 450 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(depositedQuantity).toBe(450);
	});

	test("deposits requested quantity to faction storage", async () => {
		const state = makeState();

		let depositedItemId = "";
		let depositedQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown) => {
				depositedItemId = itemId as string;
				depositedQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new DepositToFactionStorage({ itemId: "ore", quantity: 5 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(depositedItemId).toBe("ore");
		expect(depositedQuantity).toBe(5);
	});

	test("caps deposit to available cargo quantity", async () => {
		// Cargo has 10 ore, want to deposit 50 — should only deposit 10
		const state = makeState();

		let depositedQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
				}),
			depositToFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				depositedQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new DepositToFactionStorage({ itemId: "ore", quantity: 50 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(depositedQuantity).toBe(10);
	});
});

describe("WithdrawFromFactionStorage", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new WithdrawFromFactionStorage({ itemId: "ore" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("fails when item not found in faction storage", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "gems", item_name: "Gems", quantity: 50 }],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new WithdrawFromFactionStorage({ itemId: "ore" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("ore");
	});

	test("withdraws item from faction storage into personal station storage", async () => {
		// Cargo is full — should not matter, items go to station storage
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 100,
			},
		});

		let depositedItemId = "";
		let depositedQuantity = 0;
		let depositedSource = "";
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () => factionStorageResponse,
			depositToStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				depositedItemId = itemId as string;
				depositedQuantity = quantity as number;
				depositedSource = source as string;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new WithdrawFromFactionStorage({ itemId: "ore" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		// Withdraws all available from faction storage (cargo state is irrelevant)
		expect(depositedItemId).toBe("ore");
		expect(depositedQuantity).toBe(100);
		expect(depositedSource).toBe("faction");
	});

	test("respects optional quantity limit", async () => {
		const state = makeState();

		let depositedQuantity = 0;
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () => factionStorageResponse,
			depositToStorage: async (_itemId: unknown, quantity: unknown) => {
				depositedQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		// Storage has 100, quantity requested is 20 — should deposit 20 to station storage
		const goal = new WithdrawFromFactionStorage({ itemId: "ore", quantity: 20 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(depositedQuantity).toBe(20);
	});

	test("withdraws credits to station storage", async () => {
		const state = makeState();

		let depositedItemId = "";
		let depositedQuantity = 0;
		let depositedSource = "";
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 5000,
				}),
			depositToStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				depositedItemId = itemId as string;
				depositedQuantity = quantity as number;
				depositedSource = source as string;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new WithdrawFromFactionStorage({ itemId: "credits", quantity: 2000 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(depositedItemId).toBe("credits");
		expect(depositedQuantity).toBe(2000);
		expect(depositedSource).toBe("faction");
	});

	test("fails when no credits in faction storage", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 0,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new WithdrawFromFactionStorage({ itemId: "credits" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("credits");
	});
});

describe("LoadFromFactionStorage", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromFactionStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("returns already satisfied when cargo has enough of the item", async () => {
		// Cargo has 10 ore, maxQuantity is 10
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
					ship: state.ship,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromFactionStorage("ore", 10);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("fails when cargo info is unknown", async () => {
		const state = makeState({ ship: undefined });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromFactionStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("ship cargo info unknown");
	});

	test("returns alreadySatisfied when cargo is full (computed from live items)", async () => {
		// Cargo has 100 items of size 1 filling the 100-unit hold
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromFactionStorage("gems");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("full");
	});

	test("uses live cargo items to compute cargo used (ignores stale ship state)", async () => {
		// State has stale cargo_used: 450, but live cargo is empty
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 450, // stale — cargo was already deposited
			},
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: [] }), // live cargo is empty
			viewFactionStorage: async () => factionStorageResponse,
			withdrawFromFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		// Should succeed: live cargo is empty, so cargoUsed = 0, freeSpace = 100
		const goal = new LoadFromFactionStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(withdrawnQuantity).toBe(100); // all 100 from faction storage
	});

	test("returns alreadySatisfied when item not in faction storage", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
					ship: state.ship,
				}),
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "gems", item_name: "Gems", quantity: 50 }],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromFactionStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("ore");
	});

	test("withdraws up to maxQuantity minus current cargo quantity", async () => {
		// Cargo has 10 ore, maxQuantity is 40 — should withdraw 30
		const ship = {
			id: "s1",
			hull: 100,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
			cargo_capacity: 100,
			cargo_used: 10,
		};
		const state = makeState({ ship });

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
					ship,
				}),
			viewFactionStorage: async () => factionStorageResponse,
			withdrawFromFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromFactionStorage("ore", 40);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(withdrawnQuantity).toBe(30);
	});

	test("respects item size when computing how many fit", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
			cargo: [],
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: [] }),
			viewFactionStorage: async () =>
				mockApiResponse({
					// Item size 5 — only 20 fit in a 100-unit hold
					items: [{ item_id: "heavy_ore", item_name: "Heavy Ore", quantity: 200, size: 5 }],
				}),
			withdrawFromFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromFactionStorage("heavy_ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// 100 capacity / size 5 = 20 items max
		expect(withdrawnQuantity).toBe(20);
	});

	test("respects cargo free space limit", async () => {
		const ship = {
			id: "s1",
			hull: 100,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
			cargo_capacity: 100,
			cargo_used: 85,
		};
		const state = makeState({ ship, cargo: [] });

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			// Live cargo has 85 items of size 1, leaving 15 free slots
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "gems", item_name: "Gems", quantity: 85, size: 1 }],
				}),
			viewFactionStorage: async () => factionStorageResponse,
			withdrawFromFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		// Free space is 15, storage has 100, no maxQuantity — withdraw 15
		const goal = new LoadFromFactionStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(withdrawnQuantity).toBe(15);
	});
});
